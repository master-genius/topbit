'use strict';

// 路由匹配基准（静态 + 参数 + 星号混合表）。
//
// 重要：路径必须在运行时拼接生成，不能用源码里的字面量。V8 对 String.prototype.split
// 有结果缓存，重复 split 同一个字面量字符串会走缓存快路径，而真实服务里 path 是报文
// 解析器每个请求新构造的字符串，缓存永不命中。用字面量测会严重低估不依赖 split 的
// 实现的优势，导致新旧版本对比失真。
//
// 本脚本只用 app.get/post 与 app.router.findRealPath，可直接复制到任意 topbit 版本
// 目录下运行，输出格式一致，便于横向对比。
// 用法: node test/test-route.js

const Topbit = require('../src/topbit.js');

const app = new Topbit();

const GROUPS = 50;
for (let i = 0; i < GROUPS; i++) {
  app.get(`/test/x/${i}/:z/:t`, async c => {});
  app.post(`/test/x/${i}/:z/:t`, async c => {});
  app.get(`/test/linux/unix/${i}`, async c => {});
  app.get(`/test/${i}/*`, async c => {});
}
app.router.argsRouteSort();

const UNIQ = 20000;

// 运行时拼接，保证是新构造的字符串
function gen(fn) {
  const a = new Array(UNIQ);
  for (let i = 0; i < UNIQ; i++) a[i] = fn(i);
  return a;
}

const SCENES = [
  { name: '静态路由命中',
    method: 'GET',
    paths: gen(i => '/test/linux/unix/' + (i % GROUPS)) },

  { name: '参数路由命中',
    method: 'GET',
    paths: gen(i => '/test/x/' + (i % GROUPS) + '/z' + i + '/t' + i) },

  { name: '参数路由命中(POST)',
    method: 'POST',
    paths: gen(i => '/test/x/' + (i % GROUPS) + '/z' + i + '/t' + i) },

  { name: '星号路由命中',
    method: 'GET',
    paths: gen(i => '/test/' + (i % GROUPS) + '/a' + i + '/b' + i + '/c' + i) },

  { name: '完全不命中',
    method: 'GET',
    paths: gen(i => '/nomatch/' + i + '/deep' + i) },

  { name: '含多余斜杠',
    method: 'GET',
    paths: gen(i => '//test//x//' + (i % GROUPS) + '//z' + i + '//t' + i) }
];

const N = 500000;

// 单场景模式：node test-route.js <场景序号>  只跑该场景、只输出耗时(ms)。
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
