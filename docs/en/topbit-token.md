# 🔐 TopbitToken

**Ultra-Fast & Secure Token System for Topbit🪙**


### 1. What is TopbitToken?

TopbitToken is a zero-dependency, minimalist, high-security encrypted token system designed specifically for the Topbit framework.

Built entirely on Node.js native `crypto`, supports:

- AES-256-GCM (default, recommended)  
- AES-192-GCM / AES-128-CBC / AES-256-CBC  
- SM4-CBC (China GM standard)  

**One-sentence summary:**
> 3 lines of code = Issue + Verify + Instant revocation (hot-swappable keys). Auto-refresh is NOT a constructor option — call `token.setRefresh(true)` explicitly.

---

### 2. Why Choose TopbitToken?

| Feature                        | Description                                                                      |
|--------------------------------|----------------------------------------------------------------------------------|
| **Zero Dependencies**          | Pure native crypto, no jwt/jsonwebtoken                                         |
| **Lightning Fast**             | AES-NI + GCM mode, < 0.05ms per verification                                    |
| **Refresh Auto Token Refresh** | Needs `token.setRefresh(true)`; once on, a new token is pushed in the last 1/5 of lifetime (`x-refresh-token` header) |
| **Key Multiple Keys (tokenId)**| `setIdKeyIv(id, key, iv)` registers a real per-id key; `setKey()` on the master key instantly invalidates all old tokens |
| **Shield Tamper-proof**        | Built-in timestamp + expiry + tokenId validation. **No nonce / no single-use record → replay is NOT prevented**; add your own nonce if you need it |
| **Lock Instant Revocation**    | Call `removeTokenId(id)` → related tokens die immediately, no waiting (emptying the `tokenIds` array does NOT revoke already-issued tokens — see section 5) |
| **Gear SM4 Support**           | Full support for China national crypto standard                                 |

---

### 3. 30-Second Quick Start

```js
const Topbit = require('topbit')
const TopbitToken = Topbit.Token

const token = new TopbitToken({
  key     : 'your-secret-key-at-least-16-chars',  // ≥16 chars, normalized per algorithm (section 4)
  expires : 60 * 60 * 24                          // 24 hours
})

// Auto refresh is not a constructor option: passing `refresh` here is silently ignored
token.setRefresh(true)

module.exports = token   // export the instance for business code to require; see __mid.js below for mounting
```

```js
// controller/user.js
async post(c) {
  // After successful login
  const userinfo = { uid: 1, name: 'Alice', role: 'admin' }   // userinfo.expires, if set, is in MILLISECONDS
  const t = token.makeToken(userinfo)
  c.to({ok: true, token: t})
}
```

```js
// controller/__mid.js — mount it inline as { middleware: token.mid() }
const token = require('../lib/token.js')   // the instance created above; adjust the path to your project

module.exports = [
  { middleware: token.mid() }   // verified user info is attached to c.user
]
```

> **Where the token is read from, and what it looks like**
> - `makeToken()` returns a two-part dotted string `${iv}.${cipher}`: the first segment is the randomly generated **plaintext IV** of this issuance, the second is the ciphertext (GCM authTag included).
> - `token.mid()` reads the **raw value** of `c.headers.authorization` as a whole. It does **not strip a `Bearer ` prefix** — the client must send exactly what `makeToken()` returned; with `Bearer ` attached, decryption fails (`ok: false`).
> - `token` is an instance, not a function/class. TopbitLoader does **not** auto-recognize `module.exports = token` (middleware loading accepts only functions or classes, and running `new` on an instance throws `TypeError`), so it must be written inline in `__mid.js` as `{ middleware: token.mid() }`.

---

### 4. Full Configuration Options

