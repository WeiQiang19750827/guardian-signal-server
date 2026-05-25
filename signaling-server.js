const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT || 8443;
const ROOM_CLEANUP_INTERVAL = 30000;
const ROOM_MAX_AGE = 10 * 60 * 1000;

let serverConfig = {
  ipReport: {
    enabled: false,
    method: 'jsonbin',
    jsonbin: { apiKey: '', binId: '' },
    gist: { githubToken: '', gistId: '' },
    interval: 60000
  }
};

// 加载配置文件
try {
  const configPath = './server-config.json';
  if (fs.existsSync(configPath)) {
    const configData = fs.readFileSync(configPath, 'utf8');
    serverConfig = JSON.parse(configData);
  }
} catch (err) {
  console.log('加载配置文件失败，使用默认配置:', err.message);
}

const rooms = new Map();

function generateRoomId() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function createLogger(prefix) {
    return {
        info: (msg, data) => console.log(`[${prefix}] ℹ️ ${msg}`, data || ''),
        ok: (msg, data) => console.log(`[${prefix}] ✅ ${msg}`, data || ''),
        warn: (msg, data) => console.warn(`[${prefix}] ⚠️ ${msg}`, data || ''),
        err: (msg, data) => console.error(`[${prefix}] ❌ ${msg}`, data || '')
    };
}

const log = createLogger('SIGNAL');

class Room {
    constructor(id) {
        this.id = id;
        this.host = null;
        this.client = null;
        this.createdAt = Date.now();
        this.iceCandidates = { host: [], client: [] };
        log.ok(`房间 ${id} 已创建`);
    }

    addPeer(ws, role) {
        if (role === 'host') {
            if (this.host) {
                log.warn(`房间 ${this.id} 已有主机，拒绝新主机`);
                return false;
            }
            this.host = ws;
            this.host._role = 'host';
        } else {
            if (this.client) {
                log.warn(`房间 ${this.id} 已有客户端，拒绝新客户端`);
                return false;
            }
            this.client = ws;
            this.client._role = 'client';
        }
        ws._roomId = this.id;
        ws._role = role;

        log.ok(`[房间 ${this.id}] ${role} 加入`);
        this.broadcast({ type: 'peer_joined', role });
        return true;
    }

    removePeer(ws) {
        const role = ws._role;
        if (role === 'host') this.host = null;
        else this.client = null;
        log.warn(`[房间 ${this.id}] ${role} 离开`);

        const remaining = this.otherPeer(ws);
        if (remaining) {
            remaining.send(JSON.stringify({ type: 'peer_left', role }));
        }
        return !this.host && !this.client;
    }

    otherPeer(ws) {
        return ws._role === 'host' ? this.client : this.host;
    }

    broadcast(message) {
        const msg = JSON.stringify(message);
        if (this.host && this.host.readyState === 1) this.host.send(msg);
        if (this.client && this.client.readyState === 1) this.client.send(msg);
    }

