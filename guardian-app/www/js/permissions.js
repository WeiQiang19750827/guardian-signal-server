// ========== 权限管理模块 v4.5.7 ==========
const PermissionManager = {
    async requestNotificationPermission() {
        if (!('Notification' in window)) return false;
        if (Notification.permission === 'granted') return true;
        if (Notification.permission === 'denied') return false;
        const result = await Notification.requestPermission();
        return result === 'granted';
    },
    
    _checkLocationGranted() {
        return new Promise(function(resolve) {
            // 先检查cordova是否可用
            if (typeof cordova === 'undefined' || !cordova.plugins || !cordova.plugins.permissions) {
                console.log('[Perm] Cordova not ready, assuming not granted');
                resolve(false);
                return;
            }
            // 加入5秒超时，防止回调永不触发导致死等（Cordova Android 15 已知问题）
            var _to = setTimeout(function() {
                console.warn('[Perm] checkPermission timed out');
                resolve(false);
            }, 5000);
            cordova.plugins.permissions.checkPermission(
                cordova.plugins.permissions.ACCESS_FINE_LOCATION,
                function(s) { clearTimeout(_to); resolve(s.hasPermission); },
                function() { clearTimeout(_to); resolve(false); }
            );
        });
    },

    async requestLocationPermission() {
        if (typeof cordova !== 'undefined' && cordova.plugins && cordova.plugins.permissions) {
            console.log('[Perm] Using native permission API');
            var already = await this._checkLocationGranted();
            if (already) { console.log('[Perm] already granted'); return true; }
            cordova.plugins.permissions.requestPermission(
                cordova.plugins.permissions.ACCESS_FINE_LOCATION,
                function(){}, function(){}
            );
            // 缩短轮询超时到15秒，避免界面卡死
            var deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                await new Promise(function(r) { setTimeout(r, 500); });
                var granted = await this._checkLocationGranted();
                if (granted) { console.log('[Perm] granted via polling'); return true; }
            }
            console.log('[Perm] polling timeout - permission not granted');
            return false;
        }
        console.log('[Perm] Falling back to browser API');
        if (!navigator.geolocation) { console.log('[Perm] geolocation API not available'); return false; }
        try {
            if (navigator.permissions && navigator.permissions.query) {
                var permState = await navigator.permissions.query({ name: 'geolocation' });
                console.log('[Perm] geolocation state:', permState.state);
                if (permState.state === 'granted') return true;
                if (permState.state === 'denied') { console.log('[Perm] geolocation already denied'); return false; }
            }
        } catch(e) { console.log('[Perm] permissions.query error:', e); }
        return new Promise(function(resolve) {
            var _t = setTimeout(function() { console.log('[Perm] browser getCurrentPosition timeout'); resolve(false); }, 30000);
            navigator.geolocation.getCurrentPosition(
                function(pos) { console.log('[Perm] geolocation success'); clearTimeout(_t); resolve(true); },
                function(err) { console.log('[Perm] geolocation error:', err.code, err.message); clearTimeout(_t); resolve(false); },
                { enableHighAccuracy: false, timeout: 25000, maximumAge: 120000 }
            );
        });
    },

    _withTimeout(promise, ms, fallback) {
        return Promise.race([
            promise,
            new Promise(function(r){ setTimeout(function(){ r(fallback); }, ms); })
        ]);
    },
    
    async requestAllPermissions() {
        var self = this;
        var results = {};
        // 每个权限都有独立超时，整体不超过 10 秒
        results.notification = await self._withTimeout(self.requestNotificationPermission(), 2000, false);
        results.location = await self._withTimeout(self.requestLocationPermission(), 8000, false);
        results.background = await self._withTimeout(self.requestBackgroundPermission(), 2000, false);
        results.camera = false;
        results.audio = false;
        return results;
    },
    
    async requestBackgroundPermission() {
        // Android后台运行权限 - REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
        if (typeof cordova !== 'undefined' && cordova.plugins && cordova.plugins.permissions) {
            var permissions = cordova.plugins.permissions;
            // 尝试申请后台位置权限
            return new Promise(function(resolve) {
                // Android 10+ 需要 ACCESS_BACKGROUND_LOCATION
                if (permissions.ACCESS_BACKGROUND_LOCATION) {
                    permissions.requestPermission(permissions.ACCESS_BACKGROUND_LOCATION, function(status) {
                        if (status.hasPermission) {
                            console.log('[Perm] Background location permission granted');
                            resolve(true);
                        } else {
                            // 即使后台权限被拒绝，也尝试其他方式
                            console.log('[Perm] Background location permission denied, trying alternatives');
                            resolve(false);
                        }
                    }, function() {
                        resolve(false);
                    });
                } else {
                    // 如果没有后台位置权限，尝试请求电池优化豁免
                    resolve(false);
                }
            });
        }
        return Promise.resolve(false);
    },

    showPermissionPrompt() {
        // 权限弹窗已在静态 HTML 中，只需确保按钮处理器正确
        console.log('[Perm] showPermissionPrompt called (re-binding handlers)');
        var existing = document.getElementById('permissionPrompt');
        if (!existing) {
            // 静态HTML不存在时的兜底 - 动态创建
            console.log('[Perm] Static prompt not found, creating dynamically');
            var msg = document.createElement('div');
            msg.id = 'permissionPrompt';
            msg.style.cssText = 'display:flex;position:fixed;top:0;left:0;right:0;bottom:0;z-index:100001;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;';
            msg.innerHTML = '<div style="background:white;border-radius:24px;padding:30px 20px;max-width:360px;width:88%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3);animation:fadeInUp 0.3s ease;">' +
                '<div style="font-size:48px;margin-bottom:15px;">🛡️</div>' +
                '<div style="font-size:20px;font-weight:700;color:#111827;margin-bottom:8px;">权限申请</div>' +
                '<div style="font-size:14px;color:#6B7280;margin-bottom:20px;line-height:1.5;">为了让守护者App正常工作，请允许以下权限：</div>' +
                '<div id="permList" style="text-align:left;margin-bottom:20px;padding:0 5px;">' +
                '<div id="perm-location" style="padding:8px 0;font-size:14px;color:#6B7280;">📍 定位权限 — 用于位置守护</div>' +
                '<div id="perm-background" style="padding:8px 0;font-size:14px;color:#6B7280;">🔋 后台运行权限 — 确保位置实时守护</div>' +
                '<div id="perm-notification" style="padding:8px 0;font-size:14px;color:#6B7280;">🔔 通知权限 — 用于任务提醒</div>' +
                '<div id="perm-camera" style="padding:8px 0;font-size:14px;color:#6B7280;">📷 相机权限 — 使用相机时自动申请</div>' +
                '<div id="perm-audio" style="padding:8px 0;font-size:14px;color:#6B7280;">🎤 录音权限 — 使用录音时自动申请</div>' +
                '</div>' +
                '<button id="permGrantBtn" style="width:100%;padding:14px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;border:none;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer;">一键授权</button>' +
                '<div style="margin-top:8px;"><button id="permSkipBtn" style="background:none;border:none;color:#9CA3AF;font-size:13px;cursor:pointer;padding:8px;">跳过，稍后设置</button></div>' +
                '</div>';
            document.body.appendChild(msg);
            console.log('[Perm] Dynamic prompt added to DOM');
        } else {
            existing.style.display = 'flex';
        }
        // 绑定按钮处理器（复用 _execPermRequest）
        var gb = document.getElementById('permGrantBtn');
        if (gb) {
            gb._earlyBound = true; // 标记已绑定
            gb.onclick = function() {
                var btn = document.getElementById('permGrantBtn');
                if (btn.disabled) return;
                if (typeof window._execPermRequest === 'function') {
                    window._execPermRequest(btn);
                } else {
                    // 兜底：直接调用
                    btn.textContent = '⏳ 授权中...';
                    btn.disabled = true;
                    PermissionManager.requestAllPermissions().then(function(r) {
                        btn.textContent = '✅ 完成';
                        btn.disabled = false;
                        setTimeout(function() {
                            var p = document.getElementById('permissionPrompt');
                            if (p) p.style.display = 'none';
                        }, 1500);
                    }).catch(function() {
                        btn.textContent = '继续';
                        btn.disabled = false;
                    });
                }
            };
        }
        var sb = document.getElementById('permSkipBtn');
        if (sb) {
            sb._earlyBound = true;
            sb.onclick = function() {
                document.getElementById('permissionPrompt').style.display = 'none';
            };
        }
    },
    
    async sendLocalNotification(title, body, data) {
        const granted = await this.requestNotificationPermission();
        if (!granted) {
            showToast('⚠️ 请开启通知权限以接收重要提醒');
            return false;
        }
        if ('Notification' in window && Notification.permission === 'granted') {
            const notification = new Notification(title, {
                body: body,
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🛡️</text></svg>',
                badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🛡️</text></svg>',
                tag: data?.tag || 'guardian-notification',
                requireInteraction: data?.urgent || false,
                vibrate: data?.urgent ? [200, 100, 200, 100, 200] : [100]
            });
            notification.onclick = () => { window.focus(); notification.close(); };
            return true;
        }
        return false;
    }
};