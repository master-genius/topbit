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
> **3 行代码实现：签发 + 验证 + 即时失效（支持热更换密钥）；自动刷新需显式调用 `token.setRefresh(true)` 开启**

---

### 二、核心特性（为什么选择它？）

| 特性                         | 说明                                                                                   |
|------------------------------|----------------------------------------------------------------------------------------|
| **零依赖**                   | 完全原生实现，不依赖 jwt、jsonwebtoken 等第三方库                                     |
| **闪电 超快加密解密**        | AES-NI 硬件加速 + GCM 模式，单次验证 < 0.05ms                                         |
| **更新 自动刷新 Token**      | 需显式调用 `token.setRefresh(true)` 开启；开启后剩余时间进入最后 1/5 时下发新 Token（`x-refresh-token` 头） |
| **钥匙 支持多套密钥（tokenId）** | 用 `setIdKeyIv(id, key, iv)` 为每个 tokenId 登记独立密钥；`setKey()` 更换主密钥后旧 Token 立即失效（防泄漏神器） |
| **盾牌 防篡改**              | 内置时间戳 + 有效期 + tokenId 校验。**无 nonce / 单次使用记录，不承诺防重放**，需要防重放请自行附加 nonce |
| **锁 即时失效**              | 调用 `removeTokenId(id)` 让对应 Token 立刻失效，无需等待过期（直接清空 `tokenIds` 数组对已签发的 Token 无效，见第五节） |
| **设置 灵活算法支持**        | 支持国密 SM4，满足合规需求                                                             |

---

### 三、快速上手（30 秒搞定登录认证）

```js
const Topbit = require('topbit')
const TopbitToken = Topbit.Token

const token = new TopbitToken({
  key       : 'your-secret-key-at-least-16-chars', // ≥16 字符，按算法自动补齐/截断（见第四节）
  expires   : 60 * 60 * 24                         // 24 小时（单位：秒）
})

// 自动刷新不是构造项：构造里传 refresh 会被静默忽略，必须显式开启
token.setRefresh(true)

module.exports = token   // 导出实例供业务代码 require；中间件挂载方式见下方 __mid.js
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
      // expires 可为该用户单独设置更长时间，注意这里的单位是毫秒
    }
    let t = token.makeToken(userinfo)      // 签发 Token
    c.to({ok: true, msg: 'login success', token: t})
  }
}
```

```js
// controller/__mid.js —— 以 { middleware: token.mid() } 的形式内联挂载
const token = require('../lib/token.js')   // 上面 new 出来的实例，路径按项目实际调整

module.exports = [
  { middleware: token.mid() }   // 验证通过后，用户信息自动挂到 c.user
]
```

> **Token 从哪读、长什么样**
> - `makeToken()` 返回 `${iv}.${cipher}` **两段点分**字符串：第一段是本次随机生成的明文 IV，第二段才是密文（含 GCM authTag）。
> - `token.mid()` 读取的是 `c.headers.authorization` 的**原值**整串，**不会剥离 `Bearer ` 前缀**。客户端必须把 `authorization` 直接设成 `makeToken()` 返回的原始字符串，带 `Bearer ` 会导致解密失败（`ok: false`）。
> - `token` 是实例而不是函数/类，TopbitLoader 不会自动识别 `module.exports = token`（中间件加载只接受函数或类，对实例执行 `new` 会抛 `TypeError`），所以必须在 `__mid.js` 里内联写成 `{ middleware: token.mid() }`。

---

### 四、配置项全解析