    relay(from, message) {
        const target = this.otherPeer(from);
        if (target && target.readyState === 1) {
            target.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    isExpired() {
        return Date.now() - this.createdAt > ROOM_MAX_AGE;
    }

    getPeerCount() {
        let count = 0;
        if (this.host && this.host.readyState === 1) count++;
        if (this.client && this.client.readyState === 1) count++;
        return count;
    }
}

let startTime = Date.now();
let publicIP = '';

// 获取本地IP地址
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

// IP上报函数
async function reportIP() {
  if (!serverConfig.ipReport.enabled) return;
  
  const localIPs = getLocalIPs();
  const localIP = localIPs.length > 0 ? localIPs[0] : '127.0.0.1';
  
  const reportData = {
    timestamp: Date.now(),
    status: 'ok',
    ip: publicIP || '',
    publicIP: publicIP || '',
    localIP: localIP,
    signalPort: PORT,
    turnPort: 3478
  };
  
  try {
    if (serverConfig.ipReport.method === 'jsonbin') {
      await reportToJsonBin(reportData);
    } else if (serverConfig.ipReport.method === 'gist') {
      await reportToGist(reportData);
    } else if (serverConfig.ipReport.method === 'gitee') {
      await reportToGitee(reportData);
    }
  } catch (err) {
    log.warn('IP上报失败:', err.message);
  }
}

// 上报到 JSONBin
function reportToJsonBin(data) {
  return new Promise((resolve, reject) => {
    const config = serverConfig.ipReport.jsonbin;
    if (!config.apiKey || !config.binId) {
      reject(new Error('JSONBin 配置不完整'));
      return;
    }
    
    const postData = JSON.stringify(data);
    const options = {
      hostname: 'api.jsonbin.io',
      port: 443,
      path: '/v3/b/' + config.binId,
      method: 'PUT',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': config.apiKey,
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log.ok('IP已成功上报到 JSONBin');
          resolve();
        } else {
          reject(new Error('HTTP ' + res.statusCode + ': ' + body));
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// 上报到 GitHub Gist
function reportToGist(data) {
  return new Promise((resolve, reject) => {
    const config = serverConfig.ipReport.gist;
    if (!config.githubToken || !config.gistId) {
      reject(new Error('GitHub Gist 配置不完整'));
      return;
    }
    
    const postData = JSON.stringify({
      files: {
        'guardian-server-info.json': {
          content: JSON.stringify(data, null, 2)
        }
      }
    });
    
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: '/gists/' + config.gistId,
      method: 'PATCH',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'token ' + config.githubToken,
        'User-Agent': 'Guardian-Server',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log.ok('IP已成功上报到 GitHub Gist');
          resolve();
        } else {
          reject(new Error('HTTP ' + res.statusCode + ': ' + body));
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// 上报到 Gitee（国内访问更快！）
function reportToGitee(data) {
  return new Promise((resolve, reject) => {
    const config = serverConfig.ipReport.gitee;
    if (!config.accessToken || !config.gistId) {
      reject(new Error('Gitee 配置不完整'));
      return;
    }
    
    const postData = JSON.stringify({
      files: {
        'guardian-server-info.json': {
          content: JSON.stringify(data, null, 2)
        }
      }
    });
    
    const options = {
      hostname: 'gitee.com',
      port: 443,
      path: '/api/v5/gists/' + config.gistId,
      method: 'PATCH',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'token ' + config.accessToken,
        'User-Agent': 'Guardian-Server',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log.ok('IP已成功上报到 Gitee');
          resolve();
        } else {
          reject(new Error('HTTP ' + res.statusCode + ': ' + body));
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
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
          log.ok('公网IP已检测: ' + ip);
          reportIP(); // 检测成功后立即上报
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

// 设置定期上报
if (serverConfig.ipReport.enabled && serverConfig.ipReport.interval > 0) {
  setInterval(reportIP, serverConfig.ipReport.interval);
}

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        const localIP = getLocalIP();
        const health = {
            status: 'ok',
            version: '1.62',
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
            rooms: rooms.size,
            uptime: Date.now() - startTime
        };
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end(JSON.stringify(health));
        return;
    }
    if (req.url === '/network') {
        const os = require('os');
        const interfaces = os.networkInterfaces();
        const ips = [];
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    ips.push({ name, address: iface.address, netmask: iface.netmask, mac: iface.mac });
                }
            }
        }
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end(JSON.stringify({ status: 'ok', ips, count: ips.length }));
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
    res.end('Guardian Signaling Server v1.62\n访问 /health 获取服务器状态\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const params = url.parse(req.url, true).query;
    const roomId = params.room;
    const role = params.role || 'client';
    const clientIp = req.socket.remoteAddress;

    log.info(`新连接: ${clientIp} -> room=${roomId}, role=${role}`);

    if (!roomId || !/^\d{6}$/.test(roomId)) {
        ws.send(JSON.stringify({ type: 'error', message: '无效的房间ID，需要6位数字' }));
        ws.close();
        return;
    }

    let room = rooms.get(roomId);
    if (!room) {
        room = new Room(roomId);
        rooms.set(roomId, room);
    }

    if (!room.addPeer(ws, role)) {
        ws.send(JSON.stringify({ type: 'error', message: '房间已满或角色冲突' }));
        ws.close();
        return;
    }

    ws.send(JSON.stringify({ type: 'room_joined', roomId, role }));

    if (room.host && room.client) {
        log.ok(`[房间 ${roomId}] 双方已就绪，开始建立P2P连接`);
        room.broadcast({ type: 'ready', roomId });
    }

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleMessage(ws, room, msg);
        } catch (e) {
            log.err(`消息解析失败: ${e.message}`);
        }
    });

    ws.on('close', () => {
        const empty = room.removePeer(ws);
        if (empty) {
            rooms.delete(roomId);
            log.ok(`房间 ${roomId} 已关闭（空）`);
        }
    });

    ws.on('error', (err) => {
        log.err(`[房间 ${roomId}] WebSocket错误: ${err.message}`);
        const empty = room.removePeer(ws);
        if (empty) {
            rooms.delete(roomId);
        }
    });
});

function handleMessage(ws, room, msg) {
    switch (msg.type) {
        case 'offer':
            log.ok(`[房间 ${room.id}] 转发 offer (SDP长度: ${msg.sdp?.length || 0})`);
            room.relay(ws, { type: 'offer', sdp: msg.sdp, trickle: true });
            break;

        case 'answer':
            log.ok(`[房间 ${room.id}] 转发 answer`);
            room.relay(ws, { type: 'answer', sdp: msg.sdp });
            break;

        case 'ice_candidate':
            if (msg.candidate) {
                room.relay(ws, { type: 'ice_candidate', candidate: msg.candidate });
            }
            break;

        case 'ping':
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;

        case 'offer_request':
            log.ok(`[房间 ${room.id}] ${ws._role} 请求重新生成offer`);
            room.relay(ws, { type: 'offer_request' });
            break;

        case 'connection_ready':
            log.ok(`[房间 ${room.id}] ${ws._role} 确认P2P连接已建立`);
            break;

        default:
            room.relay(ws, msg);
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
        if (room.isExpired() || room.getPeerCount() === 0) {
            log.warn(`清理过期房间 ${id}`);
            rooms.delete(id);
        }
    }
    if (rooms.size > 0) {
        log.info(`当前活跃房间数: ${rooms.size}`);
    }
}, ROOM_CLEANUP_INTERVAL);

process.on('SIGTERM', () => {
    log.warn('收到 SIGTERM，关闭服务器...');
    wss.close();
    process.exit(0);
});

process.on('SIGINT', () => {
    log.warn('收到 SIGINT，关闭服务器...');
    wss.close();
    process.exit(0);
});

server.listen(PORT, '0.0.0.0', () => {
    log.ok(`══════════════════════════════════════`);
    log.ok(`  守护者 Guardian 信令服务器 v1.62`);
    log.ok(`  地址: ws://0.0.0.0:${PORT}`);
    log.ok(`  本机IP: ${getLocalIP() || '未知'}`);
    log.ok(`  房间超时: ${ROOM_MAX_AGE/1000}s`);
    log.ok(`  IP上报: ${serverConfig.ipReport.enabled ? '已启用' : '未启用'}`);
    log.ok(`══════════════════════════════════════`);
});

function getLocalIP() {
    const os = require('os');
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