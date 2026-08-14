# Topbit 多端口监听与 nginx 基座能力方案

> 目标版本：v3.4.0
> 状态：方案评审中，尚未实现

## 一、背景与目标

topbit 当前 `run()` / `daemon()` 只支持监听单个端口，无法在一个进程内同时服务多个端口。本方案的目标是：

1. **`run()` / `daemon()` 支持监听参数为数组格式**，实现动态多端口监听（http / https / http2 可混跑）。
2. **开发配置解析扩展**，根据一份声明式配置，解析出 `port`、`host` 等，构造好 Proxy 扩展参数以及 `run()` / `daemon()` 参数，实现类似 nginx 的「server 块 + 多监听」基座能力。
3. **HTTP 模块 `host` 属性保持字符串**，不改为数组（理由见第三章）。

前置条件已达成：v3.3.8 已升级 Proxy 扩展支持 `port` 选项，去掉了运行时端口解析（`extractHostname`），初始化告知端口自动生成配置 key。本节为多端口监听扫清了 proxy 侧的障碍。

## 二、现状盘点（v3.3.8）

### 2.1 已具备的 nginx 基础能力

| nginx 能力 | topbit 现状 | 位置 |
|---|---|---|
| `proxy_pass` 反向代理 | ✅ 完整（背压/超时/健康检查） | `src/extends/proxy.js`、`proxyNoAgent.js`、`http2proxy.js` |
| `upstream` 负载均衡 | ✅ 轮询/加权/存活检测 | `proxy.js` + `Topbit.ProxyBalancer` |
| `root`/`alias` 静态资源 | ✅ 缓存/ETag/路径安全 | `src/extends/resource.js` |
| SNI 多证书 | ✅ | `src/extends/sni.js` |
| `real_ip` | ✅ | `src/extends/realip.js` |
| `listen` 多端口 | ❌ **仅单端口** | `src/topbit.js` `run()` |

### 2.2 proxy 端口解析升级（v3.3.8 已完成）

- Proxy 构造器新增 `port` 选项（`proxy.js:73, 180-199`），初始化时告知服务端口。
- `setHostProxy()` 按端口自动生成 key（`proxy.js:253-269`）：
  - 端口为 80/443：生成「裸 key + 带端口 key」双 key，共享同一后端配置；
  - 其他端口：裸 key 替换为「裸 key:端口」；
  - `port` 为空但 key 带 `:80`/`:443` 后缀：补裸 key。
- 运行时 `mid()` 直接 `let host = c.host` 查表（`proxy.js:537`），不再做端口剥离。
- 三代理扩展（proxy / proxyNoAgent / http2proxy）同构修改。

## 三、HTTP 模块 `host` 属性分析

### 3.1 `this.host` 的两个用途

追踪 `http1.js` / `http2.js` / `httpc.js` 中所有引用，`this.host` **不参与路由分派**，仅有两个用途：

| 用途 | 位置 | 说明 |
|---|---|---|
| Host 头缺失时的回退值 | `http1.js:116` `ctx.host = ctx.headers.host \|\| self.host`<br>`http2.js:119` `ctx.host = headers[':authority'] \|\| headers.host \|\| self.host`<br>`httpc.js:117` 同理 | HTTP/1.0 无 Host 头、或异常请求时，用 `self.host` 填充 `ctx.host` |
| 日志 URL 拼接 | `http1.js:87` `link: ${protocol}://${reqHeaders.host \|\| self.host}${req.url}`<br>`http2.js:88`、`httpc.js:75` 同理 | 记录日志时请求头无 host 则用 `self.host` 拼 URL |

赋值逻辑（三模块同构，如 `http1.js:312-323`）：

```js
if (typeof port === 'string' && port.indexOf('.sock') > 0) {
  this.host = port;                          // unix socket
} else if (typeof port === 'object') {
  this.host = port.host || host || '';
  port.port && (port.port != 80 && port.port != 443) && (this.host += `:${port.port}`);
} else {
  this.host = host;
  if (port !== 80 && port !== 443) { this.host += `:${port}`; }
}
```

### 3.2 结论：`this.host` 保持字符串，不改为数组

理由：

1. **语义不匹配**：一次请求只来自一个端口，回退值只能是该端口的地址，数组没有意义。
2. **改动面失控**：`ctx.host` 回退、日志拼接等多处消费点是字符串拼接，改数组需全部重写。
3. **正确做法是实例隔离**：多端口时每个端口创建独立的 HTTP 模块实例，每个实例各自持有自己的 `this.host` 字符串。这正是第四章的实例化方案。