| 参数           | 类型             | 默认值                 | 说明                                                                                 |
|----------------|------------------|------------------------|--------------------------------------------------------------------------------------|
| `key`          | string           | 随机32字符             | 主加密密钥。构造末尾经 `fixKey()` 规整：长度 <16 直接抛错 `key.length must >= 16`；目标长度按算法取 16（`sm4*`、`aes-128*`）、24（`aes-192*`）、32（`aes-256*`），超长则截断、不足则自身倍增后截断。**不是「必须 32 字节」** |
| `iv`           | string           | 随机12/16字符          | 初始化向量（GCM=12，CBC=16），经 `fixIv()` 规整（超长截断、不足补数字）。注意：若 `iv` 写在 `algorithm` 之前，`algorithm` 分支会用随机 IV 覆盖它——自定义 IV 建议构造完成后用 `setIv()` 设置 |
| `algorithm`    | string           | `aes-256-gcm`          | 白名单：`aes-256-gcm`（推荐）、`aes-192-gcm`、`aes-128-cbc`、`aes-192-cbc`、`aes-256-cbc`、`sm4-cbc`、`sm4`（自动归一为 `sm4-cbc`）；名单外的值被忽略并保持默认 |
| `expires`      | number（秒）     | 3小时                  | Token 默认有效期，内部 `×1000` 存为毫秒（`setExpires()` 则直接接收毫秒，别再乘 1000）  |
| `encoding`     | string           | `base64url`            | Token 输出编码（`base64url`、`hex`、`base64`）                                       |
| `failedCode`   | number           | `401`                  | 验证失败时返回的 HTTP 状态码（仅接受 400~499 的数字）                                 |

> ⚠️ **`refresh` 不是构造选项。** 构造函数只识别 `iv / key / expires / encoding / alg / algorithm / failedCode` 这几项，传 `refresh: true` 会被静默忽略，`this.refresh` 恒为初值 `0`，而自动刷新的判断条件在 `refresh = 0` 时永远不成立。开启方式只有一个：构造完成后调用 `token.setRefresh(true)`。
>
> `tokenIds` 同样不是构造选项，它是实例属性，只能通过 `addTokenId()` / `removeTokenId()` 维护（见第五节、第八节）。

---

### 五、高级功能：多密钥 + 即时失效（防泄漏神器）

先划清职责：`addTokenId()` 只负责**登记 tokenId**（写入 `tokenIds` 与 `tokenMap`），它**不承担“配置独立密钥”的职责**。

- 传字符串或数组：`tokenMap` 里记录的是序号占位值；
- 传对象 `{ id: value }`：value 只是被当作该 id 的 **iv 占位**存进 `tokenMap`（`setMapId(tid, iv)` 的实现是 `tokenMap.set(tid, iv || tid)`）。验证路径只判断 `tokenMap.has(...)`，**这个值永远不会被当密钥使用**。

真正的「每 id 独立密钥」API 是 `setIdKeyIv(id, key, iv)`（三个参数都必须给；`key`/`iv` 分别过 `fixKey`/`fixIv`，并自动 `addTokenId(id)`，结果存入 `idKeyIV`）：

```js
const Topbit = require('topbit')
const TopbitToken = Topbit.Token

const token = new TopbitToken({
  key: 'master-key-2025-01-01',
  expires: 3600 * 24 * 30
})

// 1) 只登记 id（共享主密钥），用于轮换与撤销 —— 可随时动态添加
token.addTokenId([ 'admin-v2', 'mobile' ])

// 2) 为某个 id 配独立密钥 + IV（这才是真正的多套密钥）
//    key ≥16 字符（按算法规整到 16/24/32），iv 长度按算法（GCM=12，CBC=16）
token.setIdKeyIv('user-v1', 'old-key-2024-v1-0000000000000000', 'iv-user-v1-000')

// 独立密钥的 token 用 make / verifyid 成对使用
// （注意：这类 token 不走 mid() 的 authorization 验证，见第八节 verifyToken 说明）
let t = token.make({ uid: 10010 }, 'user-v1')   // 单段输出，无 iv 前缀
let r = token.verifyid(t, 'user-v1')            // 用 idKeyIV 中登记的 key/iv 解密

// 如果发现 user-v1 密钥泄漏，立即执行：
token.removeTokenId('user-v1')   // 同时删 tokenIds / tokenMap / idKeyIV，所有 user-v1 的 Token 立刻失效！
```

> ❌ **不要指望 `token.tokenIds = []` 能撤销已签发的 Token。** 验证路径只看 `this.tokenMap.has(uj.__tokenId__)`，清空 `tokenIds` 数组只影响**后续签发**（`stepId()` / `randId()` 取不到 id），已经签发的 Token 仍然会验证通过。撤销一律用 `removeTokenId(id)`。
>
> 同理，`tokenIds` 为空时签发的 token，其 `__tokenId__` 是空串，`verify()` 会整体跳过 tokenId 校验 —— 这类 token 无法通过 tokenId 撤销。想让 token 可撤销，签发前先用 `addTokenId()` 登记至少一个 id。

