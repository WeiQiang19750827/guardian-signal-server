const express = require('express');
const http = require('http');
const { ExpressPeerServer } = require('peer');
const os = require('os');
const fs = require('fs');

const PORT = process.env.PORT || 8443;
const VERSION = '1.105';
const ROOM_CLEANUP_INTERVAL = 15000;
const ROOM_INACTIVE_TIMEOUT = 10 * 60 * 1000;
const PEERJS_ALIVE_TIMEOUT = 300000;
const PEERJS_EXPIRE_TIMEOUT = 30000;
const IP_REPORT_INTERVAL = 120000;

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
    serverConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
} catch (err) {
}

function createLogger(prefix) {
  return {
    info: (msg, data) => console.log(`[${prefix}] I ${msg}`, data || ''),
    ok: (msg, data) => console.log(`[${prefix}] OK ${msg}`, data || ''),
    warn: (msg, data) => console.warn(`[${prefix}] W ${msg}`, data || ''),
    err: (msg, data) => console.error(`[${prefix}] E ${msg}`, data || '')
  };
}

const log = createLogger('PEERJS');
const relayLog = createLogger('RELAY');

const app = express();
const server = http.createServer(app);

app.use(express.json());

function corsMiddleware(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
}
app.use(corsMiddleware);

const peerServer = ExpressPeerServer(server, {
  debug: false,
  path: '/',
  allow_discovery: true,
  alive_timeout: PEERJS_ALIVE_TIMEOUT,
  expire_timeout: PEERJS_EXPIRE_TIMEOUT,
});

app.use('/peerjs', peerServer);

const rooms = new Map();
const peerRoomMap = new Map();
let startTime = Date.now();
let publicIP = '';

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
        } else {
          tryService(idx + 1);
        }
      });
    });
    req.on('error', () => tryService(idx + 1));
    req.setTimeout(5000, () => { req.destroy(); tryService(idx + 1); });
  }
  tryService(0);
}

detectPublicIP();
setInterval(detectPublicIP, IP_REPORT_INTERVAL);

function generateRoomId() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function turnCredentials() {
  const h = String(Math.floor(Math.random() * 90000 + 10000));
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  return {
    username: 'guardian_' + h,
    credential: 'guardian_p2p_2026',
    urls: [
      'turn:' + (publicIP || getLocalIP()) + ':3478?transport=tcp',
      'turn:' + (publicIP || getLocalIP()) + ':3478?transport=udp'
    ],
    ttl: 86400
  };
}

peerServer.on('connection', (client) => {
  const peerId = client.getId();
  log.ok('peer connected: ' + peerId);
});

peerServer.on('disconnect', (client) => {
  const peerId = client.getId();
  log.ok('peer disconnected: ' + peerId);
  const roomId = peerRoomMap.get(peerId);
  if (roomId && rooms.has(roomId)) {
    const room = rooms.get(roomId);
    room.peers.delete(peerId);
    peerRoomMap.delete(peerId);
    log.warn('[room ' + roomId + '] peer ' + peerId + ' left, ' + room.peers.size + ' remaining');
    if (room.peers.size === 0) {
      rooms.delete(roomId);
      log.ok('room ' + roomId + ' closed (empty)');
    }
  }
});

app.get('/health', (req, res) => {
  const localIP = getLocalIP();
  let activeRooms = 0;
  let totalPeers = 0;
  for (const room of rooms.values()) {
    if (room.peers.size > 0) activeRooms++;
    totalPeers += room.peers.size;
  }
  res.json({
    status: 'ok',
    version: VERSION,
    ip: publicIP || localIP,
    localIP: localIP,
    publicIP: publicIP || null,
    signalPort: PORT,
    turn: turnCredentials(),
    relay: {
      available: true,
      endpoint: '/relay',
      protocol: 'wss',
      mode: 'always_available'
    },
    rooms: {
      active: activeRooms,
      total: rooms.size,
      peerCount: totalPeers
    },
    uptime: Date.now() - startTime,
    heartbeatInterval: 10000,
    roomInactiveTimeout: ROOM_INACTIVE_TIMEOUT
  });
});

app.get('/rooms', (req, res) => {
  const roomList = [];
  for (const [id, room] of rooms) {
    roomList.push({
      id: id,
      createdAt: room.createdAt,
      lastActivity: room.lastActivity,
      age: Date.now() - room.createdAt,
      idle: Date.now() - room.lastActivity,
      peerCount: room.peers.size,
      peerIds: Array.from(room.peers)
    });
  }
  res.json({ status: 'ok', count: roomList.length, rooms: roomList });
});

