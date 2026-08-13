'use strict';

const assert = require('node:assert');
const Proxy = require('../src/extends/proxy.js');

// 场景1：port=1234，裸 key → 替换为带端口
let p1 = new Proxy({ port: 1234, config: { 'x.com': [{ url: 'http://127.0.0.1:3001' }] } });
assert.ok(p1.hostProxy['x.com:1234'], 'port=1234 应生成 x.com:1234');
assert.ok(!p1.hostProxy['x.com'], 'port=1234 不应保留裸 x.com');

// 场景2：port=443 → 双 key（裸 + 带端口），同引用
let p2 = new Proxy({ port: 443, config: { 'x.com': [{ url: 'http://127.0.0.1:3001' }] } });
assert.ok(p2.hostProxy['x.com'], 'port=443 应保留裸 x.com');
assert.ok(p2.hostProxy['x.com:443'], 'port=443 应生成 x.com:443');
assert.strictEqual(p2.hostProxy['x.com']['/*'], p2.hostProxy['x.com:443']['/*'], '双 key 应共享同一数组');
assert.strictEqual(p2.proxyBalance['x.com']['/*'], p2.proxyBalance['x.com:443']['/*'], '双 key 应共享同一 balance');

// 场景3：不传 port → 裸 key 原样
let p3 = new Proxy({ config: { 'x.com': [{ url: 'http://127.0.0.1:3001' }] } });
assert.ok(p3.hostProxy['x.com'], '不传 port 应保留裸 x.com');
assert.ok(!p3.hostProxy['x.com:1234'], '不传 port 不应生成带端口 key');

// 场景4：key 已带端口且与 port 匹配 → 不重复拼接
let p4 = new Proxy({ port: 1234, config: { 'x.com:1234': [{ url: 'http://127.0.0.1:3001' }] } });
assert.ok(p4.hostProxy['x.com:1234'], '带端口 key 应直接使用');
assert.ok(!p4.hostProxy['x.com'], '带端口 key 不应额外生成裸 key');

// 场景5：port=0 / '' → 不拼接
let p5 = new Proxy({ port: 0, config: { 'x.com': [{ url: 'http://127.0.0.1:3001' }] } });
assert.ok(p5.hostProxy['x.com'] && !p5.hostProxy['x.com:0'], 'port=0 不拼接');
let p5b = new Proxy({ port: '', config: { 'x.com': [{ url: 'http://127.0.0.1:3001' }] } });
assert.ok(p5b.hostProxy['x.com'] && !p5b.hostProxy['x.com:'], "port='' 不拼接");

// 场景6：字符串端口 '443' → 双 key
let p6 = new Proxy({ port: '443', config: { 'x.com': [{ url: 'http://127.0.0.1:3001' }] } });
assert.ok(p6.hostProxy['x.com:443'], "字符串端口 '443' 应生成 x.com:443");

// 场景7：多 backend 时双 key 共享同一数组
let p7 = new Proxy({ port: 443, config: { 'x.com': [
  { url: 'http://127.0.0.1:3001' },
  { url: 'http://127.0.0.1:3002' }
] } });
assert.strictEqual(p7.hostProxy['x.com']['/*'].length, 2, '双 key 数组应有 2 个 backend');
assert.strictEqual(p7.hostProxy['x.com:443']['/*'].length, 2, '双 key 数组应共享');
assert.strictEqual(p7.hostProxy['x.com']['/*'], p7.hostProxy['x.com:443']['/*'], '双 key 数组应同引用');

// 场景8：proxyNoAgent 同样生效
const ProxyNoAgent = require('../src/extends/proxyNoAgent.js');
let p8 = new ProxyNoAgent({ port: 443, config: { 'x.com': [{ url: 'http://127.0.0.1:3001' }] } });
assert.ok(p8.hostProxy['x.com'] && p8.hostProxy['x.com:443'], 'proxyNoAgent 双 key 应生成');
assert.strictEqual(p8.hostProxy['x.com']['/*'], p8.hostProxy['x.com:443']['/*'], 'proxyNoAgent 双 key 同引用');