## 四、`run()` / `daemon()` 支持数组参数

### 4.1 单端口六处硬约束

| # | 约束 | 位置 | 改造方式 |
|---|---|---|---|
| 1 | `_is_listening` 单次锁 | `topbit.js:1167` | 改为「init 只跑一次」锁，listen 可多次 |
| 2 | `this.server` 单引用 | `topbit.js:1227` | 新增 `this.servers = []`；保留 `this.server` 指向第一个（向后兼容） |
| 3 | `this.rundata.host/port` 单值 | `topbit.js:1184-1185` | 新增 `this.rundata.listeners = [{host, port}, ...]`；保留 `host`/`port` 指向第一个（monitor 兼容） |
| 4 | 初始化链一次性 | `topbit.js:1199-1225` | **保持只跑一次**（路由排序/中间件加载/bodyparser/addFinal 本就该只执行一次） |
| 5 | `this.events = {}` 消费即清空 | `http1.js`/`http2.js`/`httpc.js` 的 `run()` 末尾 | 每个 HTTP 模块实例持有独立 events 副本 |
| 6 | `this.httpServ` 单实例 | `topbit.js:507` 构造时三选一 | 按每个 listen 目标的协议创建独立实例 |

### 4.2 init 与 listen 分离

```
run([2368, {port:443, https:true, http2:true}, {port:8080, host:'192.168.1.1'}])
         │
         ▼
    ┌─ init 阶段（只跑一次）──────────────────────┐
    │  router.argsRouteSort()                      │
    │  midware.addFromCache()                      │
    │  add(bodyparser) / add(统一body中间件)        │
    │  addFinal() / connection 事件绑定            │
    └──────────────────────────────────────────────┘
         │
         ▼
    ┌─ listen 阶段（每个 target 循环）─────────────┐
    │  for (target of listenTargets) {             │
    │    // 按协议创建独立 HTTP 模块实例            │
    │    let serv = createHttpServ(target, opts)   │
    │    serv.run(target.port, target.host)        │
    │    this.servers.push(serv)                   │
    │  }                                           │
    └──────────────────────────────────────────────┘
```

### 4.3 协议判定与实例化

按每个 listen target 判定协议形态：

```
{port: 443, https: true, http2: true, allowHTTP1: true}
  → Httpc 实例（http2 + http1 兼容，当前兼容模式）

{port: 80}
  → Http1 实例（纯 http1）

{port: 8443, https: true, http2: true, allowHTTP1: false}
  → Httpt 实例（纯 http2）
```

每个实例构造时传入共享的 `midware`、`router`、`service` 引用，使多个 server 共享同一套路由与中间件链。

### 4.4 body 接收中间件统一

`topbit.js:1204` 的 `this.add(this.httpServ)` 在 `midcore.js:82` 触发 `midcall.mid()`，把 body 接收逻辑作为中间件加入链。**多端口时该中间件只能加一次**。

三个模块 `mid()` 差异：

| 模块 | `mid()` 内部 | body 接收对象 |
|---|---|---|
| `Http1` | `ctx.req.on('data')` | `ctx.req`（IncomingMessage） |
| `Httpt` | `ctx.stream.on('data')` | `ctx.stream`（Http2Stream） |
| `Httpc` | 复用 `Http1.mid()` | `ctx.req`（兼容模式 http2 请求 `ctx.req = ctx.stream`） |

由于 `ctx.req` 在所有协议下都被正确赋值（纯 http2 `http2.js:131`、兼容模式 `httpc.js:114` 均 `ctx.req = ctx.stream`），`Http1.mid()` 的 `ctx.req.on('data')` 对所有协议可工作。仅超限响应（413）需按 `ctx.major` 分支：

```js
if (ctx.major === 2) {
  ctx.stream.respond({':status': '413'});
  ctx.stream.close();
} else {
  ctx.res.statusCode = 413;
  ctx.res.end('');
}
```

### 4.5 events 副本

`http1.js`/`http2.js`/`httpc.js` 的 `run()` 末尾均有 `this.events = {}`。多端口时共享同一个 `eventTable` 会导致第二个 server 绑定不到事件。改造：每个 HTTP 模块实例从 `app` 复制一份 events 到自身，`run()` 消费自身副本。

