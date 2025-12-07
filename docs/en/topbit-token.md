# 🔐 TopbitToken

**Ultra-Fast & Secure Token System for Topbit🪙**


### 1. What is TopbitToken?

TopbitToken is a zero-dependency, minimalist, high-security encrypted token system designed specifically for the Topbit framework.

Built entirely on Node.js native `crypto`, supports:

- AES-256-GCM (default, recommended)  
- AES-192-GCM / AES-128-CBC / AES-256-CBC  
- SM4-CBC (China GM standard)  

**One-sentence summary:**  
> 3 lines of code = Issue + Verify + Auto-refresh + Instant revocation (hot-swappable keys)

---

### 2. Why Choose TopbitToken?

| Feature                        | Description                                                                      |
|--------------------------------|----------------------------------------------------------------------------------|
| **Zero Dependencies**          | Pure native crypto, no jwt/jsonwebtoken                                         |
| **Lightning Fast**             | AES-NI + GCM mode, < 0.05ms per verification                                    |
| **Refresh Auto Token Refresh** | Automatically issues new token when nearing expiry                              |
| **Key Multiple Keys (tokenId)**| Supports multiple key sets, switch master key = instantly invalidate all old tokens |
| **Shield Tamper-proof**        | Built-in timestamp + expiry + tokenId validation                                |
| **Lock Instant Revocation**    | Remove a tokenId → all related tokens die immediately, no waiting              |
| **Gear SM4 Support**           | Full support for China national crypto standard                                 |

---

### 3. 30-Second Quick Start

```js
// middleware/@token.js
const TopbitToken = require('topbit-token')

const token = new TopbitToken({
  key     : 'your-very-strong-32-byte-secret!!',
  expires : 60 * 60 * 24,      // 24 hours
  refresh : true               // Enable auto refresh
})

module.exports = token
```

```js
// controller/user.js
async post(c) {
  // After successful login
  const userinfo = { uid: 1, name: 'Alice', role: 'admin' }
  const t = token.make(userinfo)
  c.setHeader('authorization', t)
  c.to({ok: true})
}

// All protected routes automatically use token.mid()
// Verified user info → c.user
```

---

### 4. Full Configuration Options

| Option         | Type           | Default           | Description                                              |
|----------------|----------------|-------------------|----------------------------------------------------------|
| `key`          | string         | random 32 bytes   | Master encryption key (32 bytes recommended)             |
| `algorithm`    | string         | `aes-256-gcm`     | Supported: `aes-256-gcm`, `sm4-cbc`, etc.                |
| `expires`      | number (sec)   | 3 hours           | Default token lifetime                                   |
| `refresh`      | boolean        | `false`           | Auto refresh in last 1/5 of lifetime                     |
| `encoding`     | string         | `base64url`       | Output encoding                                          |
| `failedCode`   | number         | `401`             | HTTP status on auth failure                              |

---

### 5. Advanced: Multi-Key + Instant Revocation

```js
const token = new TopbitToken({ key: 'current-master-key' })

// Add multiple key versions
token.addTokenId({
  'v2024' : 'old-key-jan-2024',
  'mobile': 'mobile-app-key'
})

// Key leaked? Kill instantly:
token.removeTokenId('v2024')  // All tokens issued with v2024 die now
```

---

### 6. Auto Token Refresh

```js
new TopbitToken({
  expires: 24*3600,
  refresh: true
})
```

→ When remaining time < 20%, server returns:  
`x-refresh-token: new-long-lived-token`

Frontend just replaces the old one → seamless “never expire” experience.

---

### 7. Production Recommended Setup

```js
// middleware/@auth.js
const TopbitToken = require('topbit-token')

const token = new TopbitToken({
  algorithm : 'aes-256-gcm',
  key       : process.env.TOKEN_SECRET,
  expires   : 30 * 24 * 3600,    // 30 days
  refresh   : true
})

if (process.env.TOKEN_ID) {
  token.addTokenId(process.env.TOKEN_ID)
}

module.exports = token
```

---

**TopbitToken is currently the fastest, safest, and most operations-friendly authentication solution in the Topbit ecosystem.**

With TopbitLoader, you get a true zero-config, fully automatic, high-performance authentication system.

Enjoy secure, blazing-fast services!