'use strict';

// routepath 跨 host 降级：路由表是所有 host 的 path 并集，路由匹配在中间件之前
// 且不感知 Host，所以 c.routepath 是"全局最具体"，未必是"该 host 内最具体"。
// 用法: node test/test-proxy-path-fallback.js

const assert = require('node:assert');
const http = require('node:http');
const Topbit = require('../src/topbit.js');
const { Proxy } = Topbit.extensions;

const PORT = 39301;
const BK = { A_API: 39311, A_STATIC: 39312, B_ROOT: 39313, C_V2: 39314 };

for (const [name, port] of Object.entries(BK)) {
  http.createServer((q, r) => r.end(`${name}:${q.url}`)).listen(port);
}

// a.com : /api, /static      b.com : /（只有根）      c.com : /api/v2（只有深路径）
const CFG = {
  'a.com': [
    { path: '/api',    url: `http://127.0.0.1:${BK.A_API}` },
    { path: '/static', url: `http://127.0.0.1:${BK.A_STATIC}` }
  ],
  'b.com': [{ path: '/',       url: `http://127.0.0.1:${BK.B_ROOT}` }],
  'c.com': [{ path: '/api/v2', url: `http://127.0.0.1:${BK.C_V2}` }]
};

const app = new Topbit({ parseBody: false });
const pxy = new Proxy({ port: PORT, config: CFG });
pxy.init(app);

// 应用自有的业务路由：不在 pathTable 里，必须不被代理吞掉
app.get('/admin/:id', async c => c.text(`biz-admin:${c.param.id}`));

app.run(PORT);

// ---- 结构断言：pathFallback 的内容 ----
// port 非 80/443 时 setHostProxy 会把裸 key 改写为 host:port，断言需用改写后的 key
const K = h => `${h}:${PORT}`;

// 全局 pathTable = { '/api/*', '/static/*', '/*', '/api/v2/*' }
assert.strictEqual(pxy.pathFallback[K('a.com')]['/api/v2/*'], '/api/*',
  'a.com 的 /api/v2/* 应降级到自己的 /api/*');
assert.strictEqual(pxy.pathFallback[K('a.com')]['/*'], undefined,
  'a.com 没声明 /，/* 不应有降级项');

assert.strictEqual(pxy.pathFallback[K('b.com')]['/api/*'], '/*', 'b.com 一切降到 /*');
assert.strictEqual(pxy.pathFallback[K('b.com')]['/static/*'], '/*', 'b.com 一切降到 /*');
assert.strictEqual(pxy.pathFallback[K('b.com')]['/api/v2/*'], '/*',
  'b.com 没有 /api，应继续降到 /*');

assert.strictEqual(pxy.pathFallback[K('c.com')], undefined,
  'c.com 只声明深路径且无 /，不应有任何降级项');

assert.strictEqual(pxy.pathFallback[K('a.com')]['/admin/:id'], undefined,
  '业务路由不在 pathTable 里，不应出现在降级映射中');

console.log('PASS pathFallback 预计算内容正确');

