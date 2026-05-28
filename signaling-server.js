const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT || 8443;
const ROOM_CLEANUP_INTERVAL = 15000;
const ROOM_INACTIVE_TIMEOUT = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL = 10000;
const HEARTBEAT_TIMEOUT = 30000;
const CONNECTION_TIMEOUT = 60000;

const CONN_STATE = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  CLOSING: 'closing'
};

let serverConfig = {
  ipReport: {
    enabled: false,
    method: 'jsonbin',
    jsonbin: { apiKey: '', binId: '' },
    gist: { githubToken: '', gistId: '' },
    interval: 60000
  }
};

try {
  const configPath = './server-config.json';
  if (fs.existsSync(configPath)) {
    const configData = fs.readFileSync(configPath, 'utf8');
    serverConfig = JSON.parse(configData);
  }
} catch (err) {
  console.log('load config failed:', err.message);
}

const rooms = new Map();

function generateRoomId() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function createLogger(prefix) {
    return {
        info: (msg, data) => console.log('[' + prefix + '] I ' + msg, data || ''),
        ok: (msg, data) => console.log('[' + prefix + '] OK ' + msg, data || ''),
        warn: (msg, data) => console.warn('[' + prefix + '] W ' + msg, data || ''),
        err: (msg, data) => console.error('[' + prefix + '] E ' + msg, data || '')
    };
}

const log = createLogger('SIGNAL');

class ConnectionHeartbeat {
  constructor(ws, onDead) {
    this.ws = ws;
    this.onDead = onDead;
    this.lastPong = Date.now();
    this.checkInterval = setInterval(() => this._check(), HEARTBEAT_INTERVAL);
    this._alive = true;
    ws.on('pong', () => { this.lastPong = Date.now(); this._alive = true; });
  }

  markPong() {
    this.lastPong = Date.now();
    this._alive = true;
  }

  _check() {
    if (!this._alive || !this.ws._connected) {
      this.destroy();
      this.onDead(this.ws);
      return;
    }
    this._alive = false;
    try { this.ws.ping(); } catch (e) { this.destroy(); this.onDead(this.ws); }
  }

  destroy() {
    clearInterval(this.checkInterval);
    this.checkInterval = null;
  }
}

class PeerConnection {
  constructor(ws, role, roomId) {
    this.id = crypto.randomUUID().slice(0, 8);
    this.ws = ws;
    this.role = role;
    this.roomId = roomId;
    this.state = CONN_STATE.CONNECTED;
    this.connectedAt = Date.now();
    this.lastActivity = Date.now();
    this.messageCount = 0;
    this.errorCount = 0;
    this._closed = false;
  }

  markActivity() {
    this.lastActivity = Date.now();
    this.messageCount++;
  }

  markError() {
    this.errorCount++;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this.state = CONN_STATE.DISCONNECTED;
    try { this.ws.close(); } catch (e) {}
  }

  isHealthy() {
    return !this._closed && this.ws.readyState === 1;
  }

  get info() {
    return {
      id: this.id,
      role: this.role,
      state: this.state,
      connectedAt: this.connectedAt,
      lastActivity: this.lastActivity,
      messageCount: this.messageCount,
      errorCount: this.errorCount
    };
  }
}

class Room {
    constructor(id) {
        this.id = id;
        this.host = null;
        this.client = null;
        this.hostPeer = null;
        this.clientPeer = null;
        this.lastActivity = Date.now();
        this.createdAt = Date.now();
        this.iceCandidates = { host: [], client: [] };
        log.ok('room created: ' + id);
    }

