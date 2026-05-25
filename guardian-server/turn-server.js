const Turn = require('node-turn');
const os = require('os');

const PORT = parseInt(process.env.TURN_PORT) || 3478;
const REALM = process.env.TURN_REALM || 'guardian.app';
const USERNAME = process.env.TURN_USER || 'guardian';
const CREDENTIAL = process.env.TURN_SECRET || 'guardian_p2p_2026';

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

const server = new Turn({
    port: PORT,
    realm: REALM,
    authMech: 'long-term',
    credentials: {
        [USERNAME]: CREDENTIAL
    },
    debug: function(level, message) {
        const prefix = `[TURN] ${level}`;
        if (level === 'error') console.error(`${prefix} ❌ ${message}`);
        else if (level === 'warn') console.warn(`${prefix} ⚠️ ${message}`);
        else if (level === 'info') console.log(`${prefix} ℹ️ ${message}`);
        else if (level === 'debug') console.log(`${prefix} 🔍 ${message}`);
    },
    listeningIps: ['0.0.0.0'],
    relayIps: [getLocalIP()],
    minPort: 49152,
    maxPort: 65535
});

server.on('error', (err) => {
    console.error(`[TURN] ❌ 服务器错误: ${err.message}`);
});

const localIP = getLocalIP();
console.log(`══════════════════════════════════════`);
console.log(`  守护者 Guardian TURN 服务器 v1.59`);
console.log(`  UDP端口: ${PORT}`);
console.log(`  本机IP: ${localIP}`);
console.log(`  认证: ${USERNAME} / ${CREDENTIAL}`);
console.log(`  Realm: ${REALM}`);
console.log(`  ⚠️ 确保防火墙已开放端口 ${PORT}`);
console.log(`  ⚠️ 确保路由器已端口转发 ${PORT}`);
console.log(`  客户端配置:`);
console.log(`  { urls: 'turn:${localIP}:${PORT}', username: '${USERNAME}', credential: '${CREDENTIAL}' }`);
console.log(`══════════════════════════════════════`);

server.start();