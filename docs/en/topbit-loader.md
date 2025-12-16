# 🤖 TopbitLoader Complete User Manual

---

### 1. What is TopbitLoader?

TopbitLoader is the official recommended auto-loading extension for the Topbit framework. It completely eliminates the need to manually write `app.get()`, `app.post()`, `app.use()`, etc.

It implements a true MCM pattern (Middleware → Controller → Model) — lightweight, ultra-fast, and perfectly aligned with Topbit’s extreme-performance philosophy.

**One sentence summary:**  
> Write your project following the conventional directory structure, then just call `new Loader().init(app)` once — all routes, middlewares, and models are automatically loaded.

---

### 2. Recommended Project Structure

```
project/
├── app.js                  # Entry file (full example below)
├── controller/             # Controllers (required)
│   ├── __mid.js            # Global middleware list (optional)
│   ├── user.js             # → /user group
│   ├── admin/              # Sub-group
│   │   ├── __mid.js        # Middleware only for admin group
│   │   └── index.js        # → /admin
│   └── api/
│       ├── __mid.js
│       └── v1/
│           └── post.js     # → /api/v1/post
├── middleware/            # Class-style middlewares (required)
│   ├── @auth.js            # Must start with @
│   ├── @cors.js
│   └── rate-limit.js       # Plain function middleware (less common)
└── model/                  # Models (optional)
    └── user.js
```

---

### 3. 30-Second Quick Start

```js
// app.js
'use strict'
process.chdir(__dirname)

const Topbit = require('topbit')
const { Loader } = Topbit

const app = new Topbit({
  debug: true,
  http2: true,
  allowHTTP1: true,
  cert: './cert/fullchain.pem',
  key: './cert/privkey.pem'
})

if (app.isWorker) {
  // One line only – everything is auto-loaded
  new Loader().init(app)
}

// Max elastic workers
app.autoWorker(16)
  //delay 100ms, output service info
  .printServInfo(100)
  .daemon(443, 4)   // 4 base workers
```

Run `node app.js` → full-featured service is up!

---

### 4. Configuration Options

| Option               | Type               | Default       | Description                                                                                     |
|----------------------|--------------------|---------------|-------------------------------------------------------------------------------------------------|
| `appPath`            | string             | `.`           | Project root directory                                                                         |
| `controllerPath`     | string             | `./controller`| Controller folder                                                                               |
| `midwarePath`        | string             | `./middleware`| Middleware class folder                                                                         |
| `prePath`            | string             | `''`          | Global route prefix (e.g. `/api/v1`)                                                            |
| `subgroup`           | string\|Array      | `null`        | Load only specified subdirectories (e.g. `['admin','api']`)                                     |
| `fileAsGroup`        | boolean            | `true`        | Highly recommended – each controller file becomes its own route group (precise middleware)   |
| `optionsRoute`       | boolean            | `true`        | Auto-add `OPTIONS /*` routes for CORS preflight                                                 |
| `multi`              | boolean            | `false`       | Allow multiple `init()` calls (keep `false` in production)                                      |
| `homeFile`           | string             | `''`          | Which file serves the root `/` route (e.g. `'index.js'`)                                        |
| `initArgs`           | any                | `app.service` | Arguments passed to every controller’s `init()` method                                          |
| `beforeController`   | function           | `null`        | Hook executed after controller instantiation, before route registration                       |
| `afterController`    | function           | `null`        | Hook executed after route registration                                                         |
| `modelLoader`        | async function     | `null`        | Powerful extension point – custom model loading (recommended with topbit-model)               |

**Most common production config:**

```js
new Loader({
  prePath: '/api/v1',
  fileAsGroup: true,
  optionsRoute: true,
  modelLoader: async (service) => {
    const UserModel = require('./model/user')
    service.userModel = new UserModel(service)
  }
}).init(app)
```

---

### 5. Controller Writing Guide

#### 5.1 Minimal RESTful Style (Recommended)

```js
// controller/user.js
class User {
  async get(c) {               // GET    /user/:id
    c.to({ id: c.param.id })
  }
  async list(c) {              // GET    /user
    c.to(['alice', 'bob'])
  }
  async post(c) {              // POST   /user
    c.to({ saved: true })
  }
  async put(c) {               // PUT    /user/:id
    c.to({ updated: true })
  }
  async delete(c) {            // DELETE /user/:id
    c.to({ deleted: true })
  }
}
module.exports = User
```

