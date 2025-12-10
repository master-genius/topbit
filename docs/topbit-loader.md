# 🤖 TopbitLoader 完全使用手册

### 一、TopbitLoader 是什么？

TopbitLoader 是 Topbit 框架官方推荐的「自动化加载器」扩展，彻底告别手动 `app.get()`、`app.use()` 的繁琐写法。

它实现了真正的 **MCM 模式**（Middleware → Controller → Model），类似 MVC 但更轻量、更符合 Topbit 的极致性能哲学。

一句话总结：  
> **把整个项目按约定目录结构写好，一个 `ld.init(app)` 就自动完成所有路由 + 中间件 + 模型的加载。**

---

### 二、推荐项目结构

```
project/
├── app.js                 # 入口文件（下面有完整示例）
├── controller/            # 控制器目录（必须）
│   ├── __mid.js           # 全局中间件（可选）
│   ├── user.js            # /user 路由组
│   ├── admin/             # /admin 路由组（子目录自动识别）
│   │   ├── __mid.js       # admin 组专用中间件
│   │   └── index.js       # /admin
│   └── api/
│       ├── __mid.js
│       └── v1/
│           └── post.js    # /api/v1/post
├── middleware/           # 中间件类目录（必须）
│   ├── @auth.js           # 必须以 @ 开头，类式中间件
│   ├── @cors.js
│   └── rate-limit.js      # 普通函数式中间件（不推荐）
└── model/                 # 模型目录（可选，配合 modelLoader）
    └── user.js
```

---

### 三、快速上手

```js
// app.js
'use strict'
process.chdir(__dirname)

const Topbit = require('topbit')
const { Loader } = Topbit   // 关键：直接从 topbit 导出

const app = new Topbit({
  debug: true,
  http2: true,
  allowHTTP1: true,
  cert: './cert/fullchain.pem',
  key: './cert/privkey.pem'
})

if (app.isWorker) {
  // 只需要这一行，所有路由、中间件、模型全部自动加载
  new Loader().init(app)
}

app.autoWorker(16)      // 最大弹性进程数
app.daemon(443, 4)      // 4 个基础进程
```

只需执行 `node app.js` 即可启动完整服务！

---

### 四、核心配置项详解

| 配置项               | 类型               | 默认值         | 说明                                                                                                                    |
|----------------------|--------------------|----------------|-------------------------------------------------------------------------------------------------------------------------|
| `appPath`            | string             | `.`            | 项目根目录（一般不用改）                                                                                                 |
| `controllerPath`     | string             | `./controller` | 控制器目录                                                                                                              |
| `midwarePath`        | string             | `./middleware` | 中间件类目录                                                                                                            |
| `prePath`            | string             | `''`           | 全局路由前缀，例如 `/api/v1`                                                                                            |
| `subgroup`           | string\|Array      | `null`         | 只加载指定子目录，例如 `['admin', 'api']`                                                                                |
| `fileAsGroup`        | boolean            | `true`         | **强烈推荐开启**，每个控制器文件自动成为一个路由分组，中间件更精准                                                      |
| `optionsRoute`       | boolean            | `true`         | 自动为每个分组添加 `OPTIONS /*` 路由（CORS 预检必备）                                                                    |
| `multi`              | boolean            | `false`        | 是否允许重复调用 `init()`，生产环境保持 `false`                                                                          |
| `homeFile`           | string             | `''`           | 指定哪个文件作为首页路由 `/`，例如 `'index.js'`                                                                          |
| `initArgs`           | any                | `app.service`  | 传给每个控制器的 `init()` 参数                                                                                           |
| `beforeController`   | function           | `null`         | 控制器实例化后、注册路由前执行                                                                                           |
| `afterController`    | function           | `null`         | 路由注册完成后执行                                                                                                       |
| `modelLoader`        | async function     | `null`         | **最强大的扩展点**：自定义模型加载逻辑，推荐配合 `topbit-model` 使用                                                    |

**最常用配置示例**：

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

### 五、控制器（Controller）写法大全

#### 1. 最简 RESTful 写法（推荐）

```js
// controller/user.js
class User {
  async get(ctx) {               // GET    /user/:id
    ctx.to({ id: ctx.param.id })
  }
  async list(ctx) {              // GET    /user
    ctx.to(['user1', 'user2'])
  }
  async post(ctx) {              // POST   /user
    ctx.to({ saved: true })
  }
  async put(ctx) {               // PUT    /user/:id
    ctx.to({ updated: true })
  }
  async delete(ctx) {            // DELETE /user/:id
    ctx.to({ deleted: true })
  }
}
module.exports = User
```

