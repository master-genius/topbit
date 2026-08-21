'use strict';

// defaultServer 端到端测试。同时验证 C1：一个进程内构造多个 Topbit 实例并各自 run()。
// 用法: node test/test-default-server-e2e.js

const http = require('node:http');
const net = require('node:net');
const Topbit = require('../src/topbit.js');
const { Proxy } = Topbit.extensions;

const BK_A = 39101;      // a.com 的后端
const BK_DEF = 39102;    // default_server 的后端
const PORT_WITH = 39201; // 配了 defaultServer 的实例
const PORT_WITHOUT = 39202; // 没配 defaultServer 的实例
const PORT_FULL = 39203;    // full 模式 + defaultServer 的实例
const PORT_MISS = 39204;    // defaultServer + 自定义未命中处理的实例

http.createServer((q, r) => r.end('backend-a')).listen(BK_A);
http.createServer((q, r) => r.end('backend-default')).listen(BK_DEF);

// a.com 只声明 /api，legacy.com 声明 /。
// 于是 pathTable = { '/api/*', '/*' }，可以分别构造出
// 「host 未命中」与「host 命中但路由未命中」两种情形。
const CFG = {
  'a.com': [{ path: '/api', url: `http://127.0.0.1:${BK_A}` }],
  'legacy.com': [{ path: '/', url: `http://127.0.0.1:${BK_DEF}` }]
};

// 实例一：配 defaultServer（故意写成带 scheme 的形式，验证归一化）
const app1 = new Topbit({ parseBody: false });
new Proxy({
  port: PORT_WITH,
  defaultServer: 'https://legacy.com',
  config: JSON.parse(JSON.stringify(CFG))
}).init(app1);
app1.run(PORT_WITH);

// 实例二：不配 defaultServer —— 构造第二个实例本身就是 C1 的验证
const app2 = new Topbit({ parseBody: false });
new Proxy({
  port: PORT_WITHOUT,
  config: JSON.parse(JSON.stringify(CFG))
}).init(app2);
app2.run(PORT_WITHOUT);

// 实例三：full 模式 + defaultServer。
// 注意 mid() 里回退发生在 full 判定之前，所以 full 模式下未知 host 不再 502，
// 而是被 defaultServer 接走——这是给 full 用户新增 defaultServer 时的行为变化。
const app3 = new Topbit({ parseBody: false });
new Proxy({
  port: PORT_FULL,
  full: true,
  defaultServer: 'legacy.com',
  config: JSON.parse(JSON.stringify(CFG))
}).init(app3);
app3.run(PORT_FULL);

// 实例四：defaultServer + 自定义未命中处理。
// proxy.init() 注册路由时用的是 '@topbit_proxy'，router.addPath 把 @ 开头的 name
// 解释为分组（router.js addPath），所以代理注册的所有路径都归属分组 topbit_proxy。
// 往该分组挂普通中间件即可接管未命中的请求：它排在 pre 的代理中间件下游，
// 代理命中时不会执行（代理不调 next），且不影响应用自有路由。
const app4 = new Topbit({ parseBody: false });
new Proxy({
  port: PORT_MISS,
  defaultServer: 'legacy.com',
  config: JSON.parse(JSON.stringify(CFG))
}).init(app4);

app4.use(async (c, next) => c.status(404).html('MISS-404'), '@topbit_proxy');
app4.get('/biz', async c => c.text('biz-ok'));
app4.run(PORT_MISS);

function req(port, host, path, cb) {
  const r = http.request({ host: '127.0.0.1', port, path, headers: { host } }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => cb(res.statusCode, d));
  });
  r.on('error', e => cb('ERR', e.message));
  r.end();
}

// HTTP/1.0 不带 Host 头。此时 ctx.host 回退为监听地址（http1.js:115 的 self.host，
// run() 里算出的是 '0.0.0.0:<port>'），必然不是任何配置 key，应被 defaultServer 接走。
function rawNoHost(port, cb) {
  const sock = net.connect(port, '127.0.0.1', () => {
    sock.write('GET / HTTP/1.0\r\n\r\n');
  });

  let buf = '';
  sock.on('data', d => buf += d);
  sock.on('end', () => cb(buf));
  sock.on('error', e => cb('ERR:' + e.message));
}

