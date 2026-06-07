// ========== 配对UI模块 v4.5.7 ==========
// 依赖: RealTimeSync (全局)

        async function handleGenerateAuthCode() {
            console.log('[UI] handleGenerateAuthCode CALLED');
            var btn = document.getElementById('generateCodeBtn');
            var display = document.getElementById('authCodeDisplay');
            var value = document.getElementById('authCodeValue');
            
            if (!btn) {
                console.error('[UI] generateCodeBtn NOT FOUND');
                showToast('❌ 按钮未找到');
                return;
            }
            if (btn.disabled) {
                console.log('[UI] generateCodeBtn is disabled, skipping');
                return;
            }
            
            // 预检测服务器连接状态
            if (!RealTimeSync._railwayHealthy) {
                showToast('📡 检测服务器连接...');
                try {
                    var healthy = await new Promise(function(resolve) {
                        RealTimeSync._checkRailwayConnection(resolve);
                    });
                    if (!healthy) {
                        showToast('❌ 服务器无法连接，请检查网络');
                        return;
                    }
                } catch(e) {
                    console.error('[UI] Server health check failed:', e);
                    showToast('❌ 服务器检测失败，请稍后重试');
                    return;
                }
            }
            
            console.log('[UI] Disabling button and starting generation');
            btn.disabled = true;
            btn.textContent = '⏳ 生成中...';
            
            try {
                // 调用generateAuthCode，等待Promise完成（带15s超时）
                console.log('[UI] Calling RealTimeSync.generateAuthCode()');
                var result = await Promise.race([
                    RealTimeSync.generateAuthCode(),
                    new Promise(function(_, reject) {
                        setTimeout(function() { reject(new Error('生成超时，请重试')); }, 15000);
                    })
                ]);
                console.log('[UI] generateAuthCode returned:', result);
                
                if (result && result.code) {
                    // 先填充内容，再显示容器，防止字体跳变
                    if (value) value.textContent = result.code;
                    var passwordValue = document.getElementById('authPasswordValue');
                    if (passwordValue) passwordValue.textContent = result.password || '';
                    if (display) display.style.display = 'block';
                    btn.textContent = '重新生成';
                    btn.style.background = '#7F8C8D';
                    updateP2PStatus();
                    updateAuthCodeExpiry();
                }
            } catch(e) {
                console.error('[UI] handleGenerateAuthCode ERROR:', e);
                showToast('❌ 生成失败: ' + (e.message || '请重试'));
                if (display) display.style.display = 'none';
            } finally {
                if (btn) {
                    btn.disabled = false;
                    if (btn.textContent === '⏳ 生成中...') {
                        btn.textContent = '生成授权码';
                        btn.style.background = '#4F46E5';
                    }
                }
            }
        }

        var authCodeExpiryTimer = null;
        function updateAuthCodeExpiry() {
            if (authCodeExpiryTimer) clearInterval(authCodeExpiryTimer);
            authCodeExpiryTimer = setInterval(function() {
                var status = RealTimeSync.getStatus();
                if (!status.authCodeExpiry) { clearInterval(authCodeExpiryTimer); return; }
                var remaining = Math.max(0, Math.ceil((status.authCodeExpiry - Date.now()) / 1000));
                var expiryEl = document.getElementById('authCodeExpiry');
                if (remaining <= 0) {
                    if (expiryEl) expiryEl.textContent = '授权码已过期，请重新生成';
                    clearInterval(authCodeExpiryTimer);
                } else {
                    var min = Math.floor(remaining / 60);
                    var sec = remaining % 60;
                    if (expiryEl) expiryEl.textContent = '有效期剩余 ' + min + ':' + (sec < 10 ? '0' : '') + sec;
                }
            }, 1000);
        }

        async function handleConnectWithCode() {
            function doConnect() {
                try {
                    var input = document.getElementById('inputAuthCode');
                    if (!input) return;
                    var code = input.value.trim();
                    if (code.length !== 6) {
                        showToast('❌ 请输入6位授权码');
                        return;
                    }
                    // 密码 = 授权码后4位，自动派生
                    var password = code.slice(-4);
                    showToast('🔄 正在连接...');
                    RealTimeSync.connectWithCode(code, password).then(function() {
                        updateP2PStatus();
                    }).catch(function(e) {
                        console.error('connectWithCode error:', e);
                        showToast('❌ 连接失败: ' + (e.message || '请重试'));
                        updateP2PStatus();
                    });
                } catch(e) {
                    console.error('handleConnectWithCode error:', e);
                    showToast('❌ 连接失败: ' + e.message);
                }
            }
            if (RealTimeSync._railwayHealthy) { doConnect(); return; }
            showToast('📡 检测服务器连接...');
            RealTimeSync._checkRailwayConnection(function(ok) {
                if (!ok) { showToast('❌ 服务器无法连接，请检查网络'); return; }
                doConnect();
            });
        }

        async function recipientConnectWithCode() {
            function doConnect() {
                try {
                    var input = document.getElementById('recipientInputAuthCode');
                    if (!input) return;
                    var code = input.value.trim();
                    if (code.length !== 6) {
                        showToast('❌ 请输入6位授权码');
                        return;
                    }
                    // 密码 = 授权码后4位，自动派生
                    var password = code.slice(-4);
                    showToast('🔄 正在连接...');
                    RealTimeSync.connectWithCode(code, password).then(function() {
                        updateP2PStatus();
                    }).catch(function(e) {
                        console.error('recipientConnectWithCode error:', e);
                        showToast('❌ 连接失败: ' + (e.message || '请重试'));
                        updateP2PStatus();
                    });
                } catch(e) {
                    console.error('recipientConnectWithCode error:', e);
                    showToast('❌ 连接失败: ' + e.message);
                }
            }
            if (RealTimeSync._railwayHealthy) { doConnect(); return; }
            showToast('📡 检测服务器连接...');
            RealTimeSync._checkRailwayConnection(function(ok) {
                if (!ok) { showToast('❌ 服务器无法连接，请检查网络'); return; }
                doConnect();
            });
        }

        function handleDisconnect() {
            RealTimeSync.disconnect();
            var display = document.getElementById('authCodeDisplay');
            if (display) display.style.display = 'none';
            var btn = document.getElementById('generateCodeBtn');
            if (btn) { btn.textContent = '生成授权码'; btn.style.background = '#4F46E5'; }
            updateP2PStatus();
            showToast('📡 已断开连接');
        }


        function updateP2PStatus() {
            updateServerStatus();
            var status = RealTimeSync.getStatus();
            var dot = document.getElementById('p2pStatusDot');
            var text = document.getElementById('p2pStatusText');
            var detail = document.getElementById('p2pStatusDetail');
            var card = document.getElementById('p2pStatusCard');
            var disconnectSection = document.getElementById('p2pDisconnectSection');
            var recipientDot = document.getElementById('recipientP2pStatusDot');
            var recipientText = document.getElementById('recipientP2pStatusText');
            var recipientDetail = document.getElementById('recipientP2pStatusDetail');
            var recipientCard = document.getElementById('recipientP2pStatusCard');
            var recipientDisconnectSection = document.getElementById('recipientP2pDisconnectSection');
            var hostSection = document.getElementById('p2pHostSection');
            var clientSection = document.getElementById('p2pClientSection');
            var recipientClientSection = document.getElementById('recipientP2pClientSection');
            if (currentRole === 'guardian' || currentRole === 'observer' || currentRole === 'demo') {
                if (hostSection) hostSection.style.display = 'block';
                if (clientSection) clientSection.style.display = 'none';
                if (recipientClientSection) recipientClientSection.style.display = 'none';
            } else if (currentRole === 'elder' || currentRole === 'child') {
                if (hostSection) hostSection.style.display = 'none';
                if (clientSection) clientSection.style.display = 'none';
                if (recipientClientSection) recipientClientSection.style.display = 'block';
            }

            var dotColor, borderColor, statusText, statusDetail, showDisconnect;

            if (status.isConnected) {
                dotColor = '#2ECC71';
                borderColor = '#2ECC71';
                statusText = '🟢 已连接';
                showDisconnect = true;
                var q = status.connectionQuality || 'unknown';
                var qInfo = {"excellent":{"icon":"🟢","label":"优秀","color":"#2ECC71"},"good":{"icon":"🟡","label":"良好","color":"#F1C40F"},"fair":{"icon":"🟠","label":"一般","color":"#E67E22"},"poor":{"icon":"🔴","label":"较差","color":"#E74C3C"},"unknown":{"icon":"⚪","label":"检测中","color":"#95A5A6"}};
                var latStr = status.connectionLatency ? ' (' + status.connectionLatency + 'ms)' : '';
                statusDetail = (status.isHost ? '监护人端' : '被监护人端') + ' | ' + (qInfo[q] ? qInfo[q].icon + ' ' + qInfo[q].label : q) + latStr;
            } else if (status.authCode && status.isHost) {
                dotColor = '#F39C12';
                borderColor = '#F39C12';
                statusText = '🟡 等待连接';
                statusDetail = '授权码: ' + status.authCode + '，等待被监护人输入';
                showDisconnect = false;
            } else if (status._connecting) {
                dotColor = '#F39C12';
                borderColor = '#F39C12';
                statusText = '🔄 正在连接...';
                statusDetail = '正在连接远程设备，请稍候...';
                showDisconnect = false;
            } else {
                dotColor = '#BDC3C7';
                borderColor = '#BDC3C7';
                statusText = '⚪ 未连接';
                statusDetail = !navigator.onLine ? '⚠️ 网络不可用，请检查网络连接' : '生成或输入授权码建立P2P连接';
                showDisconnect = false;
            }

            if (dot) dot.style.background = dotColor;
            if (text) text.textContent = statusText;
            if (detail) detail.textContent = statusDetail;
            if (card) card.style.borderLeftColor = borderColor;
            if (disconnectSection) disconnectSection.style.display = showDisconnect ? 'block' : 'none';
            if (recipientDot) recipientDot.style.background = dotColor;
            if (recipientText) recipientText.textContent = statusText;
            if (recipientDetail) recipientDetail.textContent = statusDetail;
            if (recipientCard) recipientCard.style.borderLeftColor = borderColor;
            if (recipientDisconnectSection) recipientDisconnectSection.style.display = showDisconnect ? 'block' : 'none';
        }

        // v2.0.9: 更新服务器连接状态 UI（防误报：首次检查完成前保持等待状态）
        function updateServerStatus() {
            var done = RealTimeSync._railwayCheckDone;
            var healthy = RealTimeSync._railwayHealthy;
            // 监护人端
            var dot = document.getElementById('serverStatusDot');
            var text = document.getElementById('serverStatusText');
            var badge = document.getElementById('serverStatusBadge');
            if (dot && text && badge) {
                if (!done) {
                    dot.style.background = '#BDC3C7';
                    text.textContent = '⏳ 检测服务器连接...';
                    badge.style.background = '#F0F0F0';
                    badge.style.color = '#7F8C8D';
                } else if (healthy) {
                    dot.style.background = '#2ECC71';
                    text.textContent = '✅ 已连接服务器';
                    badge.style.background = '#ECFDF5';
                    badge.style.color = '#065F46';
                } else {
                    dot.style.background = '#E74C3C';
                    text.textContent = '❌ 服务器连接失败';
                    badge.style.background = '#FEF2F2';
                    badge.style.color = '#991B1B';
                }
            }
            // 被监护人端
            var rdot = document.getElementById('recipientServerStatusDot');
            var rtext = document.getElementById('recipientServerStatusText');
            var rbadge = document.getElementById('recipientServerStatusBadge');
            if (rdot && rtext && rbadge) {
                if (!done) {
                    rdot.style.background = '#BDC3C7';
                    rtext.textContent = '⏳ 检测服务器连接...';
                    rbadge.style.background = '#F0F0F0';
                    rbadge.style.color = '#7F8C8D';
                } else if (healthy) {
                    rdot.style.background = '#2ECC71';
                    rtext.textContent = '✅ 已连接服务器';
                    rbadge.style.background = '#ECFDF5';
                    rbadge.style.color = '#065F46';
                } else {
                    rdot.style.background = '#E74C3C';
                    rtext.textContent = '❌ 服务器连接失败';
                    rbadge.style.background = '#FEF2F2';
                    rbadge.style.color = '#991B1B';
                }
            }
        }
        function autoCreatePairing(connectData) {
              try {
                  var status = RealTimeSync.getStatus();
                  var myDeviceId = RealTimeSync.deviceId;
                  if (status.isHost) {
                      var existingGuardian = guardiansData.find(function(g) { return g.id === myDeviceId; });
                      if (!existingGuardian) {
                          guardiansData.push({
                              id: myDeviceId,
                              name: ROLE_CONFIG[currentRole] ? ROLE_CONFIG[currentRole].label + '端' : '监护人',
                              avatar: ROLE_CONFIG[currentRole] ? ROLE_CONFIG[currentRole].icon : '👨‍👩‍👧‍👦',
                              role: currentRole || 'guardian',
                              phone: '',
                              relationship: '远程看护'
                          });
                          DataStore.save('guardians', guardiansData);
                      }
                  } else {
                      var rType = currentRole === 'child' ? 'child' : 'elder';
                      var recipientName = ROLE_CONFIG[currentRole] ? ROLE_CONFIG[currentRole].label + '端' : '被监护人';
                      var recipientIcon = ROLE_CONFIG[currentRole] ? ROLE_CONFIG[currentRole].icon : '👴';
                      var existingRecipient = recipientsData.find(function(r) { return r.id === myDeviceId; });
                      if (!existingRecipient) {
                          recipientsData.push({
                              id: myDeviceId,
                              name: recipientName,
                              icon: recipientIcon,
                              type: rType,
                              phone: ''
                          });
                          recipientTypeInfo[myDeviceId] = rType;
                          DataStore.save('recipients', recipientsData);
                          DataStore.save('recipientTypeInfo', recipientTypeInfo);
                      }
                      setTimeout(function() {
                          RealTimeSync.emit('recipient:add', {
                              recipient: {
                                  id: myDeviceId,
                                  name: recipientName,
                                  icon: recipientIcon,
                                  type: rType,
                                  phone: ''
                              },
                              typeInfo: rType,
                              name: recipientName
                          });
                      }, 300);
                  }
                  if (typeof currentRole !== 'undefined' && currentRole === 'demo') {
                      var demoGuardianId = 'demo-guardian';
                      var existingDemoGuardian = guardiansData.find(function(g) { return g.id === demoGuardianId; });
                      if (!existingDemoGuardian) {
                          guardiansData.push({
                              id: demoGuardianId,
                              name: '监护人端',
                              avatar: '👨',
                              role: 'guardian',
                              phone: '',
                              relationship: '远程看护'
                          });
                          DataStore.save('guardians', guardiansData);
                      }
                  }
                  if (typeof renderPairingsList === 'function') renderPairingsList();
                  if (typeof renderRecipientTabs === 'function') renderRecipientTabs();
              } catch(e) {
                  console.error('[autoCreatePairing] error:', e);
              }
          }


        function initP2PListeners() {
            RealTimeSync.on('p2p:codeReady', function(data) {
                console.log('[UI] Auth code ready:', data.code);
                var display = document.getElementById('authCodeDisplay');
                var value = document.getElementById('authCodeValue');
                if (display) display.style.display = 'block';
                if (value) value.textContent = data.code;
                updateP2PStatus();
                updateAuthCodeExpiry();
                var btn = document.getElementById('generateCodeBtn');
                if (btn) { btn.disabled = false; btn.textContent = '重新生成'; btn.style.background = '#7F8C8D'; }
            });

            RealTimeSync.on('p2p:previousConnection', function(data) {
                console.log('[UI] 发现已保存的配对信息, 自动重连');
                if (!data || !data.authCode) return;
                if (RealTimeSync.isConnected) return;
                var isExpired = data.expiresAt && Date.now() > data.expiresAt;
                if (data.isHost) {
                    RealTimeSync.isHost = true;
                    if (isExpired) {
                        console.log('[UI] 守护端配对码已过期, 自动重新生成');
                        showToast('🔄 配对码已过期，自动生成新码...');
                        RealTimeSync.generateAuthCode().then(function(result) {
                            if (result && result.code) {
                                console.log('[UI] 自动生成新授权码:', result.code);
                                var value = document.getElementById('authCodeValue');
                                var display = document.getElementById('authCodeDisplay');
                                var pwd = document.getElementById('authPasswordValue');
                                if (value) value.textContent = result.code;
                                if (pwd) pwd.textContent = result.password || '';
                                if (display) display.style.display = 'block';
                                var btn = document.getElementById('generateCodeBtn');
                                if (btn) { btn.disabled = false; btn.textContent = '重新生成'; btn.style.background = '#7F8C8D'; }
                                updateP2PStatus();
                                updateAuthCodeExpiry();
                                showToast('🔄 新配对码已生成，告知对方请输入此授权码');
                            }
                        }).catch(function(e) {
                            console.error('[UI] 自动生成授权码失败:', e);
                        });
                    } else {
                        RealTimeSync.authCode = data.authCode;
                        RealTimeSync.authPassword = data.authPassword || null;
                        RealTimeSync._enterRelaySignaling('host', data.authCode);
                        showToast('🔄 正在恢复上次连接...');
                    }
                } else {
                    RealTimeSync.isHost = false;
                    if (isExpired) {
                        console.log('[UI] 被守护端配对码已过期, 仍尝试重连(服务端24h有效)');
                    }
                    RealTimeSync.authCode = data.authCode;
                    RealTimeSync.authPassword = data.authPassword || null;
                    RealTimeSync._enterRelaySignaling('client', data.authCode);
                    showToast('🔄 正在恢复上次连接...');
                }
            });

            RealTimeSync.on('p2p:connected', function(data) {
                // 清理重连界面，重置计数器
                var overlay = document.getElementById('reconnectOverlay');
                if (overlay) overlay.style.display = 'none';
                hideReconnectPairOverlay();
                RealTimeSync._reconnectAttempts = 0;
                if (RealTimeSync.reconnectTimer) { clearTimeout(RealTimeSync.reconnectTimer); RealTimeSync.reconnectTimer = null; }
                RealTimeSync._flushingOffline = true;
                try {
                    var queue = JSON.parse(localStorage.getItem('guardian_offline_queue') || '[]');
                    if (queue.length > 0) {
                        console.log('[P2P v4.3.0] 发送离线队列:', queue.length + '条');
                        queue.forEach(function(item) { RealTimeSync._send(item); });
                        localStorage.removeItem('guardian_offline_queue');
                    }
                } catch(e) {}
                RealTimeSync._flushingOffline = false;

                console.log('[UI] P2P connected');
                try {
                    showToast('✅ P2P连接已建立！');
                    updateP2PStatus();
                    var status = RealTimeSync.getStatus();
                    if (status.isHost) {
                        setTimeout(function() {
                            RealTimeSync._requestFullSync();
                        }, 800);
                        setTimeout(function() {
                            if (typeof navigateTo === 'function') {
                                navigateTo('guardian-add-recipient');
                            }
                        }, 1200);
                    } else {
                        setTimeout(function() {
                            if (typeof autoCreatePairing === 'function') {
                                autoCreatePairing({ isHost: false });
                            }
                            var myId = RealTimeSync.deviceId;
                            if (myId) {
                                currentRecipientView = myId;
                                currentTaskRecipient = myId;
                                DataStore.save('currentRecipientView', myId);
                            }
                            if (typeof navigateTo === 'function') {
                                navigateTo('recipient-home');
                            }
                        }, 1000);
                    }
                } catch(e) { console.error('[p2p:connected] handler error:', e); }
                if (typeof currentRole !== 'undefined' && currentRole === 'demo') {
                    setTimeout(function() {
                        RealTimeSync._requestFullSync();
                    }, 800);
                    setTimeout(function() {
                        if (typeof navigateTo === 'function') {
                            navigateTo('guardian-add-recipient');
                        }
                    }, 1200);
                }
            });

            RealTimeSync.on('p2p:disconnected', function() {
                console.log('[UI] P2P disconnected');
                showToast('⚠️ 连接已断开，自动重连中...');
                updateP2PStatus();
                var overlay = document.getElementById('reconnectOverlay');
                if (overlay) overlay.style.display = 'block';
                var st = document.getElementById('reconnectStatus');
                if (st) st.textContent = '自动重连中...';
                // 使用指数退避重连，无限重试
                if (window.RealTimeSync) {
                    window.RealTimeSync._attemptReconnect();
                }
            });

            function hideReconnectPairOverlay() {
                var po = document.getElementById('reconnectPairOverlay');
                if (po) po.style.display = 'none';
            }

            RealTimeSync.on('p2p:error', function(data) {
                console.error('[UI] P2P error:', data);
                var msg = data.message || '连接错误';
                if (data.type === 'notFound') msg = '授权码无效或已过期，请确认后重试';
                if (data.type === 'unavailable-id') msg = '授权码冲突，请重新生成';
                showToast('❌ ' + msg);
                updateP2PStatus();
                var btn = document.getElementById('generateCodeBtn');
                if (btn) { btn.disabled = false; btn.textContent = '重新生成'; btn.style.background = '#7F8C8D'; }
            });

            RealTimeSync.on('p2p:syncComplete', function(data) {
                console.log('[UI] Full sync complete');
                showToast('🔄 数据同步完成');
            });

            RealTimeSync.on('p2p:reconnectFailed', function() {
                showToast('❌ 重连失败，请重新配对');
                updateP2PStatus();
            });

            RealTimeSync.on('p2p:networkStatus', function(data) {
                if (!data.online) {
                    showToast('⚠️ 网络已断开，数据将本地缓存');
                } else if (data.quality === 'poor') {
                    showToast('⚠️ 连接质量较差，同步可能延迟');
                }
                updateP2PStatus();
            });

            RealTimeSync.on('emergency:received', function(data) {
                showToast('🚨 紧急求助！' + (data.recipient || '被监护人') + '需要帮助！');
                if (typeof navigator !== 'undefined' && navigator.vibrate) {
                    navigator.vibrate([500, 200, 500, 200, 500]);
                }
            });
        }

        // 暴露关键函数到window作用域（供onclick属性调用）
        window.handleGenerateAuthCode = handleGenerateAuthCode;
        window.handleConnectWithCode = handleConnectWithCode;
        window.handleDisconnect = handleDisconnect;
        window.recipientConnectWithCode = recipientConnectWithCode;