// 场景9：init 定时器跳过 :443 别名 key（proxy.js）
const mockApp = { config: { timeout: 0 }, router: { map: () => {} }, use: () => {} };
let p9 = new Proxy({ port: 443, config: { 'x.com': [
  { url: 'http://127.0.0.1:3001', aliveCheckInterval: 2 }
] } });
p9.init(mockApp);
assert.ok(typeof p9.proxyIntervals['x.com'] === 'object'
          && !!p9.proxyIntervals['x.com']['/*'],
  '裸 key 应建立 alive 定时器');
assert.ok(p9.proxyIntervals['x.com:443'] === undefined, ':443 别名 key 不应建立定时器');
for (let k in p9.proxyIntervals) {
  for (let p in p9.proxyIntervals[k]) clearInterval(p9.proxyIntervals[k][p]);
}

// 场景10：proxyNoAgent 的 init 同样跳过 :443
let p10 = new ProxyNoAgent({ port: 443, config: { 'x.com': [
  { url: 'http://127.0.0.1:3001', aliveCheckInterval: 2 }
] } });
p10.init(mockApp);
assert.ok(typeof p10.proxyIntervals['x.com'] === 'object'
          && !!p10.proxyIntervals['x.com']['/*'],
  'proxyNoAgent 裸 key 应建立 alive 定时器');
assert.ok(p10.proxyIntervals['x.com:443'] === undefined, 'proxyNoAgent :443 别名 key 不应建立定时器');
for (let k in p10.proxyIntervals) {
  for (let p in p10.proxyIntervals[k]) clearInterval(p10.proxyIntervals[k][p]);
}

// 场景11：port 为空 + 手工带端口 key → 自动补裸，双 key 共享
let p11 = new Proxy({ config: { 'x.com:443': [
  { url: 'http://127.0.0.1:3001', aliveCheckInterval: 2 }
] } });
p11.init(mockApp);
assert.ok(!!p11.hostProxy['x.com'] && !!p11.hostProxy['x.com:443'], 'port 空 + :443 key 应补裸生成双 key');
assert.strictEqual(p11.hostProxy['x.com']['/*'], p11.hostProxy['x.com:443']['/*'], '双 key 共享同一数组');
assert.ok(!!p11.proxyIntervals['x.com']['/*'], '补裸后裸 key 应建立 timer');
assert.ok(p11.proxyIntervals['x.com:443'] === undefined, ':443 别名应跳过 timer');
for (let k in p11.proxyIntervals) {
  for (let p in p11.proxyIntervals[k]) clearInterval(p11.proxyIntervals[k][p]);
}

// 场景12：port=443 + 裸 key 展开双 key → :443 别名跳过（对照场景11）
let p12 = new Proxy({ port: 443, config: { 'x.com': [
  { url: 'http://127.0.0.1:3001', aliveCheckInterval: 2 }
] } });
p12.init(mockApp);
assert.ok(!!p12.proxyIntervals['x.com']['/*'], '双 key 场景裸 key 应建立 timer');
assert.ok(p12.proxyIntervals['x.com:443'] === undefined, '双 key 场景 :443 别名应跳过');
for (let k in p12.proxyIntervals) {
  for (let p in p12.proxyIntervals[k]) clearInterval(p12.proxyIntervals[k][p]);
}

// 场景13：port=443 + 带端口 key → 补裸，双 key 共享
let p13 = new Proxy({ port: 443, config: { 'x.com:443': [
  { url: 'http://127.0.0.1:3001' }
] } });
assert.ok(p13.hostProxy['x.com'] && p13.hostProxy['x.com:443'], 'port=443 + 带端口 key 应补裸双 key');
assert.strictEqual(p13.hostProxy['x.com']['/*'], p13.hostProxy['x.com:443']['/*'], '双 key 共享');

// 场景14：同时配裸 + 带端口 key（port=443）→ 合并到先出现，共享同一数组
let p14 = new Proxy({ port: 443, config: {
  'x.com': [{ url: 'http://127.0.0.1:3001' }],
  'x.com:443': [{ url: 'http://127.0.0.1:3002' }]
} });
assert.ok(p14.hostProxy['x.com'] && p14.hostProxy['x.com:443'], '双 key 存在');
assert.strictEqual(p14.hostProxy['x.com']['/*'], p14.hostProxy['x.com:443']['/*'], '双 key 共享同一数组');
assert.strictEqual(p14.hostProxy['x.com']['/*'].length, 2, '两个 backend 合并到同一数组（先出现为准）');

console.log('proxy port 结构测试全部通过');
