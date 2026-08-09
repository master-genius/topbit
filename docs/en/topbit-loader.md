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
│       ├── __mid.js        # api group middleware, inherited by subdirectories
│       └── v1/
│           ├── __mid.js    # v1 group middleware (optional)
│           └── post.js     # → /api/v1/post
├── middleware/            # Middlewares (required)
│   ├── auth.js            # Class-style middleware (referenced as '@auth' in descriptors)
│   ├── cors.js
│   └── rate-limit.js       # Plain function middleware (less common)
└── model/                  # Models (optional)
    └── user.js
```

**Directory nesting**: Subdirectories may be nested up to **two levels** (e.g. `api/v1/`). Directory depth maps to route depth.

**Middleware inheritance**: A directory-level `__mid.js` is automatically **inherited by all of its subdirectories and files** (subdirectories without their own `__mid.js` still inherit the parent's). Execution follows the onion model — middleware added first runs first (outermost); global middleware is outermost, deeper directories sit closer to the business handler.

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

> **Re-entrancy guard**: A Loader instance loads only once — repeated `init()` calls are blocked with a warning. To serve multiple route sets on the same app, create multiple Loader instances with different `prePath`; they do not interfere with each other.

---

### 4. Configuration Options

| Option               | Type               | Default       | Description                                                                                     |
|----------------------|--------------------|---------------|-------------------------------------------------------------------------------------------------|
| `appPath`            | string             | `.`           | Project root directory                                                                         |
| `controllerPath`     | string             | `./controller`| Controller folder                                                                               |
| `midwarePath`        | string             | `./middleware`| Middleware class folder                                                                         |
| `prePath`            | string             | `''`          | Global route prefix (e.g. `/api/v1`)                                                            |
| `name`               | string             | `'loader'`    | Loader name, used as the key injected into `app.service` (set distinct names for parallel instances) |
| `optionsRoute`       | boolean            | `true`        | Auto-add `OPTIONS /xxx/*` wildcard routes for CORS preflight; disable only if you handle OPTIONS yourself |
| `homeFile`           | string             | `''`          | Which file serves the root `/` route (e.g. `'index.js'`)                                        |
| `initArgs`           | any                | `app.service` | Arguments passed to every controller’s `init()` method                                          |
| `beforeController`   | function           | `null`        | Hook executed after controller instantiation, before route registration                       |
| `afterController`    | function           | `null`        | Hook executed after route registration                                                         |
| `modelLoader`        | async function     | `null`        | Powerful extension point – custom model loading (recommended with topbit-model)               |

**Fixed behavior**:

- **File as group**: every controller file automatically becomes its own route group; directory-level middleware is mounted onto every file group under that directory (always on, no configuration needed).
- **Idempotent `init()`**: repeated `init()` on the same instance is blocked; there is no built-in hot reload (use `nodemon` / `pm2 --watch` for file-change restarts during development).

**Most common production config:**

```js
new Loader({
  prePath: '/api/v1',
  optionsRoute: true,
  modelLoader: async (service) => {
    const UserModel = require('./model/user')
    service.userModel = new UserModel(service)
  }
}).init(app, () => {
  app.run(1234)
})
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

#### 5.2 Custom Path Parameters (instance properties)

> Note: `param` / `postParam` are **instance properties**, not `static`.

```js
class User {
  param = '/:uid/profile'     // overrides default /:id
  postParam = '/register'     // POST /user/register

  async post(c) {
    c.ok('registered')
  }
}
```

#### 5.3 File-Specific Middleware

> Note: `__mid()` is an **instance method** (not `static`) returning an array of middleware descriptor objects.

```js
class User {
  __mid() {
    return [
      { name: '@auth', pre: true },
      { name: 'rate-limit' }
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

#### 6.1 Class-Style Middleware (Recommended)

The class middleware **file name has no `@` prefix** — `@` is a class-style marker used when referencing it inside middleware descriptor objects (`__mid.js` / `__mid()`):

```js
// middleware/auth.js
class Auth {
  async middleware(c, next) {
    if (!c.headers.token) return c.status(401).to('Token required')
    c.user = { id: 1 }
    await next(c)
  }
}
module.exports = Auth

// Referenced inside controller/__mid.js:
// { name: '@auth' }         → class-style: require middleware/auth.js, instantiate, call its middleware/mid method
// { name: 'rate-limit' }    → plain function: require middleware/rate-limit.js and use directly
```

#### 6.2 Global / Group Middleware via `__mid.js`

```js
// controller/__mid.js   (global)  or  controller/admin/__mid.js (group)
module.exports = [
  { name: '@auth' },                                     // class middleware
  { name: 'rate-limit', method: ['GET', 'POST'] },       // plain function, method-restricted
  { middleware: async (c, next) => {                     // inline function
      console.log('global mid')
      await next(c)
  }, pre: true }                                         // pre: runs before reading the request body
]
```

**Middleware descriptor fields**:

| Field       | Description                                                                          |
|-------------|--------------------------------------------------------------------------------------|
| `name`      | Middleware file name (`@` prefix in the descriptor = class-style, otherwise plain function) |
| `middleware`| Inline `async` function (alternative to `name`)                                      |
| `args`      | Constructor arguments for class-style middleware (when `name` starts with `@`)       |
| `method`    | String or array restricting HTTP methods, e.g. `'POST'` / `['GET','POST']`           |
| `pre`       | `true` → runs as a pre-middleware, before the request body is read                   |
| `mode`      | `'test'/'dev'/'online'/'product'` — filter by environment (combined with `service.TEST`/`service.DEV`) |
| `handler`   | File-level middleware only; restricts target controller methods, e.g. `['get', 'list']` |

#### 6.3 File-Level Middleware (Most Precise)

```js
// Inside any controller file, declared via the instance method __mid()
__mid() {
  return [
    { name: '@vip-auth', pre: true },
    { name: 'log', method: 'POST' },
    // applies only to the controller methods: get, list
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
}).daemonInit(app, () => {
  app.daemon(1234, 2)
})
```

The `service` passed to `modelLoader` is `app.service`; injected models are usable inside controllers via `c.service.xxxModel`.

---

### 8. Naming & Safety Rules

- Folder and file names may contain: `a-z 0-9 _ -` (both upper and lower case letters are allowed; lowercase is recommended)
- No spaces, Chinese characters, or special symbols
- Files/folders starting with `!` are automatically ignored (useful for temporarily disabling)
- Names that violate the rules are skipped with a red warning

---

### 9. Advanced Tips Collection

| Need                            | Solution                                                                                              |
|---------------------------------|-------------------------------------------------------------------------------------------------------|
| Multiple API versions coexist   | Create multiple Loader instances with `prePath: '/v1'`, `prePath: '/v2'` (optionally with distinct `name`) |
| Temporarily disable a controller / directory | Prefix the file or folder name with `!`, e.g. `!old-user.js`                                  |
| Plugin system                   | Each plugin has its own folder → `new Loader({ appPath: './plugins/xxx' }).init(app)`                |
| Dev hot reload                  | Use `nodemon` or `pm2 --watch` to restart on file changes (the loader itself does not support repeated `init()`) |

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
