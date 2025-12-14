# 🔐 TopbitToken 

**极简、高性能、可刷新的加密 Token 解决方案🪙**

---

### 一、TopbitToken 是什么？

TopbitToken 是专为 Topbit 框架打造的零依赖、极简、高安全的加密用户凭证（Token）系统。

它完全基于 Node.js 原生 `crypto` 实现，支持：

- AES-256-GCM（默认，推荐）  
- AES-192-GCM / AES-128-CBC / AES-256-CBC  
- 国密 SM4-CBC  

一句话总结：  
> **3 行代码实现：签发 + 验证 + 自动刷新 + 即时失效（支持热更换密钥）**

---

### 二、核心特性（为什么选择它？）

| 特性                         | 说明                                                                                   |
|------------------------------|----------------------------------------------------------------------------------------|
| **零依赖**                   | 完全原生实现，不依赖 jwt、jsonwebtoken 等第三方库                                     |
| **闪电 超快加密解密**        | AES-NI 硬件加速 + GCM 模式，单次验证 < 0.05ms                                         |
| **更新 自动刷新 Token**      | 接近过期时自动下发新 Token（`x-refresh-token` 头）                                    |
| **钥匙 支持多套密钥（tokenId）** | 可同时存在多套密钥，随时切换主密钥，所有旧 Token 立即失效（防泄漏神器）                |
| **盾牌 防篡改 + 防重放**     | 内置时间戳 + 有效期 + tokenId 校验                                                     |
| **锁 即时失效**              | 修改 `tokenIds` 或删除某个 `tokenId`，对应 Token 立刻失效，无需等待过期               |
| **设置 灵活算法支持**        | 支持国密 SM4，满足合规需求                                                             |

---

### 三、快速上手（30 秒搞定登录认证）

```js
const Topbit = require('topbit')
const TopbitToken = Topbit.Token

const token = new TopbitToken({
  key       : 'your-32-byte-secret-key-here!!',   // 必须 32 字节（AES-256）
  expires   : 60 * 60 * 24,                       // 24 小时（单位：秒）
  refresh   : true                                // 开启自动刷新（最后 1/5 时间刷新）
})

module.exports = token   // 直接导出实例，TopbitLoader 自动识别
```

```js
// controller/user.js
class User {
  async post(c) {                     // POST /user/login
    // 登录验证成功后
    let userinfo = {
      uid   : 10010,
      name  : 'Alice',
      role  : 'admin',
      // expires 可单独设置更长时间
    }
    let t = token.makeToken(userinfo)      // 签发 Token
    c.to({ok: true, msg: 'login success', token: t})
  }
}

// 所有需要登录的接口自动加上 token.mid()
token.mid() 会自动把验证后的用户信息挂到 c.user
```

---

### 四、配置项全解析

| 参数           | 类型             | 默认值                 | 说明                                                                                 |
|----------------|------------------|------------------------|--------------------------------------------------------------------------------------|
| `key`          | string           | 随机32字节             | 主加密密钥（建议 32 字节）                                                           |
| `iv`           | string           | 随机12/16字节          | 初始化向量（GCM=12，CBC=16）                                                         |
| `algorithm`    | string           | `aes-256-gcm`          | 支持：`aes-256-gcm`（推荐）、`aes-192-gcm`、`sm4-cbc` 等                              |
| `expires`      | number（秒）     | 3小时                  | Token 默认有效期                                                                     |
| `refresh`      | boolean          | `false`                | 是否开启自动刷新（设为 `true` 则最后 1/5 时间自动刷新）                              |
| `encoding`     | string           | `base64url`            | Token 输出编码（`base64url`、`hex`、`base64`）                                       |
| `failedCode`   | number           | `401`                  | 验证失败时返回的 HTTP 状态码                                                         |
| `tokenIds`     | array            | `[]`                   | 多密钥 ID 列表，用于支持密钥轮换                                                     |

---

### 五、高级功能：多密钥 + 即时失效（防泄漏神器）

```js
const Topbit = require('topbit')
const TopbitToken = Topbit.Token

const token = new TopbitToken({
  key: 'master-key-2025-01-01',
  expires: 3600 * 24 * 30
})

// 添加多套密钥（可随时动态添加）
token.addTokenId({
  'user-v1'   : 'old-key-2024-v1',
  'admin-v2'  : 'new-strong-key-2025',
  'mobile'    : 'mobile-special-key'
})

// 如果发现密钥泄漏，立即执行：
token.removeTokenId('user-v1')   // 所有使用 user-v1 签发的 Token 立刻失效！

// 或者直接清空所有旧密钥，只保留当前主密钥
token.tokenIds = []
```

---

### 六、自动刷新 Token 机制

```js
const Topbit = require('topbit')
const TopbitToken = Topbit.Token

const token = new TopbitToken({
  expires: 3600 * 24,   // 24小时有效
  refresh: true         // 开启自动刷新
})
```

- 当剩余时间 < 24小时 × 1/5 = 4.8小时 时  
- 服务器自动返回新 Token：`x-refresh-token: new-token-here`  
- 前端收到后替换旧 Token 即可实现“永不过期”体验

---

### 七、最佳实践（生产级推荐配置）

```js
const Topbit = require('topbit')
const TopbitToken = Topbit.Token

const token = new TopbitToken({
  algorithm : 'aes-256-gcm',
  key       : process.env.TOKEN_KEY,        // 从环境变量读取
  expires   : 60 * 60 * 24 * 30,            // 30天
  refresh   : true,
  failedCode: 401
})

// 支持密钥轮换（每月换一次）
if (process.env.TOKEN_ID) {
  token.addTokenId(process.env.TOKEN_ID)
}

module.exports = token
```

---

### 八、常见问题（FAQ）

| 问题                           | 解答                                                                 |
|--------------------------------|----------------------------------------------------------------------|
| 是否比 JWT 更快？              | 是！原生 crypto + GCM 模式，比 jwt 快 3~10 倍                         |
| 是否支持 Redis 黑名单？        | 不需要！通过 `removeTokenId()` 即可实现即时失效                      |
| 是否支持单点登录退出？         | 是！删除对应 `tokenId` 或修改密钥，所有设备立即退出                  |
| 是否支持国密 SM4？             | 支持！`algorithm: 'sm4-cbc'` 即可                                    |

---

**结论：TopbitToken 是目前 Topbit 生态中最快、最安全、最易用的认证方案。**

配合 TopbitLoader 使用，真正实现：  
> **零配置、全自动、高性能、可运维的现代化认证系统**

--- 