---

### 六、自动刷新 Token 机制

```js
const Topbit = require('topbit')
const TopbitToken = Topbit.Token

const token = new TopbitToken({
  expires: 3600 * 24    // 24小时有效
})

token.setRefresh(true)  // 必须显式调用！构造项里没有 refresh
```

- 当剩余时间 < 24小时 × 1/5 = 4.8小时 时，`token.mid()` 才下发新 Token（`refresh` 为 0 时该判断恒不成立，永远不下发）
- `setRefresh(true)` 按**调用那一刻**的 `expires` 算窗口（`Math.floor(expires / 5)`）；若之后又 `setExpires()`，需要重新调用一次 `setRefresh(true)`。关闭用 `setRefresh(false)`  
- 服务器自动返回新 Token：`x-refresh-token: new-token-here`  
- 前端收到后替换旧 Token 即可实现“永不过期”体验

---

### 七、最佳实践（生产级推荐配置）

```js
const Topbit = require('topbit')
const TopbitToken = Topbit.Token

const token = new TopbitToken({
  algorithm : 'aes-256-gcm',
  key       : process.env.TOKEN_KEY,        // 从环境变量读取（<16 字符会抛错）
  expires   : 60 * 60 * 24 * 30,            // 30天（单位：秒）
  failedCode: 401
})

token.setRefresh(true)                      // 自动刷新必须显式开启，不是构造项

// 支持密钥轮换（每月换一次）：先登记 id，签发的 token 才可被撤销
if (process.env.TOKEN_ID) {
  token.addTokenId(process.env.TOKEN_ID)
}

module.exports = token   // 供 controller/__mid.js 内联 { middleware: token.mid() } 使用
```

---

### 八、API 一览

方法名一律以 `src/token/token.js` 实现为准。

**构造 / 配置**

| 方法 | 作用 |
|------|------|
| `setKey(key)` | 更换主密钥（按当前算法过 `fixKey`）。换完后旧主密钥签发的 Token 全部立即失效 |
| `setIv(iv)` | 更换主 IV（按当前算法过 `fixIv`） |
| `setEncoding(ecode)` | 更换输出编码，直接赋值、不做校验 |
| `setExpires(expires)` | 更换默认有效期，**入参单位是毫秒**（与构造项 `expires` 的「秒」不同） |
| `setRefresh(flag=true)` | 开启/关闭自动刷新：`true` 时 `refresh = Math.floor(expires / 5)`，`false` 时归 0 |

**tokenId 管理**

| 方法 | 作用 |
|------|------|
| `addTokenId(tid)` | 登记 tokenId，接受字符串 / 数组 / `{id: iv}` 对象；只写 `tokenIds` 与 `tokenMap`，**不设独立密钥** |
| `setIdKeyIv(id, key, iv)` | 为某个 id 登记独立 key + iv（内部自动 `addTokenId(id)`），存入 `idKeyIV`；三个参数都必须给 |
| `setMapId(tid, iv=null)` | 底层写入 `tokenMap.set(tid, iv || tid)` |
| `hasId(tid)` | 等价于 `tokenMap.has(tid)` |
| `removeTokenId(tid)` | 撤销：同时删除 `tokenIds` 项、`tokenMap`、`idKeyIV` |
| `randId()` | 从 `tokenIds` 随机返回一个 id（空数组返回 `''`） |
| `stepId()` | 按 `idIndex` 轮转返回下一个 id（空数组返回 `''`） |

**签发 / 验证**

