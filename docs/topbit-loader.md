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
│   │   └── index.js       # /admin/index（index 不折叠）
│   └── api/
│       ├── __mid.js       # api 组中间件，会被子目录继承
│       └── v1/
│           ├── __mid.js   # v1 组中间件（可选）
│           └── post.js    # /api/v1/post
├── middleware/           # 中间件目录（必须）
│   ├── auth.js           # 类式中间件（描述对象中用 '@auth' 引用）
│   ├── cors.js
│   └── rate-limit.js     # 普通函数式中间件（不推荐）
└── model/                 # 模型目录（可选，配合 modelLoader）
    └── user.js
```

**目录嵌套规则**：子目录支持嵌套，**最多两层**（如 `api/v1/`）。目录层级即路由层级。

**路由名规则**：路由 = `目录/文件名（去掉 .js）`，**没有 `index` 折叠**——`admin/index.js` 得到的是 `/admin/index`，不是 `/admin`。想要 `/admin` 这个路径，就把文件命名为 `controller/admin.js`。

**中间件继承**：目录级 `__mid.js` 的中间件会被**其所有子目录及文件自动继承**（子目录没有自己的 `__mid.js` 时同样继承父级）。执行顺序按「先添加先执行」的洋葱模型：全局中间件最外层，目录越深越靠近业务处理。

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

// 最大弹性进程数
app.autoWorker(16)
  //延迟100ms后输出服务运行信息
  .printServInfo(100)
  .daemon(443, 4)      // 4 个基础进程
```

只需执行 `node app.js` 即可启动完整服务！

> **防重入**：同一个 Loader 实例只会执行一次加载（重复调用 `init()` 会在入口静默返回，既不重复加载，也不会输出任何警告）。如需在同一 app 上并行加载多套不同 `prePath` 的路由，创建多个 Loader 实例即可——实例之间互不干扰。

---

### 四、核心配置项详解

| 配置项               | 类型               | 默认值         | 说明                                                                                                                    |
|----------------------|--------------------|----------------|-------------------------------------------------------------------------------------------------------------------------|
| `appPath`            | string             | `.`            | 项目根目录（一般不用改）                                                                                                 |
| `controllerPath`     | string             | `./controller` | 控制器目录，**只接受相对 `appPath` 的路径**（绝对路径写法不生效，见下方「路径规则」）                                     |
| `midwarePath`        | string             | `./middleware` | 中间件目录，路径规则同上                                                                                                 |
| `prePath`            | string             | `''`           | 全局路由前缀，例如 `/api/v1`                                                                                            |
| `name`               | string             | `'loader'`     | 加载器命名，注入到 `app.service` 的键名（多实例并行时可设为不同值）                                                       |
| `optionsRoute`       | boolean            | `true`         | 自动为每个目录添加 `OPTIONS /xxx/*` 通配路由（CORS 预检必备），关闭后须自行处理 OPTIONS                                  |
| `homeFile`           | string             | `''`           | 指定哪个文件作为首页路由 `/`，值是**相对 controller 目录、带目录的路径**：顶层写 `'index.js'`，子目录写 `'/admin/index.js'`（含前导 `/`） |
| `initArgs`           | any                | `app.service`  | 传给每个控制器的 `init()` 参数                                                                                           |
| `beforeController`   | function           | `null`         | 控制器实例化后、注册路由前执行                                                                                           |
| `afterController`    | function           | `null`         | 路由注册完成后执行                                                                                                       |
| `modelLoader`        | async function     | `null`         | **最强大的扩展点**：自定义模型加载逻辑，推荐配合 `topbit-model` 使用                                                    |

**路径规则（`controllerPath` / `midwarePath`）**：这两个选项只在传入值**不以 `/` 开头**时生效，此时按 `appPath + '/' + 值` 拼接；如果传入以 `/` 开头的绝对路径，对应分支什么都不做，配置里保留的仍然是默认值 `appPath + '/controller'`、`appPath + '/middleware'`——也就是说绝对路径写法会被静默忽略，既不报错也不生效。需要指向别处时，请改用绝对的 `appPath`（`appPath` 本身支持以 `/` 开头）配合相对的子目录名。

**固定行为说明**：

- **文件即分组**：每个控制器文件自动成为一个独立的路由分组，目录级中间件会精确挂载到该目录下的每个文件分组（无需配置，恒生效）。
- **`init()` 幂等**：同一实例重复 `init()` 在入口即静默返回——不重复加载，也不会输出任何警告；无热更新支持（开发时可用 `nodemon` / `pm2 --watch` 实现文件变更自动重启）。
- **`deep` / `subgroup` / `multi` / `fileAsGroup` 只在 `Topbit.ClassicLoader`（`src/loader/loader.js`）生效**：本文档所述的 `Topbit.Loader`（别名 `Topbit.TopbitLoader`，即 `src/loader/loadernext.js`）的选项处理里没有这几项，传入后会落到默认分支被静默忽略。两者是**并存的两种实现**（`topbit.js` 同时导出），不存在新旧版本关系。`Loader` 的对应行为是固定的：嵌套深度两层、文件恒为分组、防重入为实例级且不可关闭。

**最常用配置示例**：

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

### 五、控制器（Controller）写法大全

#### 1. 最简 RESTful 写法（推荐）

```js
// controller/user.js
class User {
  async get(c) {               // GET    /user/:id
    c.to({ id: c.param.id })
  }
  async list(c) {              // GET    /user
    c.to(['user1', 'user2'])
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

#### 2. 自定义路径（实例属性）

> 注意：`param` / `postParam` 是**实例属性**，不是 `static`。

```js
class User {
  param = '/:uid/info'    // 自定义参数路径
  postParam = '/create'   // POST 专用路径

