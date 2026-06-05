const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const fs = require('fs');

const PORT = process.env.PORT || 8080;
const VERSION = process.env.APP_VERSION || '4.4.0';
const PAIR_TTL = parseInt(process.env.PAIR_TTL || '300000', 10);
const RELAY_MAX_SIZE = parseInt(process.env.RELAY_MAX_SIZE || '262144', 10);
const RELAY_RATE_LIMIT = parseInt(process.env.RELAY_RATE_LIMIT || '30', 10);
const PAIR_RATE_LIMIT = parseInt(process.env.PAIR_RATE_LIMIT || '10', 10);
const PAIR_WINDOW_MS = parseInt(process.env.PAIR_WINDOW_MS || '60000', 10);
const MAX_ACTIVE_PAIRS = parseInt(process.env.MAX_ACTIVE_PAIRS || '10000', 10);

const CORS_ALLOWED = process.env.CORS_ORIGIN || 'http://localhost:8080,http://127.0.0.1:8080,file://';

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

function parseOriginList(originStr) {
  return originStr.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

const allowedOrigins = parseOriginList(CORS_ALLOWED);

function corsOriginCheck(origin, callback) {
  if (!origin || allowedOrigins.indexOf('*') !== -1) {
    return callback(null, true);
  }
  if (allowedOrigins.indexOf(origin) !== -1) {
    return callback(null, true);
  }
  log.warn('CORS blocked origin: ' + origin);
  callback(null, false);
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: corsOriginCheck, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

app.use(function(req, res, next) {
  var origin = req.headers.origin;
  if (origin && allowedOrigins.indexOf('*') !== -1) {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.indexOf(origin) !== -1) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '100kb' }));

app.use(function(err, req, res, next) {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'invalid JSON' });
  }
  next();
});

// ========== 速率限制中间件 ==========
var rateLimitMap = new Map();

function rateLimit(key, maxRequests, windowMs) {
  var now = Date.now();
  var entry = rateLimitMap.get(key);
  if (!entry || (now - entry.windowStart) > windowMs) {
    rateLimitMap.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= maxRequests) {
    return false;
  }
  entry.count++;
  return true;
}

function cleanupRateLimitMap() {
  var now = Date.now();
  var expired = [];
  for (var entry of rateLimitMap) {
    if ((now - entry[1].windowStart) > 60000) {
      expired.push(entry[0]);
    }
  }
  expired.forEach(function(key) { rateLimitMap.delete(key); });
}

setInterval(cleanupRateLimitMap, 60000);

// ========== Socket.IO 信令中继 ==========
io.on('connection', function(socket) {
  var roomCode = null;
  var roomRole = null;
  var relayMsgCount = 0;
  var relayWindowStart = Date.now();
  var clientIP = socket.handshake.address || 'unknown';

  socket.on('join_room', function(data) {
    roomCode = data.code;
    roomRole = data.role;
    socket.join(data.code);
    io.to(data.code).emit('peer_joined', { role: data.role, id: socket.id });
    ioLog.ok(data.role + ' joined room ' + data.code + ' from ' + clientIP);
  });

  socket.on('signal_offer', function(data) {
    socket.to(data.code).emit('signal_offer', { sdp: data.sdp });
  });

  socket.on('signal_answer', function(data) {
    socket.to(data.code).emit('signal_answer', { sdp: data.sdp });
  });

  socket.on('signal_ice', function(data) {
    socket.to(data.code).emit('signal_ice', { candidate: data.candidate });
  });

  socket.on('relay_data', function(data) {
    if (!data || !data.code || !data.payload) {
      log.warn('relay_data rejected: missing fields from ' + clientIP);
      return;
    }
    var payloadStr = typeof data.payload === 'string' ? data.payload : JSON.stringify(data.payload);
    if (payloadStr.length > RELAY_MAX_SIZE) {
      log.warn('relay_data rejected: payload too large (' + payloadStr.length + ' bytes) from ' + clientIP);
      return;
    }
    var now = Date.now();
    if ((now - relayWindowStart) > 60000) {
      relayMsgCount = 0;
      relayWindowStart = now;
    }
    relayMsgCount++;
    if (relayMsgCount > RELAY_RATE_LIMIT) {
      log.warn('relay_data rate limit exceeded for ' + clientIP);
      return;
    }
    socket.to(data.code).emit('relay_data', { payload: data.payload });
  });

  socket.on('disconnect', function() {
    if (roomCode) {
      io.to(roomCode).emit('peer_disconnected', { role: roomRole, id: socket.id });
      ioLog.ok(roomRole + ' left room ' + roomCode + ' from ' + clientIP);
    }
  });
});

