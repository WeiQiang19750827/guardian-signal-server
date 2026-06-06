# 守护者 Guardian - 产品需求文档 (PRD)

**版本**: v4.5.6
**更新日期**: 2026-06-06
**文档状态**: 已完成

---

## 版本历史

### v4.5.6 (2026-06-06)
- ✅ **全面代码审查与架构优化**
  - 确认被守护端单一6位授权码输入框功能正常
  - 密码自动派生机制验证：code.slice(-4)
  - APK构建成功，版本归档

### v4.5.5 (2026-06-06)
- ✅ **简化配对流程：被守护端只需输入6位授权码**
  - 密码机制改为：授权码后4位自动派生（code.slice(-4)），被守护端无需单独输入密码
  - 被守护端 UI：移除密码输入框，只保留1个6位授权码输入框
  - 守护端 UI：移除密码显示区域和密码输入框
  - 服务器：/pair 接口生成授权码时 password = code.slice(-4)
  - 服务器：/pair/:code/join 仍然验证派生密码，确保安全性
  - handleConnectWithCode / recipientConnectWithCode 自动从授权码派生密码
  - 配对流程：守护端生成授权码(如123456) → 被守护端输入123456 → 系统自动使用后4位(3456)验证

- ✅ **代码质量优化**
  - 实现心跳超时检测：心跳发送后8s内未收到ack则记录missed，连续3次超时触发p2p:disconnected
  - ICE候选队列限制：最大100条，防止内存泄漏
  - reconnectTimer泄漏防护：设置前先清除旧定时器
  - 清理重复的p2p:connected监听器：合并为一个统一处理

### v4.5.3 (2026-06-06)
- ✅ **重连稳定性增强**
  - _attemptReconnect() 重连时根据 isHost 选择正确角色(host/client)
  - _attemptReconnect() 重连前调用 _cleanupConnection() 清理旧状态
  - connectWithCode() 保存 authPassword 确保持久化含密码
  - p2p:connected 重置 _reconnectAttempts 计数器
  - p2p:connected 清除 reconnectTimer 防止泄漏

### v4.5.2 (2026-06-06)
- ✅ **修复15s虚假连接问题**
  - _activateRelay() 添加 _peerJoined 标志防护
  - peer_joined 事件时置为 true
  - 15s定时器检查 _peerJoined 再决定是否降级

### v4.5.1 (2026-06-06)
- ✅ **被守护端密码验证**
  - 服务器 /pair 接口生成4位随机密码
  - 服务器 /pair/:code/join 验证密码
  - 客户端添加密码输入框

### v4.3.4 (2026-05-22)
- ✅ **增强云端 IP 获取：灵活的云端 URL 配置**
  - 新增 cloudIPGistUrl 输入框，支持任意 HTTP URL 获取配置
  - RealTimeSync._autoDiscoverServer() 新增云端获取阶段
  - 新增 _fetchServerIPFromCloud() 函数

### v1.62 (2026-05-22)
- ✅ **C 方案实现：云端 IP 自动上报 + DDNS 配置**
  - 服务器端 IP 上报功能（JSONBin/GitHub Gist）
  - 客户端云端读取功能
  - 新增 SERVER-SETUP-GUIDE.md 配置指南

### v1.61 (2026-05-22)
- ✅ **重写自动发现逻辑：全自动智能寻址**
  - 本地IP探测 + 候选IP生成 + 批量并发扫描
  - 双端口扫描(8443/80) + 公网IP回退
  - 手动配置优先 + 自动重试机制

---

## 核心功能

### 1. 配对流程（当前版本）
1. 守护端在「配对关系」页面点击「生成授权码」
2. 守护端将6位授权码（如 `123456`）告知被守护端
3. 被守护端在「被监护人」页面输入授权码 `123456`
4. 系统自动使用授权码后4位 `3456` 作为密码进行验证
5. 连接建立，双方进入实时同步状态

### 2. 连接持久化与自动重连
- localStorage 持久化配对信息（authCode、authPassword、isHost、peerId）
- AUTH_CODE_TTL = 24小时（与服务器TTL一致）
- 网络断开：自动触发 _attemptReconnect()，指数退避 2s→4s→8s→16s→32s→60s(max)
- 重连时根据 isHost 选择正确角色
- 心跳超时：8s内未收到ack记录missed，连续3次超时触发重连
- 连接成功：自动重置计数器，清除定时器，刷新离线队列

### 3. 实时数据同步
- WebRTC DataChannel + Socket.IO 信令中继
- Socket.IO 心跳保活（5s间隔）
- 离线队列：断线期间数据暂存 localStorage，连接恢复后自动发送
- 全量同步请求：连接建立后800ms自动请求完整数据

---

## 技术架构

### 信令服务器 (signaling-server.js)
- HTTP 接口：/pair(生成授权码)、/pair/:code/join(验证连接)
- Socket.IO：/signal 信令房间管理
- 配对密码 = 授权码后4位，有效期 5分钟(PAIR_TTL)

### 客户端 (index.html)
- RealTimeSync 对象：P2P连接管理
- SocketIOSignaling：Socket.IO信令中继
- DataStore：数据持久化
- PermissionManager：权限管理

### 关键常量
- HEARTBEAT_INTERVAL: 5000ms
- HEARTBEAT_TIMEOUT: 8000ms
- MAX_MISSED_HEARTBEATS: 3
- AUTH_CODE_TTL: 24小时
- ICE_CANDIDATE_QUEUE_MAX: 100

---

## 文件清单

| 文件 | 说明 |
|------|------|
| guardian-v4.5.6.html | 主应用（v4.5.6） |
| guardian-v4.5.6.apk | Android安装包 |
| signaling-server.js | 信令服务器 |
| guardian-app/www/index.html | APK源文件 |
| guardian-app/config.xml | Cordova配置（v4.5.6） |
| 4.5.6/guardian-v4.5.6.html | 版本归档 |
| 4.5.6/guardian-v4.5.6.apk | 版本归档 |
| SERVER-SETUP-GUIDE.md | 配置指南 |
| PRD-v4.5.6-产品需求文档.md | 本文档 |