  async post(c) {              // POST   /user/create
    c.ok('created')
  }
}
```

#### 3. 为当前文件添加专属中间件

> 注意：`__mid()` 是**实例方法**（不是 `static`），返回中间件描述对象数组。

```js
class User {
  // 返回中间件描述对象数组，只作用于本文件的所有路由
  __mid() {
    return [
      { name: '@auth', pre: true },
      { name: 'rate-limit' }
    ]
  }
}
```

#### 4. 首页控制器

```js
// controller/index.js
class Index {
  async get(c) {
    c.html('<h1>Welcome to Topbit</h1>')
  }
}
module.exports = Index

// 在 Loader 配置中指定
new Loader({ homeFile: 'index.js' }).init(app)
```

> `homeFile` 比对的是 `pathname`——**相对 controller 目录、带目录的文件路径**（不含 `prePath`），不是纯文件名。所以顶层文件写 `'index.js'`，嵌套目录下的首页必须写 `'/admin/index.js'`（带目录和前导 `/`），写 `'admin/index.js'` 或只写 `'index.js'` 都匹配不上 `admin/index.js`。另外该匹配只在控制器实现了 `get` 时才生效，且 `/` 是在原有路由之外**额外**注册的一条（`admin/index.js` 依然同时暴露 `/admin/index`）。

---

### 六、中间件（Middleware）写法

#### 1. 类式中间件（推荐）

类式中间件文件的**文件名不带 `@`**，`@` 是在中间件描述对象（`__mid.js` / `__mid()`）中引用它时的类式标记：

```js
// middleware/auth.js
class Auth {
  async middleware(c, next) {
    if (!c.headers.token) return c.status(401).to('need token')
    c.user = { id: 1 }
    await next(c)
  }
}
module.exports = Auth

// controller/__mid.js 中引用：
// { name: '@auth' }         → 类式：require middleware/auth.js 后 new，调用其 middleware/mid 方法
// { name: 'rate-limit' }    → 函数式：require middleware/rate-limit.js 直接使用
```

#### 2. 全局中间件 __mid.js

```js
// controller/__mid.js   或   controller/admin/__mid.js
module.exports = [
  { name: '@auth' },                              // 类式中间件
  { name: 'rate-limit', method: ['GET', 'POST'] },// 普通函数中间件（method 限定）
  { middleware: async (c, next) => {              // 直接写函数
      console.log('global mid')
      await next(c)
  }, pre: true }                                  // pre: true 在读取请求体之前执行
]
```

**中间件描述对象的可用字段**：

| 字段 | 说明 |
|------|------|
| `name` | 中间件文件名（描述值以 `@` 开头为类式，其余为函数式）|
| `middleware` | 直接内联的 `async` 函数（与 `name` 二选一）|
| `args` | 类式中间件构造参数（`name` 以 `@` 开头时生效）|
| `method` | 字符串或数组，限定生效的请求方法，如 `'POST'` / `['GET','POST']` |
| `pre` | `true` 时作为 pre 中间件，在读取请求体之前执行 |
| `mode` | `'test'/'dev'/'online'/'product'`，按运行环境过滤（配合 `service.TEST`/`service.DEV`）|
| `handler` | 仅文件级中间件可用，限定生效的控制器方法，如 `['get', 'list']` |

#### 3. 文件级中间件（最精准）

```js
// 在 controller/user.js 中，通过实例方法 __mid() 声明
__mid() {
  return [
    { name: '@vip-auth', pre: true },
    { name: 'log', method: 'POST' },
    // 只对控制器方法 get、list 启用中间件
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
}).daemonInit(app, () => {
  app.daemon(1234, 2)
})
```

`modelLoader` 返回的 `service` 是 `app.service`，注入的模型可直接在控制器（`c.service.xxxModel`）中使用。

> **`init(app, cb)` / `daemonInit(app, cb)` 的 `cb` 不会被 await**：源码里只是 `cb(app)`，没有 `await`，也不看返回值。如果在 `cb` 内做异步的路由挂载（`app.use` / `app.add` 之类需要等待的操作），它会脱离加载流程异步进行，可能在服务已经开始接收请求之后才完成。需要异步准备请放进 `modelLoader`（这个是 `await` 的），`cb` 里只写同步的启动调用。

---

### 八、安全与命名规范

- 文件夹名、文件名支持：`a-z 0-9 _ -`（大小写字母均可），建议统一小写
- 禁止空格、汉字、特殊符号
- 以 `!` 开头的文件/文件夹会被自动忽略（用于临时禁用）
- 不符合规则的名称会被跳过并输出红色警告

---

### 九、高级技巧合集

| 需求                           | 解决方案                                                                 |
|-------------------------------|--------------------------------------------------------------------------|
| 多个版本 API 并行             | 创建多个 Loader 实例，分别使用 `prePath: '/v1'`、`prePath: '/v2'`（可配不同 `name` 区分）|
| 临时禁用某控制器/目录          | 文件或目录名前加 `!` 前缀，如 `!old-user.js`                              |
| 插件化开发                    | 每个插件一个独立目录，`new Loader({ appPath: './plugins/xxx' }).init(app)` |
| 开发热重载                    | 用 `nodemon` 或 `pm2 --watch` 监听文件变更自动重启进程（同一实例重复 `init()` 会被静默忽略，不会加载新代码）|

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

一旦你掌握了它实际开发项目的流程，你会发现：
> **Topbit + TopbitLoader = 可能是目前 Node.js 生态里开发体验最好、性能最强的后端组合。**
