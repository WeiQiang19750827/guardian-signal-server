// ========== P2P通信核心模块 v4.5.7 ==========
// 依赖: socket.io (全局)

        // ========== 优化后的实时数据同步服务 ==========
        const RealTimeSync = {
            // ========== v1.67: MQTT信令链全面修复 ==========
            // 在这里填入你的 Gitee Gist Raw URL
            // 比如: 'https://gitee.com/你的用户名/你的GistID/raw/guardian-server-info.json'
            HARDCODED_CLOUD_URL: 'https://gist.githubusercontent.com/WeiQiang19750827/b9cb007301388fdc60fd6e5a01285bea/raw/guardian-server-info.json',
            
            listeners: {},
            deviceId: null,
            isHost: false,
            authCode: null,
            authCodeExpiry: null,
            isConnected: false,
            peerId: null,
            lastSyncTimestamps: {},
            _dedupMap: {},
            _dedupById: {},
            _msgSeq: 0,
            _offlineQueue: [],
            _dualRelayActive: false,
            _pairedRooms: {},
            reconnectTimer: null,
            heartbeatTimer: null,
            fastHeartbeatTimer: null,
            
            // ========== 配置参数 ==========
            AUTH_CODE_TTL: 24 * 60 * 60 * 1000,
            HEARTBEAT_INTERVAL: 15000,
            FAST_HEARTBEAT_INTERVAL: 5000,
            RECONNECT_DELAY: 2000,
            lastHeartbeatAck: null,
            connectionLatency: 0,
            missedHeartbeats: 0,
            MAX_MISSED_HEARTBEATS: 3,
            MAX_MISSED_FAST_HEARTBEATS: 4,
            HEARTBEAT_TIMEOUT: 8000,
            networkOnline: true,
            connectionStartTime: null,
            iceCandidateStats: [],
            
            // v1.59 新增: ICE Restart 追踪
            _lastNetworkType: null,
            
            // v1.64: 云端IP自动发现 + 全自动智能寻址（优先云端，其次手动，然后公网IP历史，最后局域网并行扫描）
            _serverConfig: null,
            _serverDiscoveryDone: false,
            _serverDiscoverRetries: 0,
            _serverRetryTimer: null,
            _railwayHealthy: false, // v2.0.3: Railway 服务器健康状态
            _railwayCheckDone: false, // v2.0.9: 健康检查是否已完成
            _healthCheckSeq: 0, // v2.0.9: 防止竞态条件
            _connecting: false, // v2.0.10: 连接中状态（UI 过渡）

            _getLocalIP(callback) {
                var self = this;
                try {
                    var pc = new RTCPeerConnection({ iceServers: [] });
                    pc.createDataChannel('');
                    pc.createOffer().then(function(offer) { pc.setLocalDescription(offer); }).catch(function(e) { console.warn('[P2P] createOffer failed:', e); });
                    pc.onicecandidate = function(e) {
                        if (!e || !e.candidate) return;
                        var ipMatch = /([0-9]{1,3}\.){3}[0-9]{1,3}/.exec(e.candidate.candidate);
                        if (ipMatch) {
                            var ip = ipMatch[0];
                            if (ip !== '127.0.0.1') {
                                pc.close();
                                callback(ip);
                            }
                        }
                    };
                    setTimeout(function() {
                        try { pc.close(); } catch(e) { console.warn('[P2P] pc.close timeout error:', e); }
                        callback(null);
                    }, 2000);
                } catch(e) {
                    console.warn('[P2P] _getLocalIP error:', e);
                    callback(null);
                }
            },

            _generateCandidateIPs(localIP) {
                var candidates = [];
                var parts = localIP ? localIP.split('.') : null;
                var subnets = [];
                if (parts && parts[0] === '192' && parts[1] === '168') {
                    subnets.push(parts[0] + '.' + parts[1] + '.' + parts[2]);
                } else if (parts && parts[0] === '10') {
                    subnets.push(parts[0] + '.' + parts[1] + '.' + parts[2]);
                } else if (parts && parts[0] === '172' && parseInt(parts[1]) >= 16 && parseInt(parts[1]) <= 31) {
                    subnets.push(parts[0] + '.' + parts[1] + '.' + parts[2]);
                }
                subnets.push('192.168.1', '192.168.3', '192.168.0', '10.0.0', '172.16.0');
                var seen = {};
                subnets.forEach(function(s) {
                    for (var i = 1; i <= 254; i++) {
                        var ip = s + '.' + i;
                        if (!seen[ip]) {
                            seen[ip] = true;
                            candidates.push(ip);
                        }
                    }
                });
                if (window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
                    candidates.push(window.location.hostname);
                }
                candidates.push('127.0.0.1');
                candidates.push('localhost');
                return candidates;
            },

            _getPublicIPs() {
                var ips = [];
                try {
                    var raw = localStorage.getItem('guardian_publicIPs');
                    if (raw) ips = JSON.parse(raw);
                } catch(e) { console.warn('[P2P] _getPublicIPs parse error:', e); }
                return Array.isArray(ips) ? ips : [];
            },

            _scanIPsBatched(ips, batchSize, timeoutMs, port, onFound, onComplete) {
                if (!ips || ips.length === 0) { if (onComplete) onComplete(); return; }
                var self = this;
                var index = 0;
                var found = false;
                var tried = new Set();

                function processBatch() {
                    if (found || index >= ips.length) {
                        if (onComplete && !found) onComplete();
                        return;
                    }
                    var batch = ips.slice(index, index + batchSize);
                    index += batchSize;
                    var pending = batch.length;

                    batch.forEach(function(ip) {
                        var key = ip + ':' + port;
                        if (tried.has(key)) { pending--; if (pending <= 0) processBatch(); return; }
                        tried.add(key);
                        var url = 'http://' + ip + ':' + port + '/health';
                        var xhr = new XMLHttpRequest();
                        xhr.timeout = timeoutMs;
                        xhr.onload = function() {
                            if (!found) {
                                try {
                                    var config = JSON.parse(xhr.responseText);
                                    if (config && config.status === 'ok') {
                                        found = true;
                                        if (onFound) onFound(config, ip);
                                        return;
                                    }
                                } catch(e) {}
                            }
                            pending--;
                            if (pending <= 0) processBatch();
                        };
                        xhr.onerror = function() { pending--; if (pending <= 0) processBatch(); };
                        xhr.ontimeout = function() { pending--; if (pending <= 0) processBatch(); };
                        xhr.open('GET', url, true);
                        xhr.send();
                    });
                }

                processBatch();
            },

            _savePublicIP(config) {
                if (!config || !config.ip) return;
                try {
                    var ips = this._getPublicIPs();
                    if (ips.indexOf(config.ip) === -1) {
                        ips.push(config.ip);
                        if (ips.length > 10) ips.shift();
                        localStorage.setItem('guardian_publicIPs', JSON.stringify(ips));
                    }
                } catch(e) { console.warn('[P2P] _savePublicIP error:', e); }
            },

            // v2.0.2: Railway TURN 发现（最高优先级）
            // 直接调用 Railway /health 获取内置 TURN 服务器凭证
            // 解决 WiFi↔4G 跨网 ICE NAT 穿透失败问题
            _tryRailwayTurn(callback) {
                var self = this;
                var xhr = new XMLHttpRequest();
                xhr.timeout = 6000;
                xhr.onload = function() {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        if (data && data.status === 'ok' && data.turn) {
                            var urls = data.turn.urls || [];
                            var url0 = urls[0] || '';
                            var m = url0.match(/:(\d{4,5})(\?|$)/);
                            var port = m ? m[1] : '3478';
                            callback({
                                ip: data.publicIP || data.ip,
                                publicIP: data.publicIP || data.ip,
                                localIP: data.localIP || data.ip,
                                signalPort: data.signalPort || 8080,
                                turn: {
                                    available: true,
                                    port: port,
                                    username: data.turn.username || 'guardian',
                                    credential: data.turn.credential || ''
                                }
                            });
                            return;
                        }
                    } catch(e) {}
                    callback(null);
                };
                xhr.onerror = function() { callback(null); };
                xhr.ontimeout = function() { callback(null); };
                xhr.open('GET', 'https://guardian-sig-v2.up.railway.app/health', true);
                xhr.send();
            },

            // v2.0.9: Railway 健康检查（防竞态 + 自动刷新 UI）
            _checkRailwayConnection(callback) {
                RealTimeSync._healthCheckSeq++;
                var mySeq = RealTimeSync._healthCheckSeq;
                var xhr = new XMLHttpRequest();
                xhr.timeout = 5000;
                xhr.onload = function() {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        if (data && data.status === 'ok') {
                            if (mySeq === RealTimeSync._healthCheckSeq) {
                                RealTimeSync._railwayHealthy = true;
                                RealTimeSync._railwayCheckDone = true;
                                updateServerStatus();
                            }
                            if (callback) callback(true);
                            return;
                        }
                    } catch(e) {}
                    if (mySeq === RealTimeSync._healthCheckSeq) {
                        RealTimeSync._railwayHealthy = false;
                    }
                    RealTimeSync._railwayCheckDone = true;
                    updateServerStatus();
                    if (callback) callback(false);
                };
                xhr.onerror = function() {
                    if (mySeq === RealTimeSync._healthCheckSeq) {
                        RealTimeSync._railwayHealthy = false;
                    }
                    RealTimeSync._railwayCheckDone = true;
                    updateServerStatus();
                    if (callback) callback(false);
                };
                xhr.ontimeout = function() {
                    if (mySeq === RealTimeSync._healthCheckSeq) {
                        RealTimeSync._railwayHealthy = false;
                    }
                    RealTimeSync._railwayCheckDone = true;
                    updateServerStatus();
                    if (callback) callback(false);
                };
                xhr.open('GET', 'https://guardian-sig-v2.up.railway.app/health', true);
                xhr.send();
            },

            _autoDiscoverServer() {
                if (this._serverDiscoveryDone) return;
                var self = this;
                // v2.0.2: 优先级-1 — Railway TURN 发现（最高优先级，覆盖旧 Gist）
                self._tryRailwayTurn(function(config) {
                    if (config) {
                        console.log('[AutoDiscover] ✅ Railway TURN 配置有效:', config.ip);
                        self._serverConfig = config;
                        self._serverDiscoveryDone = true;
                        self._dispatch('p2p:serverDiscovered', { found: true, config: config, source: 'railway' });
                        return;
                    }
                    // Railway 失败 → 退回原 Gist 发现链
                    self._tryLegacyDiscovery();
                });
            },

            _tryLegacyDiscovery() {
                if (this._serverDiscoveryDone) return;
                var self = this;
                try {
                    // 优先级0: 硬编码的云端URL（v1.67零配置方案，手机用户什么都不用管！）
                    if (this.HARDCODED_CLOUD_URL) {
                        console.log('[AutoDiscover] 🔍 尝试硬编码云端URL:', this.HARDCODED_CLOUD_URL);
                        self._fetchServerIPFromCloud(this.HARDCODED_CLOUD_URL, function(config) {
                            if (config) {
                                console.log('[AutoDiscover] ✅ 硬编码云端配置有效:', config.ip);
                                self._serverConfig = config;
                                self._serverDiscoveryDone = true;
                                self._dispatch('p2p:serverDiscovered', { found: true, config: config, source: 'hardcoded' });
                                return;
                            }
                            // 硬编码云端获取失败，尝试 localStorage 云端
                            self._tryLocalStorageCloudConfig();
                        }, function() {
                            self._tryLocalStorageCloudConfig();
                        });
                        return;
                    }
                } catch(e) { console.warn('[AutoDiscover] gist fetch error:', e); }
                
                // 优先级1: localStorage 中的云端URL
                this._tryLocalStorageCloudConfig();
            },
            
            _tryLocalStorageCloudConfig() {
                if (this._serverDiscoveryDone) return;
                var self = this;
                try {
                    var cloudUrl = localStorage.getItem('guardian_cloudGistUrl');
                    if (cloudUrl) {
                        self._fetchServerIPFromCloud(cloudUrl, function(config) {
                            if (config) {
                                console.log('[AutoDiscover] ✅ 云端配置有效:', config.ip);
                                self._serverConfig = config;
                                self._serverDiscoveryDone = true;
                                self._dispatch('p2p:serverDiscovered', { found: true, config: config, source: 'cloud' });
                                return;
                            }
                            // 云端获取失败，继续尝试手动配置
                            self._tryManualConfig();
                        }, function() {
                            self._tryManualConfig();
                        });
                        return;
                    }
                } catch(e) { console.warn('[AutoDiscover] localStorage read error:', e); }
                
                this._tryManualConfig();
            },

            _tryManualConfig() {
                if (this._serverDiscoveryDone) return;
                var self = this;
                try {
                    var raw = localStorage.getItem('guardian_serverConfig');
                    if (raw) {
                        var saved = JSON.parse(raw);
                        if (saved && saved.host) {
                            var url = 'http://' + saved.host + ':' + (saved.signalPort || 8080) + '/health';
                            var xhr = new XMLHttpRequest();
                            xhr.timeout = 3000;
                            xhr.onload = function() {
                                try {
                                    var config = JSON.parse(xhr.responseText);
                                    if (config && config.status === 'ok') {
                                        console.log('[AutoDiscover] ✅ 手动配置有效:', config.ip);
                                        self._serverConfig = config;
                                        self._serverDiscoveryDone = true;
                                        self._dispatch('p2p:serverDiscovered', { found: true, config: config, source: 'manual' });
                                        return;
                                    }
                                } catch(e) { console.warn('[AutoDiscover] manual config parse error:', e); }
                                self._startDiscovery();
                            };
                            xhr.onerror = function() { self._startDiscovery(); };
                            xhr.ontimeout = function() { self._startDiscovery(); };
                            xhr.open('GET', url, true);
                            xhr.send();
                            return;
                        }
                    }
                } catch(e) { console.warn('[AutoDiscover] manual config error:', e); }
                this._startDiscovery();
            },

            _fetchServerIPFromCloud(url, onSuccess, onError) {
                var self = this;
                try {
                    console.log('[AutoDiscover] 🔍 尝试从云端获取服务器配置:', url);
                    var xhr = new XMLHttpRequest();
                    xhr.timeout = 5000;
                    xhr.onload = function() {
                        try {
                            var config = JSON.parse(xhr.responseText);
                            if (config) {
                                var cloudIP = config.ip || config.publicIP;
                                if (config.status === 'ok' && cloudIP) {
                                // 验证云端返回的配置
                                var testUrl = 'http://' + cloudIP + ':' + (config.signalPort || 8080) + '/health';
                                var testXhr = new XMLHttpRequest();
                                testXhr.timeout = 3000;
                                testXhr.onload = function() {
                                    try {
                                        var testConfig = JSON.parse(testXhr.responseText);
                                        if (testConfig && testConfig.status === 'ok') {
                                            // 验证成功，保存公网IP并返回
                                            self._savePublicIP(config);
                                            if (onSuccess) onSuccess(testConfig);
                                        } else {
                                            if (onError) onError();
                                        }
                                    } catch(e) {
                                        if (onError) onError();
                                    }
                                };
                                testXhr.onerror = function() { if (onError) onError(); };
                                testXhr.ontimeout = function() { if (onError) onError(); };
                                testXhr.open('GET', testUrl, true);
                                testXhr.send();
                            } else {
                                if (onError) onError();
                            }
                        } else {
                            if (onError) onError();
                        }
                        } catch(e) {
                            console.error('[AutoDiscover] 云端配置解析失败:', e);
                            if (onError) onError();
                        }
                };
                    xhr.onerror = function() {
                        console.error('[AutoDiscover] 云端配置获取失败');
                        if (onError) onError();
                    };
                    xhr.ontimeout = function() {
                        console.error('[AutoDiscover] 云端配置获取超时');
                        if (onError) onError();
                    };
                    xhr.open('GET', url, true);
                    xhr.send();
                } catch(e) {
                    console.error('[AutoDiscover] 云端配置获取异常:', e);
                    if (onError) onError();
                }
            },

            _startDiscovery() {
                var self = this;
                var publicIPs = this._getPublicIPs();
                var port = 8080;

                this._getLocalIP(function(localIP) {
                    console.log('[AutoDiscover] 本机IP:', localIP || '未知');
                    var candidates = self._generateCandidateIPs(localIP);

                    publicIPs.forEach(function(ip) {
                        if (candidates.indexOf(ip) === -1) {
                            candidates.push(ip);
                        }
                    });

                    console.log('[AutoDiscover] 扫描 ' + candidates.length + ' 个候选地址...');

                    self._scanIPsBatched(candidates, 20, 2000, port, function(config, ip) {
                        console.log('[AutoDiscover] ✅ 发现服务器:', ip);
                        self._serverConfig = config;
                        self._serverDiscoveryDone = true;
                        self._savePublicIP(config);
                        self._dispatch('p2p:serverDiscovered', { found: true, config: config, source: 'auto' });
                    }, function() {
                        console.log('[AutoDiscover] 未发现服务器，尝试端口80...');
                        self._scanIPsBatched(candidates, 20, 2000, 80, function(config, ip) {
                            console.log('[AutoDiscover] ✅ 发现服务器(端口80):', ip);
                            self._serverConfig = config;
                            self._serverDiscoveryDone = true;
                            self._savePublicIP(config);
                            self._dispatch('p2p:serverDiscovered', { found: true, config: config, source: 'auto' });
                        }, function() {
                            console.log('[AutoDiscover] 未发现可用服务器');
                            if (self._serverDiscoverRetries < 5) {
                                self._scheduleDiscoveryRetry();
                            } else {
                                self._serverDiscoveryDone = true;
                                self._dispatch('p2p:serverDiscovered', { found: false });
                            }
                        });
                    });
                });
            },

            _scheduleDiscoveryRetry() {
                var self = this;
                var delays = [5000, 10000, 20000, 30000, 60000];
                var delay = delays[self._serverDiscoverRetries] || 60000;
                self._serverDiscoverRetries++;
                console.log('[AutoDiscover] 将在 ' + (delay / 1000) + ' 秒后重试 (第' + self._serverDiscoverRetries + '次)');
                if (self._serverRetryTimer) clearTimeout(self._serverRetryTimer);
                self._serverRetryTimer = setTimeout(function() {
                    self._startDiscovery();
                }, delay);
            },


            getIceServers() {
                var servers = [
                    { urls: 'stun:stun.miwifi.com:3478' },
                    { urls: 'stun:stun.chat.bilibili.com:3478' },
                    { urls: 'stun:stun.hitv.com:3478' },
                    { urls: 'stun:global.stun.twilio.com:3478' },
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun3.l.google.com:19302' },
                    { urls: 'stun:stun4.l.google.com:19302' }
                ];
                
                // 动态注入自动发现的自建TURN
                if (this._serverConfig && this._serverConfig.turn && this._serverConfig.turn.available) {
                    var turn = this._serverConfig.turn;
                    var host = this._serverConfig.ip;
                    var localHost = this._serverConfig.localIP;
                    console.log('[ICE] 使用自建TURN - 公网:', host + ':' + turn.port, '内网:', localHost ? localHost + ':' + turn.port : '无');
                    servers.push({
                        urls: 'turn:' + host + ':' + turn.port,
                        username: turn.username,
                        credential: turn.credential
                    });
                    servers.push({
                        urls: 'turn:' + host + ':' + turn.port + '?transport=tcp',
                        username: turn.username,
                        credential: turn.credential
                    });
                    if (localHost && localHost !== host) {
                        servers.push({
                            urls: 'turn:' + localHost + ':' + turn.port,
                            username: turn.username,
                            credential: turn.credential
                        });
                        servers.push({
                            urls: 'turn:' + localHost + ':' + turn.port + '?transport=tcp',
                            username: turn.username,
                            credential: turn.credential
                        });
                    }
                } else if (this._serverDiscoveryDone && this._serverConfig) {
                    console.log('[ICE] 自建TURN不可用');
                }
                
                servers.push(
                    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
                    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
                    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
                    { urls: 'turn:openrelay2.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
                    { urls: 'turn:openrelay2.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                );
                
                return servers;
            },
            
            // ========== PeerJS配置（v1.59 增强版） ==========
            getPeerConfig() {
                return {
                    debug: 1,
                    config: {
                        iceServers: this.getIceServers(),
                        iceTransportPolicy: 'all',
                        iceCandidatePoolSize: 20,
                        bundlePolicy: 'max-bundle',
                        rtcpMuxPolicy: 'require',
                        sdpSemantics: 'unified-plan'
                    }
                };
            },

            init() {
                this.deviceId = 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                
                // 本地存储同步
                window.addEventListener('storage', (e) => {
                    if (e.key && e.key.startsWith('guardian_sync_')) {
                        const event = JSON.parse(e.newValue);
                        if (event && event.source !== this.deviceId) {
                            this._dispatch(event.type, event.data);
                        }
                    }
                });
                
                // 网络状态监听
                this._loadPersistedConnection();
                this._loadPersistedRooms();
                this.networkOnline = navigator.onLine !== false;
                
                // v1.59: ICE Restart - 监听网络类型变化
                this._lastNetworkType = this._getNetworkEffectiveType();
                if (navigator.connection) {
                    navigator.connection.addEventListener('change', () => {
                        const newType = this._getNetworkEffectiveType();
                        if (this._lastNetworkType && this._lastNetworkType !== newType) {
                            console.log(`[P2P ICE Restart] 网络切换: ${this._lastNetworkType} → ${newType}`);
                            this._dispatch('p2p:networkChange', { 
                                from: this._lastNetworkType, 
                                to: newType 
                            });
                        }
                        this._lastNetworkType = newType;
                    });
                }
                
                window.addEventListener('online', () => {
                    this.networkOnline = true;
                    console.log('[P2P] Network online');
                    this._dispatch('p2p:networkStatus', { online: true, quality: 'checking' });
                    if (!this.isConnected && this.authCode) {
                        this._attemptReconnect();
                    }
                    if (Object.keys(this._pairedRooms).length > 0) {
                        MultiRelayBus._ensureConnection();
                    }
                    if (this.isConnected) {
                        console.log('[P2P ICE Restart] 网络恢复，重启ICE');
                        this._dispatch('p2p:networkRestore', {});
                    }
                });
                window.addEventListener('offline', () => {
                    this.networkOnline = false;
                    console.log('[P2P] Network offline');
                    this._dispatch('p2p:networkStatus', { online: false });
                });

                // 连接质量监控 (v1.59 增强)
                this._startConnectionMonitor();
                
                // v1.59: 自动发现服务器（异步，不影响其他功能）
                this._autoDiscoverServer();

                // v2.0.3: 异步检查 Railway 服务器健康状态
                this._checkRailwayConnection();
                if (this._healthCheckTimer) clearInterval(this._healthCheckTimer);
                this._healthCheckTimer = setInterval(function() {
                    RealTimeSync._checkRailwayConnection();
                }, 15000);

                console.log('[P2P] RealTimeSync initialized, deviceId:', this.deviceId);
            },

            _generateAuthCode() {
                return String(Math.floor(100000 + Math.random() * 900000));
            },

            _generatePeerId() {
                return 'guardian_' + this._generateAuthCode() + '_' + Date.now();
            },

            _peerIdFromAuthCode(code) {
                return 'guardian_' + code;
            },

            _fetchWithRetry(url, options, maxRetries, delayMs) {
                var self = this;
                maxRetries = maxRetries || 3;
                delayMs = delayMs || 1000;
                
                function attempt(retryCount) {
                    return new Promise(function(resolve, reject) {
                        fetch(url, options)
                            .then(function(response) {
                                if (!response.ok && response.status >= 500 && retryCount < maxRetries) {
                                    console.log('[P2P] 服务器错误 ' + response.status + ', 重试 ' + (retryCount + 1) + '/' + maxRetries);
                                    setTimeout(function() {
                                        attempt(retryCount + 1).then(resolve).catch(reject);
                                    }, delayMs * Math.pow(2, retryCount));
                                } else {
                                    resolve(response);
                                }
                            })
                            .catch(function(error) {
                                if (retryCount < maxRetries) {
                                    console.log('[P2P] 网络错误, 重试 ' + (retryCount + 1) + '/' + maxRetries + ': ' + error.message);
                                    setTimeout(function() {
                                        attempt(retryCount + 1).then(resolve).catch(reject);
                                    }, delayMs * Math.pow(2, retryCount));
                                } else {
                                    reject(error);
                                }
                            });
                    });
                }
                
                return attempt(0);
            },

            generateAuthCode() {
                console.log('[P2P] generateAuthCode CALLED');
                this._cleanupConnection();

                // v1.108: 改用 HTTP 配对接口（v1.107 移植），废弃 PeerJS / 本地WS / 旧码生成
                var self = this;
                this.isHost = true;
                this.authCode = '------';
                this.authPassword = null;
                this.authCodeExpiry = Date.now() + this.AUTH_CODE_TTL;

                this._pairServer = this._pairServer || 'https://guardian-sig-v2.up.railway.app';
                
                return new Promise(function(resolve, reject) {
                    self._fetchWithRetry(self._pairServer + '/pair', { method: 'POST' }, 3, 1000)
                        .then(function(r){ return r.json(); })
                        .then(function(data){
                            if (!data || !data.code) throw new Error('服务端返回无效');
                            self.authCode = data.code;
                            self.authPassword = data.password || null;
                            self.authCodeExpiry = Date.now() + (data.expiresIn ? data.expiresIn * 1000 : self.AUTH_CODE_TTL);
                            self.peerId = self._peerIdFromAuthCode(self.authCode);
                            self._persistConnection(); // 立即保存配对信息到本地
                            console.log('[P2P v1.108] HTTP配对码已获取:', self.authCode, '密码:', self.authPassword);
                            self._dispatch('p2p:codeReady', { code: self.authCode, password: self.authPassword, expiresAt: self.authCodeExpiry });
                            self._startPairPolling(self.authCode, 'host');
                            // v2.0.2: 直接进入信令中继（Railway WebSocket relay 替代 MQTT）
                            self._enterRelaySignaling('host', self.authCode);
                            resolve({ code: self.authCode, password: self.authPassword, expiresAt: self.authCodeExpiry });
                        })
                        .catch(function(e){
                            console.error('[P2P v1.108] HTTP配对失败:', e);
                            showToast('❌ 配对码获取失败，请检查网络');
                            self._dispatch('p2p:error', { type: 'network', message: '配对码获取失败' });
                            reject(e);
                        });
                });
            },

            

            connectWithCode(code, password) {
                this._connecting = true;
                this._cleanupConnection();
                
                this.authCode = code;
                this.authPassword = password || null;
                this.isHost = false;
                this.peerId = this._peerIdFromAuthCode(code);

                // v1.108: 改用 HTTP /pair/:code/join 校验，再走 MQTT 信令链
                var self = this;
                this._pairServer = this._pairServer || 'https://guardian-sig-v2.up.railway.app';
                var joinUrl = self._pairServer + '/pair/' + encodeURIComponent(code) + '/join';
                console.log('[P2P] connectWithCode: 开始连接, code=' + code + ', url=' + joinUrl);
                
                return new Promise(function(resolve, reject) {
                    self._fetchWithRetry(joinUrl, { 
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password: password })
                    }, 3, 1000)
                        .then(function(r){
                            console.log('[P2P] connectWithCode: HTTP响应, status=' + r.status);
                            if (r.status === 404) throw new Error('配对码无效或已过期');
                            if (r.status === 401) throw new Error('密码错误');
                            if (r.status === 400) throw new Error('该配对码已被使用');
                            if (r.status === 429) throw new Error('请求过于频繁，请稍后重试');
                            if (r.status === 503) throw new Error('服务器繁忙，请稍后重试');
                            return r.json();
                        })
                        .then(function(data){
                            console.log('[P2P] connectWithCode: 配对码校验成功, data=' + JSON.stringify(data));
                            self._enterRelaySignaling('client', code);
                            self.addPairedRecipient(code, '已配对设备');
                            resolve();
                        })
                        .catch(function(e){
                            self._connecting = false;
                            updateP2PStatus();
                            console.error('[P2P] connectWithCode: HTTP配对失败:', e);
                            self._dispatch('p2p:error', { type: 'notFound', message: e.message || '配对失败' });
                            showToast('❌ ' + (e.message || '配对失败'));
                            reject(e);
                        });
                });
            },

            // v3.0: Socket.IO 信令入口
            _enterRelaySignaling(role, code) {
                var self = this;
                var useLocal = role === 'host';
                console.log('[P2P v3.0] SocketIO信令启动, role=' + role + ', code=' + code);
                showToast('📡 连接信令中继...');
                self._useSig = false;
                self._connecting = true;
                
                // 添加连接超时保护
                var connectTimeout = setTimeout(function() {
                    if (self._connecting && !self.isConnected) {
                        console.warn('[P2P] 连接超时，超时时间30秒');
                        self._connecting = false;
                        updateP2PStatus();
                        showToast('❌ 连接超时，请重试');
                        self._dispatch('p2p:error', { type: 'timeout', message: '连接超时' });
                    }
                }, 30000);
                
                var origOnConnect = SocketIOSignaling.onconnect;
                SocketIOSignaling.onconnect = function() {
                    console.log('[P2P] onconnect 触发, isConnected=' + (window.RealTimeSync ? RealTimeSync.isConnected : 'no_rt') + ', dcState=' + (SocketIOSignaling.dc ? SocketIOSignaling.dc.readyState : 'no_dc') + ', relayActive=' + SocketIOSignaling._relayActive);
                    // 清除超时
                    if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
                    
                    if (window.RealTimeSync && !RealTimeSync.isConnected && SocketIOSignaling.dc && SocketIOSignaling.dc.readyState === 'open') {
                        console.log('[P2P v3.0] SocketIO信令连接成功');
                        RealTimeSync._connectSig(SocketIOSignaling.dc);
                    } else {
                        console.warn('[P2P] onconnect 条件未满足: isConnected=' + (RealTimeSync ? RealTimeSync.isConnected : '?') + ', dc=' + (SocketIOSignaling.dc ? SocketIOSignaling.dc.readyState : 'null'));
                    }
                    // 如果有原始回调，也调用它
                    if (typeof origOnConnect === 'function') {
                        origOnConnect();
                    }
                };
                SocketIOSignaling.ondisconnect = function() {
                    // 清除超时
                    if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
                    
                    if (window.RealTimeSync && RealTimeSync.isConnected && RealTimeSync._useSig) {
                        RealTimeSync.isConnected = false;
                        RealTimeSync._dispatch('p2p:disconnected', {});
                    } else if (window.RealTimeSync && RealTimeSync._connecting) {
                        // 如果是在连接中断开
                        RealTimeSync._connecting = false;
                        updateP2PStatus();
                    }
                };
                setTimeout(function() { SocketIOSignaling.connect(code, useLocal); }, 100);
            },

            // v1.108: HTTP 配对状态轮询（host 端等待 protected 加入）
            _startPairPolling(code, role) {
                var self = this;
                if (self._pairPollTimer) clearInterval(self._pairPollTimer);
                self._pairPollTimer = setInterval(function(){
                    if (self.isConnected) {
                        clearInterval(self._pairPollTimer); self._pairPollTimer = null; return;
                    }
                    fetch(self._pairServer + '/pair/' + encodeURIComponent(code) + '/status')
                        .then(function(r){
                            if (r.status === 404) { clearInterval(self._pairPollTimer); self._pairPollTimer = null; throw new Error('配对码已过期'); }
                            return r.json();
                        })
                        .then(function(data){
                            if (data.ready && role === 'host') {
                                console.log('[P2P v1.108] 对端已加入配对房间');
                            }
                        })
                        .catch(function(e){ console.warn('[P2P v1.108] 轮询异常:', e.message); });
                }, 2000);
            },

            

            _setupConnection(conn) {
                this.connectionStartTime = Date.now();
                this.iceCandidateStats = [];
                this.connectionStage = 'connecting';
                
                console.log('[P2P] 🔗 Setting up connection (v1.59)...');
                this._dispatch('p2p:status', { status: 'establishing' });
                
                conn.on('open', () => {
                    const timeToConnect = Date.now() - this.connectionStartTime;
                    console.log('[P2P] ✅ Connection established with:', conn.peer, 'time to connect:', timeToConnect + 'ms');
                    this.connectionStage = 'connected';
                    this.isConnected = true;
                    this._lastNetworkType = this._getNetworkEffectiveType();
                    this._startHeartbeat();
                    this._sendQueuedEvents();
                    this._dispatch('p2p:connected', { peerId: conn.peer, timeToConnect: timeToConnect });
                    showToast('✅ 连接成功！');
                });
                
                conn.on('data', (data) => {
                    console.log('[P2P] 📨 Data received:', data.type);
                    this._handleIncomingData(data);
                });
                
                conn.on('close', () => {
                    console.log('[P2P] 🔌 Connection closed');
                    this.connectionStage = 'disconnected';
                    this.isConnected = false;
                    this._stopHeartbeat();
                    this._dispatch('p2p:disconnected', {});
                    if (this.authCode && !this._demoMode) {
                        showToast('⚠️ 连接断开，正在尝试重连...');
                        this._attemptReconnect();
                    }
                });
                
                conn.on('error', (err) => {
                    console.error('[P2P] ❌ Connection error:', err);
                    this._dispatch('p2p:error', { type: 'connection', message: err.message });
                    showToast(`❌ 连接错误: ${err.message}`);
                });
            },

            _cleanupConnection() {
                this._stopHeartbeat();
                this._stopConnectionMonitor();
                // v1.108: 清理 HTTP 配对轮询
                if (this._pairPollTimer) { clearInterval(this._pairPollTimer); this._pairPollTimer = null; }
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
                if (this._useSig && this._sigDc) {
                    try { MqttSignaling.close(); } catch(e) { console.warn('[P2P] MqttSignaling.close error:', e); }
                    this._sigDc = null;
                    this._useSig = false;
                }
                this.isConnected = false;
                this._mqttTried = false;
            },

            _getNetworkEffectiveType() {
                try {
                    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
                    if (conn && conn.effectiveType) return conn.effectiveType;
                    if (conn && conn.type) return conn.type;
                } catch (e) {}
                return 'unknown';
            },

            _startConnectionMonitor() {
                this._stopConnectionMonitor();
                this.connectionMonitorTimer = setInterval(() => {
                    if (this.isConnected && this._sigDc && this._useSig) {
                        if (this.lastHeartbeatAck) {
                            this._dispatch('p2p:networkStatus', { online: true, quality: 'good', latency: this.connectionLatency });
                        }
                    }
                }, 5000);
            },

            _stopConnectionMonitor() {
                if (this.connectionMonitorTimer) {
                    clearInterval(this.connectionMonitorTimer);
                    this.connectionMonitorTimer = null;
                }
            },

            _handleIncomingData(data) {
                if (!data || !data.type) return;

                var dedupId = data._msgSeq ? (data.from + '_' + data._msgSeq) : '';
                if (dedupId) {
                    if (this._dedupById[dedupId]) { console.log('[P2P] Dedup msg:', dedupId); return; }
                    this._dedupById[dedupId] = Date.now();
                    if (Object.keys(this._dedupById).length > 500) {
                        var cutoff = Date.now() - 60000;
                        for (var k in this._dedupById) { if (this._dedupById[k] < cutoff) delete this._dedupById[k]; }
                    }
                }

                if (data.payload && data.payload.timestamp && data.payload.source) {
                    var dedupKey = data.payload.source + '_' + data.payload.timestamp;
                    if (this._dedupMap[dedupKey]) return;
                    this._dedupMap[dedupKey] = Date.now();
                    if (Object.keys(this._dedupMap).length > 200) {
                        var cutoff = Date.now() - 30000;
                        for (var k in this._dedupMap) {
                            if (this._dedupMap[k] < cutoff) delete this._dedupMap[k];
                        }
                    }
                }

                switch(data.type) {
                    case 'heartbeat':
                        this._send({ type: 'heartbeat_ack', from: this.deviceId, timestamp: Date.now(), echoTimestamp: data.timestamp, mode: data.mode || 'normal' });
                        break;
                    case 'heartbeat_ack':
                        if (this.heartbeatAckTimer) { clearTimeout(this.heartbeatAckTimer); this.heartbeatAckTimer = null; }
                        this.missedHeartbeats = 0;
                        if (data.echoTimestamp) {
                            this.connectionLatency = Date.now() - data.echoTimestamp;
                        }
                        var q = this.connectionLatency < 500 ? 'excellent' : this.connectionLatency < 2000 ? 'good' : this.connectionLatency < 5000 ? 'fair' : 'poor';
                        if (q === 'excellent' && this.fastHeartbeatTimer) {
                            this._startNormalHeartbeat();
                        }
                        this._dispatch('p2p:networkStatus', { 
                            online: true, 
                            quality: q, 
                            latency: this.connectionLatency,
                            uptime: this.connectionStartTime ? Date.now() - this.connectionStartTime : 0
                        });
                        break;
                    case 'test_packet':
                        console.log('[P2P] 📨 Test packet received:', data);
                        if (data.from !== this.deviceId) {
                            const latency = Date.now() - data.timestamp;
                            console.log('[P2P] 📊 Test packet round-trip:', latency + 'ms');
                        }
                        break;
                    case 'full_sync_request':
                        this._handleFullSyncRequest(data);
                        break;
                    case 'full_sync_response':
                        this._handleFullSyncResponse(data);
                        break;
                    case 'sync_event':
                        this._handleSyncEvent(data.payload);
                        break;
                    default:
                        console.log('[P2P] Unknown data type:', data.type);
                }
            },

            _handleSyncEvent(event) {
                if (!event || !event.type) return;
                if (event.source === this.deviceId) return;
                console.log('[P2P] Sync event received:', event.type);

                switch(event.type) {
                    case 'task:add':
                        if (event.data && event.data.recipient && event.data.task) {
                            if (!recipientTasksData[event.data.recipient]) recipientTasksData[event.data.recipient] = [];
                            const exists = recipientTasksData[event.data.recipient].find(t => t.id === event.data.task.id);
                            if (!exists) {
                                event.data.task.updatedAt = event.timestamp;
                                recipientTasksData[event.data.recipient].push(event.data.task);
                                DataStore.save('tasks', recipientTasksData);
                                
                                // 给用户提示有新任务（特别是被监护人端）
                                if (currentRole === 'recipient' && currentRecipientView === event.data.recipient) {
                                    showToast(`🎉 收到新任务: ${event.data.task.name}`);
                                }
                            }
                            // 刷新所有相关页面
                            if (typeof loadRecipientTasks === 'function' && currentRecipientView === event.data.recipient) loadRecipientTasks();
                            if (typeof renderRecipientDetail === 'function' && currentSelectedRecipient) renderRecipientDetail(currentSelectedRecipient);
                            if (typeof renderRecipientTabs === 'function') renderRecipientTabs();
                            if (typeof renderRecipientCalendar === 'function') renderRecipientCalendar();
                            if (typeof updateRecipientHomeTasks === 'function') updateRecipientHomeTasks();
                            if (typeof loadTasksForDate === 'function' && typeof renderCalendar === 'function' && selectedCalendarDate) {
                                loadTasksForDate(selectedCalendarDate);
                                renderCalendar();
                            }
                            if (typeof renderTaskConfigRecipientSelector === 'function') renderTaskConfigRecipientSelector();
                        }
                        break;
                    case 'task:toggle':
                        if (event.data && event.data.recipient && event.data.taskName) {
                            const tasks = recipientTasksData[event.data.recipient];
                            if (tasks) {
                                const task = tasks.find(t => t.name === event.data.taskName);
                                if (task) {
                                    task.completed = event.data.completed;
                                    task.updatedAt = event.timestamp;
                                    if (event.data.completed && !task.completedDates) task.completedDates = [];
                                    if (event.data.completed) {
                                        const today = formatDate(new Date());
                                        if (!task.completedDates.includes(today)) task.completedDates.push(today);
                                    }
                                    DataStore.save('tasks', recipientTasksData);
                                }
                            }
                            if (typeof loadRecipientTasks === 'function' && currentRecipientView === event.data.recipient) loadRecipientTasks();
                            if (typeof renderRecipientDetail === 'function' && currentSelectedRecipient) renderRecipientDetail(currentSelectedRecipient);
                            if (typeof renderRecipientTabs === 'function') renderRecipientTabs();
                            if (typeof renderRecipientCalendar === 'function') renderRecipientCalendar();
                            if (typeof updateRecipientHomeTasks === 'function') updateRecipientHomeTasks();
                            if (typeof loadTasksForDate === 'function' && typeof renderCalendar === 'function' && selectedCalendarDate) {
                                loadTasksForDate(selectedCalendarDate);
                                renderCalendar();
                            }
                            if (typeof renderTaskConfigRecipientSelector === 'function') renderTaskConfigRecipientSelector();
                        }
                        break;
                    case 'task:delete':
                        if (event.data && event.data.recipient && event.data.taskName) {
                            if (recipientTasksData[event.data.recipient]) {
                                recipientTasksData[event.data.recipient] = recipientTasksData[event.data.recipient].filter(t => t.name !== event.data.taskName);
                                DataStore.save('tasks', recipientTasksData);
                            }
                            if (typeof loadRecipientTasks === 'function' && currentRecipientView === event.data.recipient) loadRecipientTasks();
                            if (typeof renderRecipientDetail === 'function' && currentSelectedRecipient) renderRecipientDetail(currentSelectedRecipient);
                            if (typeof renderRecipientTabs === 'function') renderRecipientTabs();
                            if (typeof renderRecipientCalendar === 'function') renderRecipientCalendar();
                            if (typeof updateRecipientHomeTasks === 'function') updateRecipientHomeTasks();
                            if (typeof loadTasksForDate === 'function' && typeof renderCalendar === 'function' && selectedCalendarDate) {
                                loadTasksForDate(selectedCalendarDate);
                                renderCalendar();
                            }
                            if (typeof renderTaskConfigRecipientSelector === 'function') renderTaskConfigRecipientSelector();
                        }
                        break;
                    case 'mood:add':
                        if (event.data && event.data.record) {
                            if (!window.moodRecords) window.moodRecords = [];
                            event.data.record.synced = true;
                            window.moodRecords.push(event.data.record);
                            if (typeof renderDailyMoodList === 'function') renderDailyMoodList();
                        }
                        break;
                    case 'checkin:morning':
                    case 'checkin:evening':
                        if (event.data && event.data.record) {
                            if (!window.moodRecords) window.moodRecords = [];
                            window.moodRecords.push(event.data.record);
                            if (typeof renderDailyMoodList === 'function') renderDailyMoodList();
                        }
                        break;
                    case 'emergency:help':
                        this._dispatch('emergency:received', event.data);
                        break;
                    case 'health:add':
                        if (event.data && event.data.recipient && event.data.record) {
                            if (!healthRecordsData[event.data.recipient]) healthRecordsData[event.data.recipient] = [];
                            healthRecordsData[event.data.recipient].push(event.data.record);
                            DataStore.save('healthRecords', healthRecordsData);
                            if (typeof renderGuardianHealthCharts === 'function') renderGuardianHealthCharts();
                            if (typeof renderRecipientHealthCharts === 'function') renderRecipientHealthCharts();
                        }
                        break;
                    case 'recipient:add':
                        if (event.data && event.data.recipient) {
                            if (!recipientsData.find(r => r.id === event.data.recipient.id)) {
                                recipientsData.push(event.data.recipient);
                                DataStore.save('recipients', recipientsData);
                            }
                            if (event.data.typeInfo && event.data.name) {
                                if (!recipientTypeInfo[event.data.name]) {
                                    recipientTypeInfo[event.data.name] = event.data.typeInfo;
                                }
                            }
                            if (!currentSelectedRecipient) {
                                currentSelectedRecipient = event.data.name;
                            }
                            if (!recipientTasksData[event.data.name]) {
                                recipientTasksData[event.data.name] = [];
                            }
                            var editName = event.data.name;
                            var editType = event.data.typeInfo || 'elder';
                            setTimeout(function() {
                                if (typeof editRecipient === 'function') {
                                    editRecipient(editName);
                                }
                            }, 300);
                        }
                        break;
                    case 'recipient:update':
                        if (event.data && event.data.name) {
                            var newName = event.data.name;
                            var oldName = event.data.oldName;
                            if (oldName && oldName !== newName) {
                                recipientTasksData[newName] = recipientTasksData[oldName] || [];
                                delete recipientTasksData[oldName];
                                recipientTypeInfo[newName] = recipientTypeInfo[oldName] || { type: event.data.type || 'elder' };
                                delete recipientTypeInfo[oldName];
                                if (window.recipientAvatars && window.recipientAvatars[oldName]) {
                                    window.recipientAvatars[newName] = window.recipientAvatars[oldName];
                                    delete window.recipientAvatars[oldName];
                                }
                                if (window.recipientEmojis && window.recipientEmojis[oldName]) {
                                    window.recipientEmojis[newName] = window.recipientEmojis[oldName];
                                    delete window.recipientEmojis[oldName];
                                }
                                if (currentSelectedRecipient === oldName) {
                                    currentSelectedRecipient = newName;
                                }
                                if (typeof currentRecipientView !== 'undefined' && currentRecipientView === oldName) {
                                    currentRecipientView = newName;
                                }
                                if (typeof currentTaskRecipient !== 'undefined' && currentTaskRecipient === oldName) {
                                    currentTaskRecipient = newName;
                                }
                                if (typeof currentCalendarRecipient !== 'undefined' && currentCalendarRecipient === oldName) {
                                    currentCalendarRecipient = newName;
                                }
                                DataStore.save('tasks', recipientTasksData);
                                DataStore.save('recipients', recipientsData);
                            }
                        }
                        break;
                }

                if (typeof renderRecipientTabs === 'function') renderRecipientTabs();
                if (typeof renderRecipientDetail === 'function' && currentSelectedRecipient) renderRecipientDetail(currentSelectedRecipient);
                if (typeof updateRecipientHomeTasks === 'function') updateRecipientHomeTasks();
                if (typeof renderRecipientManagementList === 'function') renderRecipientManagementList();
                if (typeof renderPairingsList === 'function') renderPairingsList();
                if (typeof populatePairingSelects === 'function') populatePairingSelects();
            },

            _requestFullSync() {
                this._send({ type: 'full_sync_request', from: this.deviceId, timestamp: Date.now() });
            },

            _handleFullSyncRequest(data) {
                const syncData = {
                    tasks: recipientTasksData,
                    moodRecords: window.moodRecords || [],
                    healthRecords: healthRecordsData || {},
                    pairings: pairingsData,
                    guardians: guardiansData,
                    recipients: recipientsData,
                    recipientTypeInfo: recipientTypeInfo
                };
                this._send({ type: 'full_sync_response', from: this.deviceId, timestamp: Date.now(), data: syncData });
            },

            _handleFullSyncResponse(data) {
                if (!data.data) return;
                console.log('[P2P] Full sync received, merging data...');
                this._mergeFullSync(data.data);
                this._dispatch('p2p:syncComplete', { timestamp: data.timestamp });
            },

            _mergeFullSync(remoteData) {
                if (remoteData.tasks) {
                    Object.keys(remoteData.tasks).forEach(name => {
                        if (!recipientTasksData[name]) {
                            recipientTasksData[name] = remoteData.tasks[name];
                        } else {
                            remoteData.tasks[name].forEach(remoteTask => {
                                const localIdx = recipientTasksData[name].findIndex(t => t.id === remoteTask.id);
                                if (localIdx === -1) {
                                    recipientTasksData[name].push(remoteTask);
                                } else {
                                    const localTask = recipientTasksData[name][localIdx];
                                    if (remoteTask.updatedAt && (!localTask.updatedAt || remoteTask.updatedAt > localTask.updatedAt)) {
                                        recipientTasksData[name][localIdx] = remoteTask;
                                    }
                                }
                            });
                        }
                    });
                    DataStore.save('tasks', recipientTasksData);
                }

                if (remoteData.recipientTypeInfo) {
                    Object.keys(remoteData.recipientTypeInfo).forEach(name => {
                        if (!recipientTypeInfo[name]) {
                            recipientTypeInfo[name] = remoteData.recipientTypeInfo[name];
                        }
                    });
                }

                if (remoteData.recipients && remoteData.recipients.length > 0) {
                    remoteData.recipients.forEach(r => {
                        if (!recipientsData.find(local => local.id === r.id)) {
                            recipientsData.push(r);
                        }
                    });
                    DataStore.save('recipients', recipientsData);
                }

                if (remoteData.guardians && remoteData.guardians.length > 0) {
                    remoteData.guardians.forEach(g => {
                        if (!guardiansData.find(local => local.id === g.id)) {
                            guardiansData.push(g);
                        }
                    });
                    DataStore.save('guardians', guardiansData);
                }

                if (remoteData.pairings && remoteData.pairings.length > 0) {
                    remoteData.pairings.forEach(p => {
                        if (!pairingsData.find(local => local.id === p.id)) {
                            pairingsData.push(p);
                        }
                    });
                    DataStore.save('pairings', pairingsData);
                }

                if (!currentSelectedRecipient) {
                    var names = Object.keys(recipientTasksData);
                    if (names.length > 0) {
                        currentSelectedRecipient = names[0];
                    }
                }
                if (!currentTaskRecipient && currentSelectedRecipient) {
                    currentTaskRecipient = currentSelectedRecipient;
                }
                if (!currentCalendarRecipient && currentSelectedRecipient) {
                    currentCalendarRecipient = currentSelectedRecipient;
                }

                if (typeof renderRecipientTabs === 'function') renderRecipientTabs();
                if (typeof renderRecipientDetail === 'function' && currentSelectedRecipient) renderRecipientDetail(currentSelectedRecipient);
                if (typeof renderRecipientManagementList === 'function') renderRecipientManagementList();
                if (typeof renderPairingsList === 'function') renderPairingsList();
                if (typeof populatePairingSelects === 'function') populatePairingSelects();
                if (typeof updateRecipientHomeTasks === 'function') updateRecipientHomeTasks();
            },

            emit(type, data) {
                const event = { type, data, source: this.deviceId, timestamp: Date.now() };
                if (this.isConnected && this._useSig && this._sigDc) {
                    this._sendSyncEvent(event);
                } else if (MqttSignaling && MqttSignaling.send) {
                    MqttSignaling.send(JSON.stringify({ type: 'sync_event', from: this.deviceId, payload: event }));
                }
                if (Object.keys(this._pairedRooms).length > 0) {
                    MultiRelayBus.broadcast({ type: 'sync_event', from: this.deviceId, payload: event });
                }
                localStorage.setItem('guardian_sync_' + Date.now(), JSON.stringify(event));
                setTimeout(() => {
                    localStorage.removeItem('guardian_sync_' + event.timestamp);
                }, 1000);
                this._dispatch(type, data);
            },

            _sendSyncEvent(event) {
                this._send({ type: 'sync_event', from: this.deviceId, payload: event });
            },

            _sendQueuedEvents() {
            },

            addPairedRecipient(code, recipientName) {
                this._pairedRooms[code] = { recipient: recipientName, addedAt: Date.now() };
                MultiRelayBus.joinRoom(code);
                console.log('[P2P] 多配对: 已关联房间 ' + code + ' -> ' + recipientName);
                this._persistRooms();
            },

            removePairedRecipient(code) {
                delete this._pairedRooms[code];
                MultiRelayBus.leaveRoom(code);
                console.log('[P2P] 多配对: 移除房间 ' + code);
                this._persistRooms();
            },

            getPairedRecipients() {
                var list = [];
                for (var code in this._pairedRooms) {
                    if (this._pairedRooms.hasOwnProperty(code)) {
                        list.push({ code: code, recipient: this._pairedRooms[code].recipient, addedAt: this._pairedRooms[code].addedAt });
                    }
                }
                return list;
            },

            _persistRooms() {
                try {
                    localStorage.setItem('guardian_paired_rooms', JSON.stringify(this._pairedRooms));
                } catch(e) { console.warn('[P2P] persistRooms error:', e); }
            },

            _loadPersistedRooms() {
                try {
                    var stored = localStorage.getItem('guardian_paired_rooms');
                    if (stored) {
                        var rooms = JSON.parse(stored);
                        var count = 0;
                        for (var code in rooms) {
                            if (rooms.hasOwnProperty(code)) {
                                this._pairedRooms[code] = rooms[code];
                                MultiRelayBus.joinRoom(code);
                                count++;
                            }
                        }
                        if (count > 0) {
                            console.log('[P2P] 加载 ' + count + ' 个已保存配对');
                            showToast('🔄 正在恢复 ' + count + ' 个配对连接...');
                        }
                    }
                } catch(e) { console.warn('[P2P] _loadPersistedRooms error:', e); }
            },

            _send(data) {
                if (this._demoMode) {
                    console.log('[P2P DEMO] _send skipped (local mode):', data.type);
                    return;
                }
                if (this._useSig && this._sigDc) {
                    try {
                        this._sigDc.send(data);
                    } catch(e) {
                        console.error('[P2P] Send error:', e);
                    }
                }
            },

            _startHeartbeat() {
                this._stopHeartbeat();
                this.heartbeatTimer = setInterval(() => {
                    if (this.isConnected && this._sigDc) {
                        this._send({ type: 'heartbeat', from: this.deviceId, timestamp: Date.now() });
                    }
                    // 心跳超时检测：8s内未收到ack则记录一次missed
                    if (this.heartbeatAckTimer) clearTimeout(this.heartbeatAckTimer);
                    this.heartbeatAckTimer = setTimeout(() => {
                        this.missedHeartbeats = (this.missedHeartbeats || 0) + 1;
                        console.warn('[P2P] 心跳丢失 #' + this.missedHeartbeats + '/' + this.MAX_MISSED_HEARTBEATS);
                        if (this.missedHeartbeats >= this.MAX_MISSED_HEARTBEATS) {
                            console.warn('[P2P] 心跳超时，触发断开重连');
                            this.missedHeartbeats = 0;
                            this._dispatch('p2p:disconnected', { reason: 'heartbeat_timeout' });
                        }
                    }, this.HEARTBEAT_TIMEOUT);
                }, this.HEARTBEAT_INTERVAL);
            },

            _stopHeartbeat() {
                if (this.heartbeatTimer) {
                    clearInterval(this.heartbeatTimer);
                    this.heartbeatTimer = null;
                }
            },

            _attemptReconnect() {
                console.log('[P2P] Reconnect requested');
                // 清理旧连接状态，防止状态冲突
                this._cleanupConnection();
                this._peerJoined = false;
                this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
                // 指数退避: 2s, 4s, 8s, 16s, 32s, 60s(max)
                if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
                var delay = Math.min(2000 * Math.pow(2, this._reconnectAttempts - 1), 60000);
                console.log('[P2P] 重连尝试 #' + this._reconnectAttempts + ', 延迟 ' + delay + 'ms, role=' + (this.isHost ? 'host' : 'client'));
                this.reconnectTimer = setTimeout(() => {
                    if (this.authCode) {
                        var st = document.getElementById('reconnectStatus');
                        if (st) st.textContent = '重连中 (' + this._reconnectAttempts + ')...';
                        // 根据 isHost 选择角色，确保守护端以 host 角色重连
                        this._enterRelaySignaling(this.isHost ? 'host' : 'client', this.authCode);
                    }
                }, delay);
            },

            _persistConnection() {
                try {
                    const connInfo = {
                        authCode: this.authCode,
                        authPassword: this.authPassword || null,
                        isHost: this.isHost,
                        peerId: this.peerId,
                        expiresAt: this.authCodeExpiry || (Date.now() + this.AUTH_CODE_TTL),
                        connectedAt: Date.now()
                    };
                    localStorage.setItem('guardian_p2p_connection', JSON.stringify(connInfo));
                } catch(e) { console.warn('[P2P] _persistConnection error:', e); }
            },

            _loadPersistedConnection() {
                try {
                    const stored = localStorage.getItem('guardian_p2p_connection');
                    if (stored) {
                        const connInfo = JSON.parse(stored);
                        this._dispatch('p2p:previousConnection', connInfo);
                    }
                } catch(e) { console.warn('[P2P] _loadPersistedConnection error:', e); }
            },

            disconnect() {
                this._stopHeartbeat();
                this._stopConnectionMonitor();
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }
                this.isConnected = false;
                this._demoMode = false;
                MultiRelayBus.close();
                this._dispatch('p2p:disconnected', {});
            },

            getStatus() {
                return {
                    isConnected: this.isConnected,
                    isHost: this.isHost,
                    authCode: this.authCode,
                    authCodeExpiry: this.authCodeExpiry,
                    peerId: this.peerId,
                    _connecting: this._connecting,
                    connectionLatency: this.connectionLatency,
                    networkOnline: this.networkOnline,
                    missedHeartbeats: this.missedHeartbeats,
                    connectionStage: this.connectionStage,
                    connectionStartTime: this.connectionStartTime,
                    connectionUptime: this.connectionStartTime ? Date.now() - this.connectionStartTime : 0
                };
            },

            // 网络诊断和测试API
            testNetworkConnectivity() {
                console.log('[P2P] 🌐 Testing network connectivity...');
                return new Promise((resolve) => {
                    const tests = {
                        online: navigator.onLine,
                        startTime: Date.now(),
                        results: []
                    };
                    
                    // 测试基本网络连接
                    if (navigator.onLine) {
                        tests.results.push({ test: 'online_check', status: 'success' });
                    } else {
                        tests.results.push({ test: 'online_check', status: 'failed', message: '浏览器检测到网络离线' });
                    }
                    
                    // 检查连接状态
                    if (this.isConnected) {
                        tests.results.push({ test: 'p2p_connection', status: 'success', latency: this.connectionLatency });
                    } else {
                        tests.results.push({ test: 'p2p_connection', status: 'not_connected' });
                    }
                    
                    tests.results.push({ test: 'connection_quality', status: 'unknown' });
                    tests.totalTime = Date.now() - tests.startTime;
                    
                    console.log('[P2P] 📊 Network test results:', tests);
                    resolve(tests);
                });
            },

            // 网络类型检测
            getNetworkType() {
                const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
                if (connection) {
                    return {
                        type: connection.type,
                        effectiveType: connection.effectiveType,
                        downlink: connection.downlink,
                        rtt: connection.rtt,
                        saveData: connection.saveData
                    };
                }
                return { type: 'unknown' };
            },

            // 发送测试数据包
            sendTestPacket() {
                if (!this.isConnected) {
                    console.warn('[P2P] ❌ Cannot send test packet - not connected');
                    return false;
                }
                
                const testPacket = {
                    type: 'test_packet',
                    from: this.deviceId,
                    timestamp: Date.now(),
                    randomData: Math.random().toString(36).substring(7)
                };
                
                console.log('[P2P] 📤 Sending test packet:', testPacket);
                this._send(testPacket);
                return true;
            },

            // 连接诊断报告
            generateDiagnosticReport() {
                const report = {
                    timestamp: Date.now(),
                    deviceId: this.deviceId,
                    status: this.getStatus(),
                    networkType: this.getNetworkType(),
                    config: this.getPeerConfig(),
                    iceServers: this.getIceServers()
                };
                
                console.log('[P2P] 📋 Diagnostic Report:', report);
                return report;
            },

            // 获取ICE服务器列表
            getIceServers() {
                const config = this.getPeerConfig();
                return config.config.iceServers;
            },

            on(type, callback) {
                if (!this.listeners[type]) this.listeners[type] = [];
                this.listeners[type].push(callback);
            },

            off(type, callback) {
                if (!this.listeners[type]) return;
                this.listeners[type] = this.listeners[type].filter(cb => cb !== callback);
            },

            _dispatch(type, data) {
                if (this.listeners[type]) {
                    this.listeners[type].forEach(cb => {
                        try { cb(data); } catch(e) { console.error('[P2P] Listener error:', e); }
                    });
                }
            }
        };
        window.RealTimeSync = RealTimeSync;

        // ========== MQTT信令中继（通过免费公共MQTT Broker自动交换SDP，零配置）==========
        // EMQX 免费公共 MQTT Broker，国内可访问，无需注册
        // 流程：生成6位密码 → 输入密码 → MQTT自动转发SDP → P2P直连建立
        const SocketIOSignaling = {
            _socket: null, _roomId: null, _isHost: false,
            _relayActive: false, _connecting: false, _peerJoined: false,
            _relayTimer: null, _fallbackTimer: null,
            _iceCandidateQueue: [],
            pc: null, dc: null,
            onconnect: null, ondata: null, ondisconnect: null,

            _baseUrl() {
                return (window.RealTimeSync && RealTimeSync._pairServer) || 'https://guardian-sig-v2.up.railway.app';
            },

            _resetPC() {
                if (this.pc) { try { this.pc.close(); } catch(e) {} this.pc = null; }
                this.dc = null;
            },

            _makePC(makeDC) {
                this._resetPC();
                var self = this;
                var iceConfig = {
                    iceServers: window.RealTimeSync ? window.RealTimeSync.getIceServers() : [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                        { urls: 'stun:stun.miwifi.com:3478' }
                    ],
                    iceCandidatePoolSize: 10,
                    bundlePolicy: 'max-bundle',
                    rtcpMuxPolicy: 'require',
                    sdpSemantics: 'unified-plan'
                };
                var pc = new RTCPeerConnection(iceConfig);
                var iceCandidates = [];
                var iceTypes = { host: 0, srflx: 0, relay: 0 };

                pc.onicecandidate = function(e) {
                    if (e.candidate) {
                        var cand = e.candidate.candidate || '';
                        var typeMatch = cand.match(/typ\s+(\w+)/);
                        var type = typeMatch ? typeMatch[1] : 'unknown';
                        iceTypes[type] = (iceTypes[type] || 0) + 1;
                        iceCandidates.push(e.candidate);
                        if (self._socket && self._socket.connected) {
                            self._socket.emit('signal_ice', { code: self._roomId, candidate: e.candidate.toJSON() });
                        }
                    }
                };

                pc.onicegatheringstatechange = function() {
                    if (pc.iceGatheringState === 'complete') {
                        console.log('[ICE] 收集完成: host=' + iceTypes.host + ', srflx=' + iceTypes.srflx + ', relay=' + iceTypes.relay);
                    }
                };

                pc.oniceconnectionstatechange = function() {
                    console.log('[ICE] 状态: ' + pc.iceConnectionState);
                    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                        if (self._relayTimer) { clearTimeout(self._relayTimer); self._relayTimer = null; }
                        if (self.dc && self.dc.readyState === 'open') {
                            if (self.onconnect) self.onconnect();
                        }
                    } else if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                        console.warn('[ICE] 连接失败, state=' + pc.iceConnectionState);
                        if (self.ondisconnect) self.ondisconnect();
                    }
                };

                pc.onconnectionstatechange = function() {
                    console.log('[WebRTC] 连接状态: ' + pc.connectionState);
                };

                pc.ondatachannel = function(e) {
                    self.dc = e.channel;
                    self._setupDC();
                };

                if (makeDC) {
                    this.dc = pc.createDataChannel('guardian-dc', { ordered: true });
                    this._setupDC();
                }
                this.pc = pc;
                this._iceCandidates = iceCandidates;
                this._iceTypes = iceTypes;
                return pc;
            },

            _setupDC() {
                if (!this.dc) return;
                var self = this;
                this.dc.onopen = function() {
                    if (self._relayTimer) { clearTimeout(self._relayTimer); self._relayTimer = null; }
                    if (self.onconnect) self.onconnect();
                };
                this.dc.onclose = function() {};
                this.dc.onerror = function(err) { console.error('[DC] error:', err); };
                this.dc.onmessage = function(e) { if (self.ondata) self.ondata(e.data); };
            },

            _waitGather(pc) {
                var self = this;
                return new Promise(function(resolve) {
                    if (pc.iceGatheringState === 'complete') {
                        console.log('[ICE] 收集完成: host=' + (self._iceTypes ? self._iceTypes.host : 0) + ', srflx=' + (self._iceTypes ? self._iceTypes.srflx : 0) + ', relay=' + (self._iceTypes ? self._iceTypes.relay : 0));
                        resolve(); return;
                    }
                    var timer = setTimeout(function() {
                        console.log('[ICE] 收集超时(12s), partial: host=' + (self._iceTypes ? self._iceTypes.host : 0) + ', srflx=' + (self._iceTypes ? self._iceTypes.srflx : 0) + ', relay=' + (self._iceTypes ? self._iceTypes.relay : 0));
                        resolve();
                    }, 12000);
                    pc.onicegatheringstatechange = function() {
                        if (pc.iceGatheringState === 'complete') {
                            clearTimeout(timer);
                            console.log('[ICE] 收集完成: host=' + (self._iceTypes ? self._iceTypes.host : 0) + ', srflx=' + (self._iceTypes ? self._iceTypes.srflx : 0) + ', relay=' + (self._iceTypes ? self._iceTypes.relay : 0));
                            resolve();
                        }
                    };
                });
            },

            // v3.0: Socket.IO 信令 - 取代 HTTP 长轮询
            connect(code, isHost) {
                this._roomId = code;
                this._isHost = isHost;
                this._relayActive = false;
                this._iceCandidateQueue = [];
                var self = this;
                var url = this._baseUrl();

                if (this._socket) { this._socket.disconnect(); this._socket = null; }

                this._socket = io(url, {
                    transports: ['websocket', 'polling'],
                    reconnection: true,
                    reconnectionAttempts: 10,
                    reconnectionDelay: 1000,
                    reconnectionDelayMax: 5000,
                    timeout: 15000
                });

                this._socket.on('connect', function() {
                    console.log('[SocketIO] 已连接, 加入房间 ' + code);
                    showToast('📡 Socket.IO已连接');
                    self._socket.emit('join_room', { code: code, role: isHost ? 'host' : 'client' });
                    self._activateRelay();
                });

                this._socket.on('peer_joined', function() {
                    console.log('[SocketIO] 对端已加入房间');
                    self._peerJoined = true;
                    showToast('👥 对端已加入');
                    if (isHost) self._startHost();
                });

                this._socket.on('signal_offer', function(data) {
                    console.log('[SocketIO] 收到 offer');
                    showToast('📨 收到连接请求');
                    if (!isHost) self._handleOffer(data.sdp);
                });

                this._socket.on('signal_answer', function(data) {
                    console.log('[SocketIO] 收到 answer');
                    showToast('📩 收到应答');
                    if (isHost) self._handleAnswer(data.sdp);
                });

                this._socket.on('signal_ice', function(data) {
                    var c = data.candidate;
                    if (!self.pc) {
                            if (self._iceCandidateQueue.length < 100) self._iceCandidateQueue.push(c);
                            return;
                        }
                    if (self.pc.remoteDescription && self.pc.remoteDescription.type) {
                        self.pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(e) { console.warn('[SocketIO] addIceCandidate error:', e); });
                    } else {
                        self._iceCandidateQueue.push(c);
                    }
                });

                this._socket.on('relay_data', function(data) {
                    if (self._relayActive && self.ondata) {
                        self.ondata(data.payload);
                    }
                });

                this._socket.on('peer_disconnected', function() {
                    console.warn('[SocketIO] 对端断开');
                    if (self.ondisconnect) self.ondisconnect();
                });

                this._socket.on('disconnect', function(reason) {
                    console.warn('[SocketIO] 断开: ' + reason);
                });

                this._socket.on('connect_error', function(err) {
                    console.warn('[SocketIO] 连接错误:', err.message);
                    showToast('⚠️ 服务器连接失败，正在重试...(' + (self._socket && self._socket._reconnections || 0) + '/' + 10 + ')');
                });

                console.log('[SocketIO] 启动信令, code=' + code + ', role=' + (isHost ? 'host' : 'client'));
                showToast(isHost ? '🔄 等待对方连接...' : '🔄 正在连接...');
            },

            async _startHost() {
                showToast('🔧 开始创建连接...');
                var pc = this._makePC(true);
                this._iceCandidateQueue = [];
                var self = this;
                try {
                    var offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    await this._waitGather(pc);
                    if (this._socket && this._socket.connected) {
                        this._socket.emit('signal_offer', { code: this._roomId, sdp: pc.localDescription.sdp });
                    }
                } catch(e) { console.error('[SocketIO] offer error:', e); }
            },

            async _handleOffer(sdp) {
                var pc = this._makePC(false);
                var self = this;
                try {
                    await pc.setRemoteDescription({type:'offer', sdp:sdp});
                    self._flushIceQueue();
                    var answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    await this._waitGather(pc);
                    if (this._socket && this._socket.connected) {
                        this._socket.emit('signal_answer', { code: this._roomId, sdp: pc.localDescription.sdp });
                    }
                } catch(e) { console.error('[SocketIO] answer error:', e); }
            },

            async _handleAnswer(sdp) {
                showToast('📩 处理应答...');
                try {
                    await this.pc.setRemoteDescription({type:'answer', sdp:sdp});
                    this._flushIceQueue();
                } catch(e) { console.error('[SocketIO] complete error:', e); }
            },

            _flushIceQueue() {
                if (this._iceCandidateQueue.length === 0) return;
                var queue = this._iceCandidateQueue;
                this._iceCandidateQueue = [];
                queue.forEach(function(c) {
                    if (this.pc) this.pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(e) { console.warn('[SocketIO] flushIce error:', e); });
                }, this);
            },

            _activateRelay() {
                if (this._relayActive) { return; }
                this._relayActive = true;
                console.log('[SocketIO] 激活中继模式(热备)');
                if (this._relayTimer) { clearTimeout(this._relayTimer); this._relayTimer = null; }
                var self = this;
                self._relayDc = {
                    readyState: 'open',
                    send: function(data) {
                        if (self._socket && self._socket.connected) {
                            var msg = typeof data === 'string' ? data : JSON.stringify(data);
                            self._socket.emit('relay_data', { code: self._roomId, payload: msg });
                            return true;
                        }
                        return false;
                    },
                    close: function() { self._relayActive = false; }
                };
                showToast('🔁 已启用中继热备');
                this._relayTimer = setTimeout(function() {
                    if (window.RealTimeSync && !RealTimeSync.isConnected) {
                        if (!self._peerJoined) {
                            console.log('[P2P v4.5.1] 对端未加入，跳过中继降级');
                            return;
                        }
                        console.log('[P2P v4.3.5] WebRTC超时(15s)，中继降级接管');
                        showToast('🔁 中继降级接管');
                        RealTimeSync._connectSig(self._relayDc);
                    }
                }, 15000);
            },

            send(data) {
                var msg = typeof data === 'string' ? data : JSON.stringify(data);
                if (this._relayActive && this._socket && this._socket.connected) {
                    this._socket.emit('relay_data', { code: this._roomId, payload: msg });
                    return true;
                }
                if (this.dc && this.dc.readyState === 'open') {
                    try { this.dc.send(msg); return true; } catch(e) {}
                }
                return false;
            },

            close() {
                this._relayActive = false;
                if (this._relayTimer) { clearTimeout(this._relayTimer); this._relayTimer = null; }
                if (this._fallbackTimer) { clearTimeout(this._fallbackTimer); this._fallbackTimer = null; }
                this._resetPC();
                if (this._socket) { this._socket.disconnect(); this._socket = null; }
            }
        };

        var MqttSignaling = SocketIOSignaling;
        var mqttBrokerUrl = ''; // 废弃

        // 集成到RealTimeSync
        RealTimeSync._sigDc = null;
        RealTimeSync._useSig = false;
        RealTimeSync._connectSig = function(dc) {
            var self = this;
            var isWebrtc = (dc && dc.readyState === 'open' && dc.send && !dc._relayDc);
            if (this.isConnected) {
                if (isWebrtc) {
                    console.log('[P2P v4.3.0] WebRTC已就绪，切换为主通道');
                    this._sigDc = dc;
                    dc.onmessage = function(e) { try { self._handleIncomingData(JSON.parse(e.data)); } catch(err) {} };
                }
                return;
            }
            this._sigDc = dc; this._useSig = true;
            this._connecting = false;
            dc.onmessage = function(e) { try { self._handleIncomingData(JSON.parse(e.data)); } catch(err) {} };
            dc.onclose = function() {
                if (SocketIOSignaling._relayActive && SocketIOSignaling._relayDc && SocketIOSignaling._relayDc.readyState === 'open') {
                    console.log('[P2P v4.3.0] WebRTC断开，中继热备接管');
                    RealTimeSync._sigDc = SocketIOSignaling._relayDc;
                    return;
                }
                self.isConnected = false;
                self._dispatch('p2p:disconnected', {});
            };
            SocketIOSignaling.ondata = function(data) {
                if (RealTimeSync && RealTimeSync._sigDc && RealTimeSync._sigDc.onmessage) {
                    RealTimeSync._sigDc.onmessage({ data: data });
                }
            };
            this.isConnected = true;
            this._dualRelayActive = true;
            this._dispatch('p2p:connected', {});
            this._dispatch('p2p:networkStatus', { online: true });
            this._persistConnection();
        };
        var _origSend3 = RealTimeSync._send;
        RealTimeSync._send = function(data) {
                if (!data) return;
                if (typeof data === 'string') { try { data = JSON.parse(data); } catch(e) { return; } }
                this._msgSeq = (this._msgSeq || 0) + 1;
                data._msgSeq = this._msgSeq;
                data.from = data.from || this.deviceId;
                var msg = JSON.stringify(data);
                var sent = false;
                if (this._useSig && this._sigDc && this._sigDc.readyState === 'open') {
                    try { this._sigDc.send(msg); sent = true; } catch(e) { console.warn('[P2P] _sigDc.send 失败:', e); }
                }
                if (SocketIOSignaling._relayActive && SocketIOSignaling._relayDc && SocketIOSignaling._relayDc.readyState === 'open') {
                    try { SocketIOSignaling._relayDc.send(msg); sent = true; } catch(e) { console.warn('[P2P] relayDc.send 失败:', e); }
                }
                if (MqttSignaling && MqttSignaling.send && MqttSignaling.send(data)) { sent = true; }
                if (!sent) {
                    this._offlineQueue = this._offlineQueue || [];
                    this._offlineQueue.push(data);
                    if (this._offlineQueue.length > 100) this._offlineQueue.shift();
                    try { localStorage.setItem('guardian_offline_queue', JSON.stringify(this._offlineQueue)); } catch(e) { console.warn('[P2P] offline queue persist error:', e); }
                    if (_origSend3) { _origSend3.call(this, data); }
                }
            };
        var _origDisconnect3 = RealTimeSync.disconnect;
        RealTimeSync.disconnect = function() {
            this._stopHeartbeat();
            if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
            if (this._useSig && this._sigDc) { try { MqttSignaling.close(); } catch(e) { console.warn('[P2P] MqttSignaling.close error:', e); } this._sigDc = null; this._useSig = false; }
            this.isConnected = false; this.authCode = null; this.authCodeExpiry = null;
            localStorage.removeItem('guardian_p2p_connection');
            this._dispatch('p2p:disconnected', {});
        };