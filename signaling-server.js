const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const fs = require('fs');

const PORT = process.env.PORT || 8080;
const VERSION = '4.5.0';
const PAIR_TTL = 300000;

function createLogger(prefix) {
  return {
    info: (msg, data) => console.log(`[${prefix}] I ${msg}`, data || ''),
    ok: (msg, data) => console.log(`[${prefix}] OK ${msg}`, data || ''),
    warn: (msg, data) => console.warn(`[${prefix}] W ${msg}`, data || ''),
    err: (msg, data) => console.error(`[${prefix}] E ${msg}`, data || '')
  };
}

const log = createLogger('SIG');
const ioLog = createLogger('SOCKETIO');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json());

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'invalid JSON' });
  }
  next();
});

// ========== Socket.IO 信令中继 ==========
io.on('connection', (socket) => {
  let roomCode = null;
  let roomRole = null;

  socket.on('join_room', ({ code, role }) => {
    roomCode = code;
    roomRole = role;
    socket.join(code);
    socket.to(code).emit('peer_joined', { role });
    ioLog.ok(`${role} joined room ${code}`);
  });

  socket.on('signal_offer', ({ code, sdp }) => {
    socket.to(code).emit('signal_offer', { sdp });
  });

  socket.on('signal_answer', ({ code, sdp }) => {
    socket.to(code).emit('signal_answer', { sdp });
  });

  socket.on('signal_ice', ({ code, candidate }) => {
    socket.to(code).emit('signal_ice', { candidate });
  });

  socket.on('relay_data', ({ code, payload }) => {
    socket.to(code).emit('relay_data', { payload });
  });

  socket.on('disconnect', () => {
    if (roomCode) {
      socket.to(roomCode).emit('peer_disconnected', { role: roomRole });
      ioLog.ok(`${roomRole} left room ${roomCode}`);
    }
  });
});

// ========== 配对 HTTP API ==========
const pairs = new Map();

// 调试：定期打印所有活跃的配对码
function debugActivePairs() {
  const now = Date.now();
  const active = [];
  for (const [code, pair] of pairs) {
    const age = Math.round((now - pair.createdAt) / 1000);
    const remaining = Math.max(0, Math.round((PAIR_TTL - (now - pair.createdAt)) / 1000));
    active.push({ code, age: age + 's', remaining: remaining + 's', joinedBy: !!pair.joinedBy });
  }
  if (active.length > 0) {
    log.info('Active pairs:', JSON.stringify(active));
  }
}
setInterval(debugActivePairs, 10000);

app.post('/pair', (req, res) => {
  let code;
  do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (pairs.has(code));
  // 生成配对密码（4位数字）
  const password = String(Math.floor(1000 + Math.random() * 9000));
  pairs.set(code, { code, password, joinedBy: null, createdAt: Date.now() });
  log.ok('pair created: ' + code + ', password: ' + password + ', total pairs: ' + pairs.size);
  res.json({ status: 'ok', code, password, expiresIn: PAIR_TTL / 1000, role: 'guardian' });
});

app.post('/pair/:code/join', (req, res) => {
  const code = req.params.code;
  const providedPassword = req.body ? req.body.password : null;
  log.info('pair join request for code:', code, ', available codes:', Array.from(pairs.keys()).join(','));
  const pair = pairs.get(code);
  if (!pair) {
    log.warn('pair not found: ' + code);
    return res.status(404).json({ error: 'pair code not found or expired' });
  }
  // 验证密码
  if (pair.password && (!providedPassword || providedPassword !== pair.password)) {
    log.warn('invalid password for pair: ' + code);
    return res.status(401).json({ error: 'invalid password' });
  }
  if (!pair.joinedBy) pair.joinedBy = true;
  log.ok('pair joined: ' + code + ', total pairs: ' + pairs.size);
  res.json({ status: 'ok', code: req.params.code, role: 'protected', roomId: req.params.code });
});

app.get('/pair/:code/status', (req, res) => {
  const pair = pairs.get(req.params.code);
  if (!pair) return res.status(404).json({ error: 'pair code not found or expired' });
  res.json({ status: 'ok', code: req.params.code, ready: !!pair.joinedBy, joinedBy: !!pair.joinedBy });
});

app.get('/health', (req, res) => {
  const interfaces = os.networkInterfaces();
  let localIP = '127.0.0.1';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) { localIP = iface.address; break; }
    }
  }
  res.json({
    status: 'ok',
    version: VERSION,
    localIP,
    signalPort: PORT,
    socketIO: { available: true, transports: ['websocket', 'polling'], mode: 'always_available' },
    uptime: Date.now() - startTime
  });
});

let startTime = Date.now();

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

function gracefulShutdown(signal) {
  log.warn('received ' + signal + ', graceful shutdown...');
  pairs.clear();
  io.close();
  server.close(() => { log.ok('server stopped'); process.exit(0); });
  setTimeout(() => { log.warn('force exit'); process.exit(0); }, 3000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  log.ok('========================================');
  log.ok('  Guardian Signaling Server v' + VERSION);
  log.ok('  Socket.IO signaling  HTTP Pairing');
  log.ok('  Transport: WebSocket → HTTP polling fallback');
  log.ok('  HTTP on 0.0.0.0:' + PORT);
  log.ok('  GET /health  POST /pair');
  log.ok('========================================');
});