// ========== 配对 HTTP API ==========
var pairs = new Map();

// 调试：定期打印所有活跃的配对码
function debugActivePairs() {
  var now = Date.now();
  var active = [];
  for (var entry of pairs) {
    var code = entry[0];
    var pair = entry[1];
    var age = Math.round((now - pair.createdAt) / 1000);
    var remaining = Math.max(0, Math.round((pair.ttlMs - (now - pair.createdAt)) / 1000));
    active.push({ code: code, age: age + 's', remaining: remaining + 's', joinedBy: !!pair.joinedBy });
  }
  if (active.length > 0) {
    log.info('Active pairs:', JSON.stringify(active));
  }
}
setInterval(debugActivePairs, 10000);

app.post('/pair', function(req, res) {
  var clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  if (!rateLimit('pair:' + clientIP, PAIR_RATE_LIMIT, PAIR_WINDOW_MS)) {
    log.warn('pair rate limit exceeded for ' + clientIP);
    return res.status(429).json({ error: 'too many requests, try later' });
  }
  if (pairs.size >= MAX_ACTIVE_PAIRS) {
    log.warn('max active pairs reached, rejecting from ' + clientIP);
    return res.status(503).json({ error: 'server busy, try again' });
  }
  var code;
  var attempts = 0;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
    attempts++;
    if (attempts > 100) {
      log.err('failed to generate unique pair code');
      return res.status(500).json({ error: 'generation failed' });
    }
  } while (pairs.has(code));
  var ttlMs = PAIR_TTL;
  pairs.set(code, { code: code, createdBy: clientIP, joinedBy: null, createdAt: Date.now(), ttlMs: ttlMs });
  log.ok('pair created: ' + code + ', total pairs: ' + pairs.size + ', ttl: ' + ttlMs + 'ms');
  res.json({ status: 'ok', code: code, expiresIn: PAIR_TTL / 1000, role: 'guardian' });
});

app.post('/pair/:code/join', function(req, res) {
  var code = req.params.code;
  log.info('pair join request for code:', code, ', available codes:', Array.from(pairs.keys()).join(','));
  var pair = pairs.get(code);
  if (!pair) {
    log.warn('pair not found: ' + code);
    return res.status(404).json({ error: 'pair code not found or expired' });
  }
  if (!pair.joinedBy) pair.joinedBy = true;
  log.ok('pair joined: ' + code + ', total pairs: ' + pairs.size);
  res.json({ status: 'ok', code: req.params.code, role: 'protected', roomId: req.params.code });
});

app.get('/pair/:code/status', function(req, res) {
  var pair = pairs.get(req.params.code);
  if (!pair) return res.status(404).json({ error: 'pair code not found or expired' });
  res.json({ status: 'ok', code: req.params.code, ready: !!pair.joinedBy, joinedBy: !!pair.joinedBy });
});

app.get('/health', function(req, res) {
  var interfaces = os.networkInterfaces();
  var localIP = '127.0.0.1';
  for (var name of Object.keys(interfaces)) {
    for (var iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) { localIP = iface.address; break; }
    }
  }
  res.json({
    status: 'ok',
    version: VERSION,
    localIP: localIP,
    signalPort: PORT,
    socketIO: { available: true, transports: ['websocket', 'polling'], mode: 'always_available' },
    uptime: Date.now() - startTime
  });
});

var startTime = Date.now();

function cleanupExpiredPairs() {
  var now = Date.now();
  var cleaned = 0;
  for (var pair of pairs) {
    if (!pair[1].joinedBy && (now - pair[1].createdAt) > PAIR_TTL) {
      pairs.delete(pair[0]);
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
  server.close(function() { log.ok('server stopped'); process.exit(0); });
  setTimeout(function() { log.warn('force exit'); process.exit(0); }, 3000);
}

process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });

server.listen(PORT, '0.0.0.0', function() {
  log.ok('========================================');
  log.ok('  Guardian Signaling Server v' + VERSION);
  log.ok('  Socket.IO signaling  HTTP Pairing');
  log.ok('  Transport: WebSocket  HTTP polling fallback');
  log.ok('  HTTP on 0.0.0.0:' + PORT);
  log.ok('  CORS origins: ' + CORS_ALLOWED);
  log.ok('  Max relay payload: ' + (RELAY_MAX_SIZE / 1024).toFixed(0) + 'KB');
  log.ok('  Pair rate limit: ' + PAIR_RATE_LIMIT + '/min per IP');
  log.ok('  GET /health  POST /pair');
  log.ok('========================================');
});