    addPeer(ws, role) {
      this.lastActivity = Date.now();
      const peer = new PeerConnection(ws, role, this.id);

      if (role === 'host') {
        if (this.hostPeer && this.hostPeer.isHealthy()) {
          log.warn('room ' + this.id + ' active host(' + this.hostPeer.id + '), reject');
          return false;
        }
        this._cleanupPeer('host');
        this.host = ws;
        this.hostPeer = peer;
        this.host._peerId = peer.id;
      } else {
        if (this.clientPeer && this.clientPeer.isHealthy()) {
          log.warn('room ' + this.id + ' active client(' + this.clientPeer.id + '), reject');
          return false;
        }
        this._cleanupPeer('client');
        this.client = ws;
        this.clientPeer = peer;
        this.client._peerId = peer.id;
      }

      ws._roomId = this.id;
      ws._role = role;
      ws._connected = true;

      log.ok('[room ' + this.id + '] ' + role + ' join (peerId: ' + peer.id + ')');
      this.broadcast({ type: 'peer_joined', role, peerId: peer.id });
      const other = role === 'host' ? this.clientPeer : this.hostPeer;
      if (other) {
        ws.send(JSON.stringify({ type: 'peer_joined', role: other.role, peerId: other.id }));
      }
      return true;
    }

    _cleanupPeer(role) {
      if (role === 'host') {
        if (this.hostPeer) this.hostPeer.close();
        this.host = null;
        this.hostPeer = null;
      } else {
        if (this.clientPeer) this.clientPeer.close();
        this.client = null;
        this.clientPeer = null;
      }
    }

    removePeer(ws) {
        this.lastActivity = Date.now();
        const role = ws._role;
        const peerId = ws._peerId;

        if (role === 'host' && this.hostPeer && this.hostPeer.id === peerId) {
          this.hostPeer.close();
          this.host = null;
          this.hostPeer = null;
        } else if (role === 'client' && this.clientPeer && this.clientPeer.id === peerId) {
          this.clientPeer.close();
          this.client = null;
          this.clientPeer = null;
        } else {
          return !this.host && !this.client;
        }

        log.warn('[room ' + this.id + '] ' + role + '(' + peerId + ') leave');

        const remaining = this.otherPeer(ws);
        if (remaining) {
            remaining.send(JSON.stringify({ type: 'peer_left', role, peerId }));
        }
        return !this.host && !this.client;
    }

    otherPeer(ws) {
        if (ws._role === 'host') return this.client && this.client.readyState === 1 ? this.client : null;
        return this.host && this.host.readyState === 1 ? this.host : null;
    }

    getOtherPeer(role) {
      if (role === 'host') return this.clientPeer;
      return this.hostPeer;
    }

    broadcast(message) {
        const msg = JSON.stringify(message);
        if (this.host && this.host.readyState === 1) this.host.send(msg);
        if (this.client && this.client.readyState === 1) this.client.send(msg);
    }

    relay(from, message) {
        this.lastActivity = Date.now();
        const target = this.otherPeer(from);
        if (target && target.readyState === 1) {
            target.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    markActivity() {
      this.lastActivity = Date.now();
    }

    isExpired() {
        return Date.now() - this.lastActivity > ROOM_INACTIVE_TIMEOUT;
    }

    getPeerCount() {
        let count = 0;
        if (this.host && this.host.readyState === 1 && this.hostPeer && this.hostPeer.isHealthy()) count++;
        if (this.client && this.client.readyState === 1 && this.clientPeer && this.clientPeer.isHealthy()) count++;
        return count;
    }

    get status() {
      return {
        id: this.id,
        created: this.createdAt,
        lastActivity: this.lastActivity,
        age: Date.now() - this.createdAt,
        idle: Date.now() - this.lastActivity,
        peers: [this.hostPeer?.info, this.clientPeer?.info].filter(Boolean),
        candidateCount: this.iceCandidates.host.length + this.iceCandidates.client.length
      };
    }
}

let startTime = Date.now();
let publicIP = '';

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function detectPublicIP() {
  const services = ['http://api.ipify.org', 'http://ifconfig.me/ip', 'http://icanhazip.com'];
  function tryService(idx) {
    if (idx >= services.length) return;
    const req = http.get(services[idx], (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const ip = data.trim();
        if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          publicIP = ip;
          log.ok('public IP: ' + ip);
        } else { tryService(idx + 1); }
      });
    });
    req.on('error', () => tryService(idx + 1));
    req.setTimeout(5000, () => { req.destroy(); tryService(idx + 1); });
  }
  tryService(0);
}