app.get('/network', (req, res) => {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, address: iface.address, netmask: iface.netmask, mac: iface.mac });
      }
    }
  }
  res.json({ status: 'ok', ips, count: ips.length });
});

app.post('/rooms', (req, res) => {
  const roomId = generateRoomId();
  rooms.set(roomId, {
    id: roomId,
    peers: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now()
  });
  log.ok('room created: ' + roomId);
  res.json({ status: 'ok', roomId, version: VERSION });
});

app.post('/rooms/:roomId/join', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: 'room not found' });
  }
  const { peerId } = req.body;
  if (!peerId) {
    return res.status(400).json({ error: 'peerId required' });
  }
  room.peers.add(peerId);
  peerRoomMap.set(peerId, room.id);
  room.lastActivity = Date.now();
  log.ok('[room ' + room.id + '] peer ' + peerId + ' joined (' + room.peers.size + ' peers)');
  res.json({ status: 'ok', roomId: room.id, peerCount: room.peers.size });
});

app.post('/rooms/:roomId/leave', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) {
    return res.status(404).json({ error: 'room not found' });
  }
  const { peerId } = req.body;
  if (peerId) {
    room.peers.delete(peerId);
    peerRoomMap.delete(peerId);
    log.warn('[room ' + room.id + '] peer ' + peerId + ' left via API');
  }
  if (room.peers.size === 0) {
    rooms.delete(req.params.roomId);
    log.ok('room ' + req.params.roomId + ' closed (empty)');
  }
  res.json({ status: 'ok' });
});

const PAIR_TTL = 300000;

const pairs = new Map();

app.post('/pair', (req, res) => {
  const code = generateRoomId();
  pairs.set(code, {
    code: code,
    createdBy: null,
    joinedBy: null,
    createdAt: Date.now()
  });
  log.ok('pair created: ' + code);
  res.json({ status: 'ok', code: code, expiresIn: PAIR_TTL / 1000, role: 'guardian' });
});

app.post('/pair/:code/join', (req, res) => {
  const pair = pairs.get(req.params.code);
  if (!pair) {
    return res.status(404).json({ error: 'pair code not found or expired' });
  }
  if (pair.joinedBy) {
    return res.status(400).json({ error: 'pair already joined' });
  }
  pair.joinedBy = true;
  log.ok('pair joined: ' + req.params.code);
  res.json({ status: 'ok', code: req.params.code, role: 'protected', roomId: req.params.code });
});

app.get('/pair/:code/status', (req, res) => {
  const pair = pairs.get(req.params.code);
  if (!pair) {
    return res.status(404).json({ error: 'pair code not found or expired' });
  }
  res.json({
    status: 'ok',
    code: req.params.code,
    ready: !!pair.joinedBy,
    joinedBy: !!pair.joinedBy
  });
});

function cleanupExpiredPairs() {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, pair] of pairs) {
    if (!pair.joinedBy && (now - pair.createdAt) > PAIR_TTL) {
      pairs.delete(code);
      cleaned++;
    }
  }
  if (cleaned > 0) log.ok('cleaned ' + cleaned + ' expired pairs');
}

setInterval(cleanupExpiredPairs, 30000);

function cleanupExpiredRooms() {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, room] of rooms) {
    const idle = now - room.lastActivity;
    if (room.peers.size === 0 || idle > ROOM_INACTIVE_TIMEOUT) {
      for (const peerId of room.peers) {
        peerRoomMap.delete(peerId);
      }
      rooms.delete(id);
      cleaned++;
      log.warn('cleaned room ' + id + ' (idle ' + (idle / 1000).toFixed(0) + 's, peers: ' + room.peers.size + ')');
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
  rooms.clear();
  peerRoomMap.clear();
  server.close(() => {
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
  log.ok('  Guardian Signaling Server v' + VERSION);
  log.ok('  PeerJS: /peerjs  HTTP Pairing');
  log.ok('  HTTP on 0.0.0.0:' + PORT);
  log.ok('  local IP: ' + (getLocalIP() || 'unknown'));
  log.ok('  /health  /rooms  /network  /pair/:code/status');
  log.ok('========================================');
});