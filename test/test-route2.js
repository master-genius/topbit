'use strict';

// 路由匹配基准（参数密集表：首段即参数，静态表几乎无法命中，全部走线性扫描）。
//
// 与 test-route.js 同样使用运行时拼接的互异路径，避免 V8 的 split 结果缓存造成失真，
// 详见 test-route.js 顶部说明。本脚本可直接复制到任意 topbit 版本目录下运行对比。
// 用法: node test/test-route2.js

const Topbit = require('../src/topbit.js');

const app = new Topbit();

const GROUPS = 50;
for (let i = 0; i < GROUPS; i++) {
  app.get(`/test/:x/${i}/:z/:t`, async c => {});
  app.post(`/test/:x/${i}/:z/:t`, async c => {});
  app.get(`/test/:linux/:unix/${i}`, async c => {}, '@linux-unix' + i);
  app.get(`/test/${i}/*`, async c => {});
}
app.router.argsRouteSort();

const UNIQ = 20000;
function gen(fn) {
  const a = new Array(UNIQ);
  for (let i = 0; i < UNIQ; i++) a[i] = fn(i);
  return a;
}

const SCENES = [
  { name: '五段参数路由命中',
    method: 'GET',
    paths: gen(i => '/test/x' + i + '/' + (i % GROUPS) + '/z' + i + '/t' + i) },

  { name: '四段参数路由命中',
    method: 'GET',
    paths: gen(i => '/test/l' + i + '/u' + i + '/' + (i % GROUPS)) },

  { name: '五段参数路由(POST)',
    method: 'POST',
    paths: gen(i => '/test/x' + i + '/' + (i % GROUPS) + '/z' + i + '/t' + i) },

  { name: '星号路由命中',
    method: 'GET',
    paths: gen(i => '/test/' + (i % GROUPS) + '/a' + i + '/b' + i) },

  { name: '完全不命中',
    method: 'GET',
    paths: gen(i => '/none/' + i + '/x' + i + '/y' + i + '/z' + i + '/w' + i) },

  { name: '含多余斜杠',
    method: 'GET',
    paths: gen(i => '/test/x' + i + '//' + (i % GROUPS) + '///z' + i + '//t' + i) },

  { name: '末尾多斜杠',
    method: 'GET',
    paths: gen(i => '/test/x' + i + '/' + (i % GROUPS) + '/z' + i + '/t' + i + '///') }
];

const N = 300000;

// 单场景模式：node test-route2.js <场景序号>  只跑该场景、只输出耗时(ms)。
// 跨版本对比务必用此模式逐个场景跑——同一进程内串跑多个场景会造成 JIT 交叉污染，
// 早一个场景的编译结果会影响后一个，导致对比失真。
const only = process.argv[2] === undefined ? -1 : parseInt(process.argv[2]);

function run(s) {
  for (let i = 0; i < N / 10; i++) app.router.findRealPath(s.paths[i % UNIQ], s.method);

  let hit = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    if (app.router.findRealPath(s.paths[i % UNIQ], s.method) !== null) hit++;
  }

  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, hit };
}

if (only >= 0) {
  if (only >= SCENES.length) {
    console.error('场景序号超出范围，共 ' + SCENES.length + ' 个');
    process.exit(1);
  }
  console.log(run(SCENES[only]).ms.toFixed(1));
} else {
  console.log(`路由数量 ${app.router.count}，每场景 ${N} 次，${UNIQ} 条互异路径轮换`);
  console.log('跨版本对比请用单场景模式逐个跑，见文件内说明\n');
  console.log('  序号  ' + '场景'.padEnd(22) + '耗时'.padStart(10) + '吞吐'.padStart(16) + '  命中');

  let total = 0;
  SCENES.forEach((s, idx) => {
    const r = run(s);
    total += r.ms;
    console.log(`  [${idx}]   ` + s.name.padEnd(22)
      + (r.ms.toFixed(1) + ' ms').padStart(10)
      + ((N / r.ms / 1000).toFixed(2) + ' M ops/s').padStart(16)
      + `  ${r.hit === N ? '全部命中' : r.hit === 0 ? '全不命中' : r.hit + '/' + N}`);
  });

  console.log(`\n  合计 ${total.toFixed(1)} ms`);
}
