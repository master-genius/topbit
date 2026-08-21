'use strict';

// defaultServer（default_server）结构测试：归一化、校验、三个代理扩展同构。

const assert = require('node:assert');

const Proxy = require('../src/extends/proxy.js');
const ProxyNoAgent = require('../src/extends/proxyNoAgent.js');
const Http2Proxy = require('../src/extends/http2proxy.js');

const CFG = {
  'a.com:1234': [{ url: 'http://127.0.0.1:3001' }],
  'b.com': [{ url: 'http://127.0.0.1:3002' }]
};

// 三个扩展逐一跑同一组用例，保证同构。
const KINDS = [
  ['Proxy', Proxy],
  ['ProxyNoAgent', ProxyNoAgent],
  ['Http2Proxy', Http2Proxy]
];

for (const [name, Ctor] of KINDS) {

  // 默认值：未设置时为 null，行为退回原状。
  let p0 = new Ctor({ port: 1234, config: CFG });
  assert.strictEqual(p0.defaultHost, null, `${name}: 未设置 defaultServer 时 defaultHost 应为 null`);

  // 纯 host key，原样命中。
  let p1 = new Ctor({ port: 1234, defaultServer: 'a.com:1234', config: CFG });
  assert.strictEqual(p1.defaultHost, 'a.com:1234', `${name}: 纯 host key 应原样命中`);

  // 带 scheme：Host 头 / :authority 按 RFC 无协议前缀，需削掉后才能匹配。
  let p2 = new Ctor({ port: 1234, defaultServer: 'https://a.com:1234', config: CFG });
  assert.strictEqual(p2.defaultHost, 'a.com:1234', `${name}: 应削掉 https:// 前缀`);

  let p3 = new Ctor({ port: 1234, defaultServer: 'http://a.com:1234', config: CFG });
  assert.strictEqual(p3.defaultHost, 'a.com:1234', `${name}: 应削掉 http:// 前缀`);

  // 带 path：削掉第一个 / 之后的部分。
  let p4 = new Ctor({ port: 1234, defaultServer: 'https://a.com:1234/legacy/x', config: CFG });
  assert.strictEqual(p4.defaultHost, 'a.com:1234', `${name}: 应削掉 path`);

  // 归一化后不存在于配置中：告警并保持 null，不改变原有行为。
  let p5 = new Ctor({ port: 1234, defaultServer: 'https://nope.com', config: CFG });
  assert.strictEqual(p5.defaultHost, null, `${name}: 不存在的 key 应忽略并保持 null`);

  // 非字符串：忽略。
  let p6 = new Ctor({ port: 1234, defaultServer: 123, config: CFG });
  assert.strictEqual(p6.defaultHost, null, `${name}: 非字符串应忽略`);

  // 只有 scheme，削完为空：忽略。
  let p7 = new Ctor({ port: 1234, defaultServer: 'https://', config: CFG });
  assert.strictEqual(p7.defaultHost, null, `${name}: 削完为空应忽略`);

  // 非 80/443 端口：setHostProxy 把裸 key 改写成 host:port，
  // defaultServer 允许按 config 里的写法给裸 host，内部补端口后命中。
  let p9 = new Ctor({ port: 1234, defaultServer: 'https://b.com', config: { 'b.com': [{ url: 'http://127.0.0.1:3002' }] } });
  assert.strictEqual(p9.defaultHost, 'b.com:1234', `${name}: 裸 host 应补端口后命中`);

  // 80/443 双 key：port=443 时裸 key 与带端口 key 共享同一后端数组，
  // defaultServer 写成 'https://b.com' 归一化为裸 key，指向的是同一份配置。
  let p8 = new Ctor({ port: 443, defaultServer: 'https://b.com', config: { 'b.com': [{ url: 'http://127.0.0.1:3002' }] } });
  assert.strictEqual(p8.defaultHost, 'b.com', `${name}: port=443 时应命中裸 key`);
  assert.ok(p8.hostProxy['b.com:443'], `${name}: port=443 应同时生成带端口 key`);
  assert.strictEqual(p8.hostProxy['b.com']['/*'], p8.hostProxy['b.com:443']['/*'],
    `${name}: 双 key 应共享同一后端数组`);

  console.log(`PASS ${name}: defaultServer 归一化与校验`);
}

console.log('\ntest-proxy-default-server: 全部通过');