| Option         | Type           | Default           | Description                                              |
|----------------|----------------|-------------------|----------------------------------------------------------|
| `key`          | string         | random 32 chars   | Master key, normalized by `fixKey()` at the end of the constructor: length <16 throws `key.length must >= 16`; target length is 16 (`sm4*`, `aes-128*`), 24 (`aes-192*`) or 32 (`aes-256*`) — longer values are truncated, shorter ones are doubled then truncated. **Not "must be 32 bytes"** |
| `iv`           | string         | random 12/16 chars| Initialization vector (GCM=12, CBC=16), normalized by `fixIv()` (truncated if longer, digit-padded if shorter). Caveat: if `iv` is written before `algorithm`, the `algorithm` branch overwrites it with a random IV — set a custom IV with `setIv()` after construction |
| `algorithm`    | string         | `aes-256-gcm`     | Whitelist: `aes-256-gcm` (recommended), `aes-192-gcm`, `aes-128-cbc`, `aes-192-cbc`, `aes-256-cbc`, `sm4-cbc`, `sm4` (normalized to `sm4-cbc`); any other value is ignored and the default is kept |
| `expires`      | number (sec)   | 3 hours           | Default token lifetime, stored internally as `×1000` milliseconds (`setExpires()` takes **milliseconds** directly — don't multiply again) |
| `encoding`     | string         | `base64url`       | Output encoding (`base64url`, `hex`, `base64`)           |
| `failedCode`   | number         | `401`             | HTTP status on auth failure (numbers 400–499 only)       |

> ⚠️ **`refresh` is not a constructor option.** The constructor only recognizes `iv / key / expires / encoding / alg / algorithm / failedCode`. Passing `refresh: true` is silently ignored, `this.refresh` stays at its initial `0`, and the auto-refresh condition can then never be met. The only way to enable it is `token.setRefresh(true)` after construction.
>
> `tokenIds` is not a constructor option either — it is an instance property maintained only through `addTokenId()` / `removeTokenId()` (see sections 5 and 8).

---

### 5. Advanced: Multi-Key + Instant Revocation

Draw the line first: `addTokenId()` only **registers tokenIds** (writes into `tokenIds` and `tokenMap`); it does **not** configure independent keys.

- String or array: `tokenMap` stores a sequence-number placeholder;
- Object `{ id: value }`: the value is merely stored in `tokenMap` as that id's **iv placeholder** (`setMapId(tid, iv)` is `tokenMap.set(tid, iv || tid)`). The verification path only checks `tokenMap.has(...)`, so **that value is never used as a key**.

The real per-id key API is `setIdKeyIv(id, key, iv)` (all three arguments are required; `key`/`iv` go through `fixKey`/`fixIv`, and it calls `addTokenId(id)` for you, storing the result in `idKeyIV`):

```js
const Topbit = require('topbit')
const TopbitToken = Topbit.Token

const token = new TopbitToken({ key: 'current-master-key' })

// 1) register ids only (sharing the master key) — for rotation and revocation
token.addTokenId([ 'v2024', 'mobile' ])

// 2) a real independent key + IV for one id (this is the actual multi-key API)
//    key ≥16 chars (normalized to 16/24/32 by algorithm), iv length per algorithm (GCM=12, CBC=16)
token.setIdKeyIv('mobile', 'mobile-app-key-000000000000000000', 'iv-mobile-000')

// per-id tokens are used as a make / verifyid pair
// (note: these tokens do NOT go through mid()'s authorization verification — see section 8)
let t = token.make({ uid: 1 }, 'mobile')   // single segment, no iv prefix
let r = token.verifyid(t, 'mobile')        // decrypts with the key/iv registered in idKeyIV

// Key leaked? Kill instantly:
token.removeTokenId('mobile')  // deletes tokenIds entry + tokenMap + idKeyIV → all "mobile" tokens die now
```

> ❌ **`token.tokenIds = []` does NOT revoke already-issued tokens.** The verification path only looks at `this.tokenMap.has(uj.__tokenId__)`; emptying the `tokenIds` array only affects **future issuance** (`stepId()` / `randId()` can no longer pick an id), tokens already issued still verify fine. Always revoke with `removeTokenId(id)`.
>
> Likewise, a token issued while `tokenIds` is empty carries `__tokenId__ = ''`, and `verify()` skips the tokenId check entirely — such tokens cannot be revoked by tokenId. If you want revocable tokens, call `addTokenId()` and register at least one id before issuing.

---

### 6. Auto Token Refresh

```js
const token = new TopbitToken({
  expires: 24*3600
})

token.setRefresh(true)   // must be called explicitly! there is no `refresh` constructor option
```

→ `setRefresh(true)` computes the window from `expires` **at the moment you call it** (`Math.floor(expires / 5)`). If you later call `setExpires()`, call `setRefresh(true)` again; `setRefresh(false)` turns it off. When remaining time < 20%, `token.mid()` returns (with `refresh = 0` the condition can never hold, so nothing is ever sent):  
`x-refresh-token: new-long-lived-token`

Frontend just replaces the old one → seamless “never expire” experience.

For manual (non-middleware) verification, use `token.refreshToken(verifyResult)`: it returns a re-issued token when inside the window, otherwise `null`.

---

### 7. Production Recommended Setup

```js
const Topbit = require('topbit')
const TopbitToken = Topbit.Token

const token = new TopbitToken({
  algorithm : 'aes-256-gcm',
  key       : process.env.TOKEN_SECRET,   // throws if <16 chars
  expires   : 30 * 24 * 3600,             // 30 days (unit: seconds)
  failedCode: 401
})

token.setRefresh(true)                    // auto refresh must be enabled explicitly, it is not a constructor option

if (process.env.TOKEN_ID) {
  token.addTokenId(process.env.TOKEN_ID)  // register the id first, otherwise issued tokens are not revocable
}

module.exports = token   // consumed by controller/__mid.js as { middleware: token.mid() }
```

---

### 8. API Reference

Method names follow the `src/token/token.js` implementation.

**Configure**

| Method | Purpose |
|--------|---------|
| `setKey(key)` | Swap the master key (normalized by `fixKey` for the current algorithm). All tokens issued with the old master key become invalid at once |
| `setIv(iv)` | Swap the master IV (normalized by `fixIv`) |
| `setEncoding(ecode)` | Change the output encoding; assigned directly, no validation |
| `setExpires(expires)` | Change the default lifetime — **takes milliseconds** (unlike the constructor's `expires`, which takes seconds) |
| `setRefresh(flag=true)` | Turn auto refresh on/off: `true` sets `refresh = Math.floor(expires / 5)`, `false` resets it to 0 |

**tokenId management**

| Method | Purpose |
|--------|---------|
| `addTokenId(tid)` | Register ids; accepts a string / array / `{id: iv}` object. Only writes `tokenIds` and `tokenMap` — **no independent key** |
| `setIdKeyIv(id, key, iv)` | Register an independent key + iv for one id (calls `addTokenId(id)` internally), stored in `idKeyIV`; all three arguments required |
| `setMapId(tid, iv=null)` | Low-level `tokenMap.set(tid, iv || tid)` |
| `hasId(tid)` | Same as `tokenMap.has(tid)` |
| `removeTokenId(tid)` | Revoke: deletes the `tokenIds` entry, `tokenMap` and `idKeyIV` together |
| `randId()` | Return a random id from `tokenIds` (`''` when the array is empty) |
| `stepId()` | Return the next id round-robin via `idIndex` (`''` when the array is empty) |

**Issue / verify**

| Method | Purpose |
|--------|---------|
| `makeToken(info, id=null, key=null)` | Issue the two-part `${iv}.${token}` format; IV is random per call (length = `ivLength`). This is what `token.mid()` / `verifyToken()` consume |
| `make(userinfo, tokenId=null)` | **Single segment** (no iv prefix), always using the master `iv`; switches to the per-id key/iv if `tokenId` exists in `idKeyIV` |
| `makeikv(userinfo, ikv)` | Issue a single-segment token with an explicit `{id, key, iv}` |
| `randIvToken(info, id=null, key=null)` | Issue and return `{id, key, iv, token}`. Note: its random IV is fixed at 16 chars and **not passed through `fixIv`** (vs GCM's default 12-byte IV), so the returned `iv`/`key` must be handed to `verifyikv` unchanged |
| `verifyToken(edata)` | Verify the two-part format: segment 1 is the iv, decryption **always uses the master key**. So tokens with a `setIdKeyIv()` independent key cannot go through `mid()` |
| `verify(edata, ikv={})` | Low-level verification, accepts `{key, iv, id}`; returns `{ok:true, data, now}` or `{ok:false, errcode}` |
| `verifyikv(edata, ikv)` | Forwards to `verify`; for `makeikv` / `randIvToken` output |
| `verifyid(edata, tid)` | Verifies with the key/iv from `idKeyIV.get(tid)`; for `make(info, tid)` output |
| `refreshToken(t, ikv=null)` | Takes the object returned by `verify()`; re-issues when remaining time < `refresh` (`makeikv` if `ikv` is given, else `make`), otherwise returns `null` |
| `mid()` | Returns the middleware: reads the raw `c.headers.authorization` → `verifyToken` → no header means `c.status(failedCode).to('!token')`, failure means `.to(errcode)`; on success attaches `c.user` and sends `x-refresh-token` inside the refresh window |

> `verify` returns only three `errcode` values: `TIMEOUT` (expired), `ILLEGAL` (tokenId not recognized, or `verifyToken` did not receive the two-part format), `FAILED` (decryption / JSON parse error).

**Instance properties**: `key`, `iv`, `algorithm`, `isGCM`, `ivLength`, `tokenEncoding`, `expires` (ms), `refresh` (ms window, `0` = off), `failedCode`, `tokenIds` (array, used when picking an id to issue), `tokenMap` (used by verification to check liveness), `idKeyIV` (per-id key/iv), `idIndex` (`stepId` cursor).

---

### 9. FAQ

| Question | Answer |
|----------|--------|
| Faster than JWT? | Yes! Native crypto + GCM, 3–10× faster than jwt |
| Do I need a Redis blacklist? | No global blacklist needed: `removeTokenId(id)` revokes at tokenId granularity. But tokens issued while `tokenIds` was empty are outside this mechanism |
| Single-session logout? | Yes! Issue each user/device with its own `tokenId`, then `removeTokenId()` kicks them; or `setKey()` to log everyone out |
| SM4 support? | Yes, `algorithm: 'sm4-cbc'` (or `'sm4'`) |
| I passed `refresh: true` in the constructor — why no `x-refresh-token`? | `refresh` is not a constructor option and is silently ignored. Call `token.setRefresh(true)` |
| Old tokens still work after `token.tokenIds = []`? | Yes. Verification only checks `tokenMap.has(__tokenId__)`; emptying the array only affects future issuance. Use `token.removeTokenId(id)` to revoke |
| Client sends `Bearer <token>` and keeps getting 401? | `mid()` uses the raw `authorization` value and does not strip the `Bearer ` prefix. Send exactly what `makeToken()` returned |
| Does it prevent replay attacks? | No. `verify()` only checks timestamp, lifetime and tokenId — **there is no nonce and no single-use record**, so a captured token stays usable until it expires. Add your own nonce, or shorten the lifetime and combine it with `removeTokenId()` |

---

**TopbitToken is currently the fastest, safest, and most operations-friendly authentication solution in the Topbit ecosystem.**

With TopbitLoader, mount it inline in `__mid.js` as `{ middleware: token.mid() }` (the loader does not recognize token instances), and you get a simple, refreshable, operable, high-performance authentication system.

Enjoy secure, blazing-fast services!