#### 2. 自定义路径

```js
class User {
  static param = '/:uid/info'    // 自定义参数路径
  static postParam = '/create'   // POST 专用路径

  async post(ctx) {              // POST   /user/create
    ctx.ok('created')
  }
}
```

#### 3. 为当前文件添加专属中间件

```js
class User {
  // 返回中间件数组，只作用于本文件的所有路由
  static __mid() {
    return [
      [require('../middleware/@auth'), { pre: true }],
      require('../middleware/rate-limit')
    ]
  }
}
```

#### 4. 首页控制器

```js
// controller/index.js
class Index {
  async get() {
    this.ctx.html('<h1>Welcome to Topbit</h1>')
  }
}
module.exports = Index

// 在 Loader 配置中指定
new Loader({ homeFile: 'index.js' }).init(app)
```

---

### 六、中间件（Middleware）写法

#### 1. 类式中间件（推荐，以 @ 开头）

```js
// middleware/@auth.js
class Auth {
  async middleware(c, next) {
    if (!c.headers.token) return c.status(401).to('need token')
    c.user = { id: 1 }
    await next(c)
  }
}
module.exports = Auth
```

#### 2. 全局中间件 __mid.js

```js
// controller/__mid.js   或   controller/admin/__mid.js
module.exports = [
  { name: '@auth' },                              // 类式中间件
  { name: 'rate-limit', method: ['GET','POST'] }, // 普通函数中间件
  { middleware: async (c, next) => {              // 直接写函数
      console.log('global mid')
      await next(c)
  }, pre: true }
]
```

#### 3. 文件级中间件（最精准）

```js
// 在 controller/user.js 中
// 只在本文件生效
__mid() {
  return [
    { name: '@vip-auth', pre: true },
    { name: 'log', method: 'POST' },
    //只对控制器方法get list 启用中间件
    { name: 'check', handler: ['get', 'list'] }
  ]
}
```

---

### 七、模型加载（modelLoader）最佳实践

```js
new Loader({
  modelLoader: async (service) => {
    const glob = require('glob')
    const path = require('path')

    const files = glob.sync('model/**/*.js', { cwd: __dirname })
    for (const file of files) {
      const Model = require(path.resolve(__dirname, file))
      const name = path.basename(file, '.js')
      service[name + 'Model'] = new Model(service)
    }
  }
}).init(app)
```

---

### 八、安全与命名规范

- 文件夹名、文件名只能包含：`a-z 0-9 _ -`，且必须字母开头
- 禁止空格、汉字、大写、特殊符号
- 违反命名规范会直接报红字警告
- 以 `!` 开头的文件/文件夹会被自动忽略（用于临时禁用）

---

### 九、高级技巧合集

| 需求                           | 解决方案                                                                 |
|-------------------------------|--------------------------------------------------------------------------|
| 多个版本 API 并行             | 使用 `prePath: '/v1'`, `prePath: '/v2'` 分别创建多个 Loader 实例         |
| 灰度发布                      | `subgroup: ['v2']` 只加载 v2 目录，配合 Nginx 分流                        |
| 插件化开发                    | 每个插件一个独立目录，`new Loader({ appPath: './plugins/xxx' }).init(app)` |
| 热更新（开发环境）            | `multi: true` + chokidar 监听文件变更重新调用 `init()`                   |

---

### 十、完整生产级入口示例

```js
// app.js（生产环境终极版本）
'use strict'
process.chdir(__dirname)

const Topbit = require('topbit')
const { Loader } = Topbit

const app = new Topbit({
  debug: false,
  http2: true,
  allowHTTP1: true,
  cert: '/etc/ssl/fullchain.pem',
  key: '/etc/ssl/privkey.pem',
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
      svc.db = require('./lib/mysql-pool')
      svc.redis = require('./lib/redis')
    }
  }).init(app)
}

app.sched('none')
app.autoWorker(32)
app.daemon(443, 8)
```

---

**至此，你已经掌握了 TopbitLoader 的全部精髓！**

把它用起来，你会发现：  
> **Topbit + TopbitLoader = 可能是目前 Node.js 生态里开发体验最好、性能最强的后端组合。**