### 4.6 rundata 与 monitor

`monitor.js:67,79,344` 使用 `rundata.host` 和 `rundata.port` 拼显示字符串。改造后：

- `rundata.host` / `rundata.port` 保留，指向第一个监听地址（向后兼容）；
- 新增 `rundata.listeners` 数组，供 monitor 展示全部监听地址；
- `rundata.conn` 聚合所有端口的连接计数（按端口限流留作后续扩展）。

### 4.7 daemon 多端口传递

`daemon()`（`topbit.js:1238`）master fork worker 后，worker 分支调用 `this.run(port, host)`（`topbit.js:1319`）。多端口改造后：

- `daemon([{port:80}, {port:443, https:true, http2:true}], num)` 接受数组；
- worker 通过 cluster IPC 拿到完整数组，调用 `run(数组)`；
- master 侧 `rundata.port`/`rundata.host` 取值逻辑（`topbit.js:1272,1276`）需兼容数组（取第一个或存数组）。

## 五、配置解析扩展（nginx 基座）

### 5.1 职责

声明式配置 → 命令式 API 调用：解析配置后，构造 Proxy / Resource / SNI 等扩展的参数，以及 `run()` / `daemon()` 的监听参数。类似 nginx 的 `server` 块语义，但通过扩展实现，不动核心。

### 5.2 配置格式（建议）

```js
const topbitConf = {
  listen: [
    { port: 80 },
    { port: 443, https: true, http2: true, allowHTTP1: true,
      key: './cert/privkey.pem', cert: './cert/fullchain.pem' },
    { port: 8080, host: '192.168.1.1' }
  ],
  proxy: {
    'api.example.com': { path: '/api', url: 'http://127.0.0.1:3000' },
    'static.example.com': { path: '/*', url: 'http://127.0.0.1:7000' }
  },
  resource: {
    staticPath: './public',
    routePath: '/static/*'
  }
};
```

### 5.3 扩展接口

```js
class ServerConfig {
  constructor(config) { /* 解析配置，创建 Proxy/Resource 实例 */ }

  init(app) {
    // 1. proxy.init(app)、resource.init(app) 挂载中间件
    // 2. 注册 run 后钩子：告知 proxy 各监听端口，触发 key 展开
  }

  listenTargets() {
    // 返回 run()/daemon() 可直接消费的数组参数
    return this.config.listen;
  }
}
```

### 5.4 时序

```
new ServerConfig(cfg)      → 解析配置，创建 Proxy/Resource 实例
serverConfig.init(app)     → proxy.init(app)、resource.init(app)
app.run(listenTargets)     → 监听多端口
  └→ 钩子：proxy.setPorts(ports) → 按各端口展开 hostProxy key
```

proxy 的 key 展开时机：`init(app)` 时端口未知，`run()` 后才知道。需要回调机制——proxy 暴露 `setPorts(ports)`，由 `run()` 阶段广播调用（或 `ServerConfig` 包装 `app.run` 在返回后调用）。

### 5.5 与核心改造的依赖

- 依赖第四章 `run()`/`daemon()` 数组参数能力；
- proxy 侧 key 展开在 v3.3.8 已是单端口，多端口需扩展为多端口集合（每个端口生成一组 key）。

## 六、实施优先级

```
① run()/daemon() 支持数组参数          ← 核心，先做（第四章）
   └─ this.servers[] 替代 this.server
   └─ init/listen 分离
   └─ events 副本
   └─ rundata.listeners

② HTTP 模块多实例化                    ← ①的依赖（4.3/4.4）
   └─ 按 listen target 协议创建独立实例
   └─ 统一 body 接收中间件（413 分支）
   └─ 共享 router/midware/service

③ 配置解析扩展                         ← 最后做，依赖①② API 稳定（第五章）
   └─ 解析 listen/proxy/resource
   └─ 产出 run 参数 + proxy 参数
   └─ 注册 run 后钩子触发 proxy key 展开
```

### 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | `run()` 支持数组，多端口同协议监听 | 单进程监听 80+8080，路由共享 |
| M2 | 多协议混跑（http + https/http2） | 80(http) + 443(http2 兼容) 同时服务 |
| M3 | `daemon()` 支持数组，cluster 多端口 | worker 均监听全部端口 |
| M4 | `ServerConfig` 扩展 | 一份配置完成监听 + 代理 + 静态资源 |