const cases = [
  { desc: 'host 命中 + 路由命中 → 正常代理',
    port: PORT_WITH, host: 'a.com:' + PORT_WITH, path: '/api/x', expect: 'backend-a' },

  { desc: 'host 未命中 + 路由命中 → 回退 defaultServer',
    port: PORT_WITH, host: 'unknown.com:' + PORT_WITH, path: '/', expect: 'backend-default' },

  { desc: 'host 命中 + 路由未命中 → 不回退 defaultServer（空响应）',
    port: PORT_WITH, host: 'a.com:' + PORT_WITH, path: '/', expect: '__empty__' },

  { desc: '已知差异：host 未命中但该 routepath 不在 default host 表内 → 空响应',
    port: PORT_WITH, host: 'unknown.com:' + PORT_WITH, path: '/api/x', expect: '__empty__' },

  { desc: '未配 defaultServer：host 未命中 → 空响应（默认行为不变）',
    port: PORT_WITHOUT, host: 'unknown.com:' + PORT_WITHOUT, path: '/', expect: '__empty__' },

  { desc: '未配 defaultServer：host 命中 → 正常代理（第二个实例可用，C1 生效）',
    port: PORT_WITHOUT, host: 'a.com:' + PORT_WITHOUT, path: '/api/x', expect: 'backend-a' },

  { desc: 'full 模式 + defaultServer：未知 host 走回退而非 502',
    port: PORT_FULL, host: 'unknown.com:' + PORT_FULL, path: '/', expect: 'backend-default' },

  { desc: 'full 模式 + defaultServer：host 命中 → 正常代理',
    port: PORT_FULL, host: 'a.com:' + PORT_FULL, path: '/api/x', expect: 'backend-a' },

  { desc: '自定义未命中处理：host 未命中 → defaultServer 先接管',
    port: PORT_MISS, host: 'unknown.com:' + PORT_MISS, path: '/', expect: 'backend-default' },

  { desc: '自定义未命中处理：host 命中但路由未命中 → 自定义 404',
    port: PORT_MISS, host: 'a.com:' + PORT_MISS, path: '/', expect: 'MISS-404' },

  { desc: '自定义未命中处理：不影响应用自有路由',
    port: PORT_MISS, host: 'a.com:' + PORT_MISS, path: '/biz', expect: 'biz-ok' },

  { desc: '自定义未命中处理：代理命中时不执行',
    port: PORT_MISS, host: 'a.com:' + PORT_MISS, path: '/api/x', expect: 'backend-a' }
];

let failed = 0;

const runHttpCases = (done) => {
  let i = 0;

  const next = () => {
    if (i >= cases.length) return done();

    const t = cases[i++];

    req(t.port, t.host, t.path, (code, body) => {
      // proxy.init() 会给 pathTable 里每条 path 注册一个空 handler（proxy.js:1013），
      // 所以代理未命中时是 next() → 空 handler → 200 空响应，而不是 404。
      // 只有 path 完全不在路由表里才会在中间件之前就 404。
      const pass = t.expect === '__empty__'
        ? (code === 200 && body === '')
        : body.includes(t.expect);

      if (!pass) failed++;

      console.log(`${pass ? 'PASS' : 'FAIL'} ${t.desc}`);
      console.log(`     Host=${t.host} ${t.path} => ${code} ${JSON.stringify(body.slice(0, 40))}`);

      next();
    });
  };

  next();
};

setTimeout(() => {
  runHttpCases(() => {
    // 无 Host 头（HTTP/1.0）：ctx.host 回退为监听地址，应被 defaultServer 接走
    rawNoHost(PORT_WITH, raw => {
      const ok = raw.includes('backend-default');
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'} 无 Host 头（HTTP/1.0）→ 回退 defaultServer`);
      console.log(`     ${JSON.stringify(raw.split('\r\n\r\n').pop().slice(0, 40))}`);

      // 对照：没配 defaultServer 的实例，无 Host 头应是空响应
      rawNoHost(PORT_WITHOUT, raw2 => {
        const body2 = raw2.split('\r\n\r\n').pop();
        const ok2 = body2 === '';
        if (!ok2) failed++;
        console.log(`${ok2 ? 'PASS' : 'FAIL'} 无 Host 头 + 未配 defaultServer → 空响应`);

        console.log(`\ntest-default-server-e2e: ${failed === 0 ? '全部通过' : failed + ' 个用例失败'}`);
        process.exit(failed === 0 ? 0 : 1);
      });
    });
  });
}, 400);