| 方法 | 作用 |
|------|------|
| `makeToken(info, id=null, key=null)` | 签发 `${iv}.${token}` **两段格式**，IV 每次随机（长度 = `ivLength`）。`token.mid()` / `verifyToken()` 用的就是这种 |
| `make(userinfo, tokenId=null)` | **单段输出**（无 iv 前缀），固定使用主 `iv`；若 `tokenId` 在 `idKeyIV` 有登记则改用其独立 key/iv |
| `makeikv(userinfo, ikv)` | 用显式 `{id, key, iv}` 签发单段 token |
| `randIvToken(info, id=null, key=null)` | 签发并返回 `{id, key, iv, token}`。注意其随机 IV 固定 16 字符且**不经过 `fixIv`**（与 GCM 默认的 12 字节 IV 不同），必须把返回的 `iv`/`key` 原样交给 `verifyikv` 校验 |
| `verifyToken(edata)` | 校验两段格式：第一段作 iv、**始终用主密钥**解密。所以 `setIdKeyIv()` 配了独立密钥的 token 不能走 `mid()` |
| `verify(edata, ikv={})` | 底层校验，可传 `{key, iv, id}`；返回 `{ok:true, data, now}` 或 `{ok:false, errcode}` |
| `verifyikv(edata, ikv)` | `verify` 的转发，用于 `makeikv` / `randIvToken` 的产物 |
| `verifyid(edata, tid)` | 取 `idKeyIV.get(tid)` 的 key/iv 校验，用于 `make(info, tid)` 的产物 |
| `refreshToken(t, ikv=null)` | 入参为 `verify()` 的返回对象；剩余时间 < `refresh` 时重签（有 `ikv` 走 `makeikv`，否则走 `make`），否则返回 `null` |
| `mid()` | 返回中间件：取 `c.headers.authorization` 原值 → `verifyToken` → 无头则 `c.status(failedCode).to('!token')`，失败则 `.to(errcode)`；通过则挂 `c.user`，命中刷新窗口时下发 `x-refresh-token` |

> `verify` 返回的 `errcode` 只有三种：`TIMEOUT`（已过期）、`ILLEGAL`（tokenId 不被认可，或 `verifyToken` 收到的不是两段格式）、`FAILED`（解密 / JSON 解析异常）。

**实例属性**：`key`、`iv`、`algorithm`、`isGCM`、`ivLength`、`tokenEncoding`、`expires`（毫秒）、`refresh`（毫秒窗口，`0` = 关闭）、`failedCode`、`tokenIds`（数组，签发时取 id 用）、`tokenMap`（验证时判存活用）、`idKeyIV`（每 id 的独立 key/iv）、`idIndex`（`stepId` 的游标）。

---

### 九、常见问题（FAQ）

| 问题                           | 解答                                                                 |
|--------------------------------|----------------------------------------------------------------------|
| 是否比 JWT 更快？              | 是！原生 crypto + GCM 模式，比 jwt 快 3~10 倍                         |
| 是否支持 Redis 黑名单？        | 不需要全局黑名单：`removeTokenId(id)` 可按 tokenId 粒度即时失效。但 `tokenIds` 为空时签发的 token 不受此机制保护 |
| 是否支持单点登录退出？         | 是！给每个用户/设备签发时带上独立 `tokenId`，踢人只需 `removeTokenId()`；或 `setKey()` 换主密钥让全员退出 |
| 是否支持国密 SM4？             | 支持！`algorithm: 'sm4-cbc'`（或 `'sm4'`）即可                          |
| 构造里传了 `refresh: true`，为什么没下发 `x-refresh-token`？ | `refresh` 不是构造选项，会被静默忽略。请调用 `token.setRefresh(true)` |
| 清空 `token.tokenIds` 后旧 token 还能用？ | 是。验证只看 `tokenMap.has(__tokenId__)`，清空数组只影响后续签发。撤销请用 `token.removeTokenId(id)` |
| 客户端带 `Bearer <token>` 一直 401？ | `mid()` 用的是 `authorization` 原值，不剥 `Bearer ` 前缀。请直接传 `makeToken()` 返回的原始字符串 |
| 能防重放吗？                   | 不能。`verify()` 只校验时间戳、有效期、tokenId，**没有 nonce 或单次使用记录**，token 在有效期内可被重复使用。需要防重放请自行附加 nonce，或收紧有效期并配合 `removeTokenId()` |

---

**结论：TopbitToken 是目前 Topbit 生态中最快、最安全、最易用的认证方案。**

配合 TopbitLoader 时，在 `__mid.js` 中以 `{ middleware: token.mid() }` 的形式内联挂载（Loader 不识别 token 实例），真正实现：
> **配置简单、可刷新、可运维的高性能认证系统**

--- 