detectPublicIP();
setInterval(detectPublicIP, 120000);

const server = http.createServer((req, res) => {
    const sendJson = (data, status) => {
      if (!status) status = 200;
      const body = JSON.stringify(data);
      res.writeHead(status, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end(body);
    };

    if (req.url === '/health') {
        const localIP = getLocalIP();
        const roomStats = { active: 0, total: 0, peerCount: 0 };
        for (const room of rooms.values()) {
          roomStats.total++;
          const pc = room.getPeerCount();
          if (pc > 0) roomStats.active++;
          roomStats.peerCount += pc;
        }
        sendJson({
            status: 'ok',
            version: '1.93',
            ip: publicIP || localIP,
            localIP: localIP,
            publicIP: publicIP || null,
            signalPort: PORT,
            turn: {
                available: true,
                port: 3478,
                protocols: ['udp', 'tcp'],
                username: 'guardian',
                credential: 'guardian_p2p_2026',
                realm: 'guardian.app'
            },
            rooms: roomStats,
            uptime: Date.now() - startTime,
            heartbeatInterval: HEARTBEAT_INTERVAL,
            roomInactiveTimeout: ROOM_INACTIVE_TIMEOUT
        });
        return;
    }
    if (req.url === '/rooms') {
        const roomList = [];
        for (const [id, room] of rooms) {
          roomList.push(room.status);
        }
        sendJson({ status: 'ok', count: roomList.length, rooms: roomList });
        return;
    }
    if (req.url === '/network') {
        const interfaces = os.networkInterfaces();
        const ips = [];
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    ips.push({ name, address: iface.address, netmask: iface.netmask, mac: iface.mac });
                }
            }
        }
        sendJson({ status: 'ok', ips, count: ips.length });
        return;
    }
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Guardian Signaling Server v1.93\n/health\n/rooms\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const params = url.parse(req.url, true).query;
    const roomId = params.room;
    const role = params.role || 'client';
    const clientIp = req.socket.remoteAddress;

    log.info('new conn: ' + clientIp + ' room=' + roomId + ' role=' + role);

    if (!roomId || !/^\d{6}$/.test(roomId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'invalid room id' }));
        ws.close();
        return;
    }

    let room = rooms.get(roomId);
    if (!room) {
        room = new Room(roomId);
        rooms.set(roomId, room);
    }

    ws._connected = true;

    if (!room.addPeer(ws, role)) {
        ws.send(JSON.stringify({ type: 'error', message: 'room full or role conflict' }));
        ws.close();
        return;
    }

    ws.send(JSON.stringify({ type: 'room_joined', roomId, role }));

    if (room.host && room.client) {
        log.ok('[room ' + roomId + '] both ready, start P2P');
        room.broadcast({ type: 'ready', roomId });
    }

    const heartbeat = new ConnectionHeartbeat(ws, (deadWs) => {
      const deadRoom = rooms.get(deadWs._roomId);
      if (deadRoom) {
        const peer = deadWs._role === 'host' ? deadRoom.hostPeer : deadRoom.clientPeer;
        if (peer) peer.markError();
        log.warn('[room ' + deadWs._roomId + '] heartbeat timeout, close ' + deadWs._role + '(' + deadWs._peerId + ')');
        const empty = deadRoom.removePeer(deadWs);
        if (empty) {
            rooms.delete(deadWs._roomId);
            log.ok('room ' + deadWs._roomId + ' closed (heartbeat)');
        }
      }
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            const currentRoom = rooms.get(ws._roomId);
            if (!currentRoom) return;
            const peer = ws._role === 'host' ? currentRoom.hostPeer : currentRoom.clientPeer;
            if (peer) peer.markActivity();
            currentRoom.markActivity();
            handleMessage(ws, currentRoom, msg, heartbeat);
        } catch (e) {
            log.err('message parse failed: ' + e.message);
            const currentRoom = rooms.get(ws._roomId);
            if (currentRoom) {
              const peer = ws._role === 'host' ? currentRoom.hostPeer : currentRoom.clientPeer;
              if (peer) peer.markError();
            }
        }
    });

    ws.on('close', () => {
        ws._connected = false;
        heartbeat.destroy();
        const currentRoom = rooms.get(ws._roomId);
        if (currentRoom) {
            const empty = currentRoom.removePeer(ws);
            if (empty) {
                rooms.delete(ws._roomId);
                log.ok('room ' + ws._roomId + ' closed (empty)');
            }
        }
    });

    ws.on('error', (err) => {
        log.err('[room ' + ws._roomId + '] WS error: ' + err.message);
        ws._connected = false;
        heartbeat.destroy();
        const currentRoom = rooms.get(ws._roomId);
        if (currentRoom) {
            const peer = ws._role === 'host' ? currentRoom.hostPeer : currentRoom.clientPeer;
            if (peer) peer.markError();
            const empty = currentRoom.removePeer(ws);
            if (empty) {
                rooms.delete(ws._roomId);
            }
        }
    });
});