#### 5.2 Custom Path Parameters

```js
class User {
  static param = '/:uid/profile'     // overrides default /:id
  static postParam = '/register'     // POST /user/register

  async post(c) {
    c.ok('registered')
  }
}
```

#### 5.3 File-Specific Middleware

```js
class User {
  static __mid() {
    return [
      [require('../middleware/@auth'), { pre: true }],
      require('../middleware/rate-limit')
    ]
  }
}
```

#### 5.4 Homepage Controller

```js
// controller/index.js
class Index {
  async get(c) {
    c.html('<h1>Welcome to Topbit</h1>')
  }
}
module.exports = Index

// In Loader config:
new Loader({ homeFile: 'index.js' }).init(app)
```

---

### 6. Middleware Writing Guide

#### 6.1 Class-Style Middleware (Recommended – file name starts with `@`)

```js
// middleware/@auth.js
class Auth {
  async middleware(c, next) {
    if (!c.headers.token) return c.status(401).to('Token required')
    c.user = { id: 1 }
    await next(c)
  }
}
module.exports = Auth
```

#### 6.2 Global / Group Middleware via `__mid.js`

```js
// controller/__mid.js   (global)  or  controller/admin/__mid.js (group)
module.exports = [
  { name: '@auth' },                                     // class middleware
  { name: 'rate-limit', method: ['GET','POST'] },        // plain function
  { middleware: async (c, next) => {                     // inline
      console.log('global mid')
      await next(c)
  }, pre: true }
]
```

#### 6.3 File-Level Middleware (Most Precise)

```js
// Inside any controller file
__mid() {
  return [
    { name: '@vip-auth', pre: true },
    { name: 'log', method: 'POST' },
    //use for controller method: get list
    { name: 'check', handler: ['get', 'list'] }
  ]
}
```

---

### 7. Model Loading (modelLoader) Best Practice

```js
new Loader({
  modelLoader: async (service) => {
    const glob = require('glob')
    const path = require('path')
    const files = glob.sync('model/**/*.js', { cwd: __dirname })

    for (const f of files) {
      const Model = require(path.resolve(__dirname, f))
      const name = path.basename(f, '.js')
      service[name + 'Model'] = new Model(service)
    }
  }
}).init(app)
```

---

### 8. Naming & Safety Rules

- Folder and file names may only contain: `a-z 0-9 _ -` and must start with a letter  
- No spaces, Chinese characters, uppercase letters, or special symbols  
- Files/folders starting with `!` are automatically ignored  
- Violation → red warning + skip loading  

---

### 9. Advanced Tips Collection

| Need                            | Solution                                                                                              |
|---------------------------------|-------------------------------------------------------------------------------------------------------|
| Multiple API versions coexist   | Use different `prePath` and create multiple Loader instances                                         |
| Canary / gray release           | `subgroup: ['v2']` + Nginx traffic split                                                             |
| Plugin system                   | Each plugin has its own folder → `new Loader({ appPath: './plugins/xxx' }).init(app)`                |
| Hot reload (dev)                | Set `multi: true` + watch files with chokidar and re-call `init()`                                   |

---

### 10. Production-Grade Full Entry Example

```js
// app.js (Ultimate production version)
'use strict'
process.chdir(__dirname)

const Topbit = require('topbit')
const { Loader } = Topbit

const app = new Topbit({
  debug: false,
  http2: true,
  allowHTTP1: true,
  cert: '/etc/ssl/certs/fullchain.pem',
  key: '/etc/ssl/private/privkey.pem',
  globalLog: true,
  logType: 'file',
  logFile: '/var/log/topbit/access.log',
  errorLogFile: '/var/log/topbit/error.log'
})

if (app.isWorker) {
  new Loader({
    prePath: '/api',
    fileAsGroup: true,
    optionsRoute: true,
    modelLoader: async (svc) => {
      svc.db    = require('./lib/mysql-pool')
      svc.redis = require('./lib/redis-client')
    }
  }).init(app)
}

app.sched('none')
app.autoWorker(32)
app.daemon(443, 8)
```

---

**You have now mastered the complete essence of TopbitLoader!**

Start using it today and you’ll find:  
> Topbit + TopbitLoader = possibly the best developer experience + highest performance backend combination in the current Node.js ecosystem.

Happy coding and may your services fly!