// ---- 补充结构断言：最长前缀优先、深层逐级、去重、双 key、原型键 ----
{
  const U = 'http://127.0.0.1:9001';

  // 同一 host 同时有 /api 和 /，全局 /api/v2/* 必须降到更长的 /api/*
  const q1 = new Proxy({ config: {
    'x.com': [{ path: '/', url: U }, { path: '/api', url: U }],
    'y.com': [{ path: '/api/v2', url: U }]
  }});
  q1.buildPathFallback();
  assert.strictEqual(q1.pathFallback['x.com']['/api/v2/*'], '/api/*',
    '多个候选时必须选最长前缀');

  // 深层路径逐级降级
  const q2 = new Proxy({ config: {
    'x.com': [{ path: '/a/b', url: U }],
    'y.com': [{ path: '/a/b/c/d', url: U }],
    'z.com': [{ path: '/', url: U }]
  }});
  q2.buildPathFallback();
  assert.strictEqual(q2.pathFallback['x.com']['/a/b/c/d/*'], '/a/b/*');
  assert.strictEqual(q2.pathFallback['z.com']['/a/b/c/d/*'], '/*');
  assert.strictEqual(q2.pathFallback['y.com'], undefined, 'y 无 / 可降');

  // 多 host 声明相同 path：路由表去重，且不产生降级项
  const q3 = new Proxy({ config: {
    'x.com': [{ path: '/api', url: U }],
    'y.com': [{ path: '/api', url: U }]
  }});
  q3.buildPathFallback();
  assert.deepStrictEqual(Object.keys(q3.pathTable), ['/api/*'], '相同 path 只注册一条');
  assert.strictEqual(q3.pathFallback['x.com'], undefined);

  // 80/443 双 key 的降级表一致
  const q4 = new Proxy({ port: 443, config: {
    'x.com': [{ path: '/', url: U }],
    'y.com': [{ path: '/api', url: U }]
  }});
  q4.buildPathFallback();
  assert.strictEqual(q4.pathFallback['x.com']['/api/*'], '/*');
  assert.strictEqual(q4.pathFallback['x.com:443']['/api/*'], '/*');

  // Host 头由外部控制，所有以 host 为 key 的表都必须无原型
  for (const [name, obj] of [['pathFallback', q4.pathFallback],
                             ['hostProxy', q4.hostProxy],
                             ['proxyBalance', q4.proxyBalance],
                             ['pathTable', q4.pathTable],
                             ['pathFallback 内层', q4.pathFallback['x.com']],
                             ['hostProxy 内层', q4.hostProxy['x.com']],
                             ['proxyBalance 内层', q4.proxyBalance['x.com']]]) {
    assert.strictEqual(Object.getPrototypeOf(obj), null, `${name} 应为无原型对象`);

    for (const evil of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.strictEqual(obj[evil], undefined, `${name}['${evil}'] 应为 undefined`);
    }
  }

  // 降级目标在 hostProxy 与 proxyBalance 中成对存在（getBackend 两者都读）
  const tgt = q4.pathFallback['x.com']['/api/*'];
  assert.ok(q4.hostProxy['x.com'][tgt] && q4.proxyBalance['x.com'][tgt],
    '降级目标的 hostProxy 与 proxyBalance 必须成对存在');

  console.log('PASS 最长前缀优先 / 深层逐级 / 去重 / 双 key / 原型键健壮性');
}

// ---- 端到端 ----
function req(host, path, cb) {
  http.get({ host: '127.0.0.1', port: PORT, path, headers: { host } }, res => {
    let d = '';
    res.on('data', x => d += x);
    res.on('end', () => cb(res.statusCode, d));
  }).on('error', e => cb('ERR', e.message));
}

const cases = [
  ['a.com', '/api/x',       'A_API:/api/x',        'a.com 直接命中 /api'],
  ['a.com', '/static/x',    'A_STATIC:/static/x',  'a.com 直接命中 /static'],
  ['a.com', '/api/v2/x',    'A_API:/api/v2/x',     'a.com 的 /api/v2 降级到自己的 /api'],
  ['a.com', '/other',       '',                    'a.com 没声明 / → 未命中'],

  ['b.com', '/',            'B_ROOT:/',            'b.com 直接命中 /'],
  ['b.com', '/api/x',       'B_ROOT:/api/x',       'b.com 的 /api 降级到 /，路径完整转发'],
  ['b.com', '/static/x',    'B_ROOT:/static/x',    'b.com 的 /static 降级到 /'],
  ['b.com', '/api/v2/x',    'B_ROOT:/api/v2/x',    'b.com 的 /api/v2 连降两级到 /'],

  ['c.com', '/api/v2/x',    'C_V2:/api/v2/x',      'c.com 直接命中 /api/v2'],
  ['c.com', '/api/x',       '',                    'c.com 无 / 可降 → 未命中（nginx 同样 404）'],

  ['b.com', '/admin/7',     'biz-admin:7',         '业务路由不被代理吞掉']
];

setTimeout(() => {
  let i = 0, failed = 0;

  const next = () => {
    if (i >= cases.length) {
      console.log(`\ntest-proxy-path-fallback: ${failed === 0 ? '全部通过' : failed + ' 个用例失败'}`);
      process.exit(failed === 0 ? 0 : 1);
    }

    const [host, path, expect, desc] = cases[i++];

    req(host + ':' + PORT, path, (code, body) => {
      const pass = body === expect;
      if (!pass) failed++;
      console.log(`${pass ? 'PASS' : 'FAIL'} ${desc}`);
      if (!pass) console.log(`     期望 ${JSON.stringify(expect)}，实际 ${code} ${JSON.stringify(body)}`);
      next();
    });
  };

  next();
}, 400);
