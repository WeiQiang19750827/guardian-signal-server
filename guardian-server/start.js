const { spawn } = require('child_process');
const path = require('path');

const SERVER_DIR = __dirname;
const TURN_PORT = 3478;
const SIGNAL_PORT = 8443;
const TURN_USER = 'guardian';
const TURN_SECRET = 'guardian_p2p_2026';

console.log('══════════════════════════════════════');
console.log('  守护者 Guardian 服务器启动器 v1.61');
console.log('══════════════════════════════════════');
console.log('');
console.log('⚠️  重要提示:');
console.log('  1. 确保防火墙已开放以下端口:');
console.log(`     - TCP ${SIGNAL_PORT} (信令服务器)`);
console.log(`     - UDP ${TURN_PORT} (TURN 服务器)`);
console.log('  2. 如果手机在外网访问，需要路由器端口转发');
console.log('  3. 查看本机IP后，在应用配置中使用该IP');
console.log('');

const servers = [];

function startServer(name, script, env) {
    return new Promise((resolve, reject) => {
        const proc = spawn('node', [script], {
            cwd: SERVER_DIR,
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true
        });

        proc.stdout.on('data', (data) => {
            process.stdout.write(`[${name}] ${data}`);
        });

        proc.stderr.on('data', (data) => {
            process.stderr.write(`[${name}] ${data}`);
        });

        proc.on('error', (err) => {
            console.error(`[${name}] ❌ 启动失败: ${err.message}`);
            reject(err);
        });

        proc.on('exit', (code) => {
            console.log(`[${name}] ⚫ 已退出 (code: ${code})`);
        });

        servers.push(proc);
        console.log(`[${name}] 🟢 已启动 (PID: ${proc.pid})`);
        setTimeout(resolve, 1000);
    });
}

let publicIP = '';

function detectPublicIP() {
    const http = require('http');
    const services = ['http://api.ipify.org', 'http://ifconfig.me/ip', 'http://icanhazip.com'];
    let tried = 0;
    function tryService(idx) {
        if (idx >= services.length) return;
        const req = http.get(services[idx], (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const ip = data.trim();
                if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
                    publicIP = ip;
                    console.log(`[公网IP] ${ip}`);
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

async function main() {
    try {
        const signalEnv = { PORT: String(SIGNAL_PORT) };
        await startServer('信令', 'signaling-server.js', signalEnv);

        const turnEnv = {
            TURN_PORT: String(TURN_PORT),
            TURN_USER: TURN_USER,
            TURN_SECRET: TURN_SECRET
        };
        await startServer('TURN', 'turn-server.js', turnEnv);

        const os = require('os');
        const interfaces = os.networkInterfaces();
        let localIP = '127.0.0.1';
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    localIP = iface.address;
                    break;
                }
            }
        }

        console.log('');
        console.log('══════════════════════════════════════');
        console.log('  ✅ 全部服务启动成功!');
        console.log('');
        console.log('  🌐 公网IP: ' + (publicIP || '(检测中...)'));
        console.log('  📡 信令服务器:');
        console.log(`     ws://${localIP}:${SIGNAL_PORT}`);
        console.log('');
        console.log('  🔄 TURN 服务器:');
        console.log(`     turn:${localIP}:${TURN_PORT}`);
        console.log(`     用户名: ${TURN_USER}`);
        console.log(`     密码: ${TURN_SECRET}`);
        console.log('');
        console.log('  📱 应用 ICE 配置:');
        console.log(`     { urls: 'turn:${localIP}:${TURN_PORT}', username: '${TURN_USER}', credential: '${TURN_SECRET}' }`);
        console.log(`     { urls: 'turn:${localIP}:${TURN_PORT}?transport=tcp', username: '${TURN_USER}', credential: '${TURN_SECRET}' }`);
        console.log('══════════════════════════════════════');
        console.log('');
        console.log('按 Ctrl+C 停止所有服务');

    } catch (err) {
        console.error('启动失败:', err);
        servers.forEach(p => { try { p.kill(); } catch(e) {} });
        process.exit(1);
    }
}

process.on('SIGINT', () => {
    console.log('\n正在停止所有服务...');
    servers.forEach(p => { try { p.kill(); } catch(e) {} });
    process.exit(0);
});

process.on('SIGTERM', () => {
    servers.forEach(p => { try { p.kill(); } catch(e) {} });
    process.exit(0);
});

main();