function handleMessage(ws, room, msg, heartbeat) {
    switch (msg.type) {
        case 'offer':
            log.ok('[room ' + room.id + '] relay offer (sdp len: ' + (msg.sdp?.length || 0) + ')');
            room.relay(ws, { type: 'offer', sdp: msg.sdp, trickle: true });
            break;

        case 'answer':
            log.ok('[room ' + room.id + '] relay answer');
            room.relay(ws, { type: 'answer', sdp: msg.sdp });
            break;

        case 'ice_candidate':
            if (msg.candidate) {
                room.relay(ws, { type: 'ice_candidate', candidate: msg.candidate });
            }
            break;

        case 'ping':
            if (heartbeat) heartbeat.markPong();
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;

        case 'pong':
            if (heartbeat) heartbeat.markPong();
            break;

        case 'offer_request':
            log.ok('[room ' + room.id + '] ' + ws._role + ' request re-offer');
            room.relay(ws, { type: 'offer_request' });
            break;

        case 'connection_ready':
            log.ok('[room ' + room.id + '] ' + ws._role + ' P2P ready');
            break;

        default:
            room.relay(ws, msg);
    }
}

function cleanupExpiredRooms() {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, room] of rooms) {
        if (room.isExpired() || room.getPeerCount() === 0) {
            log.warn('clean expired room ' + id + ' (idle ' + ((now - room.lastActivity)/1000).toFixed(0) + 's)');
            if (room.hostPeer) room.hostPeer.close();
            if (room.clientPeer) room.clientPeer.close();
            rooms.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        log.ok('cleaned ' + cleaned + ' expired rooms');
    }
}

setInterval(cleanupExpiredRooms, ROOM_CLEANUP_INTERVAL);

function gracefulShutdown(signal) {
    log.warn('received ' + signal + ', graceful shutdown...');
    log.info('closing ' + rooms.size + ' rooms...');
    for (const [id, room] of rooms) {
        room.broadcast({ type: 'server_shutdown', reason: signal, reconnectIn: 5000 });
        if (room.hostPeer) room.hostPeer.close();
        if (room.clientPeer) room.clientPeer.close();
    }
    rooms.clear();
    wss.close(() => {
        log.ok('all connections closed, server stopped');
        process.exit(0);
    });
    setTimeout(() => {
        log.warn('force exit');
        process.exit(0);
    }, 3000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
    log.ok('========================================');
    log.ok('  Guardian Signaling Server v1.93');
    log.ok('  ws://0.0.0.0:' + PORT);
    log.ok('  local IP: ' + (getLocalIP() || 'unknown'));
    log.ok('  heartbeat: ' + (HEARTBEAT_INTERVAL/1000) + 's interval, ' + (HEARTBEAT_TIMEOUT/1000) + 's timeout');
    log.ok('  room idle timeout: ' + (ROOM_INACTIVE_TIMEOUT/1000) + 's');
    log.ok('========================================');
});

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}