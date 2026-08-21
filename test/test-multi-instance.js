'use strict';

// C1：单例限制从构造期下移到 daemon()。
// 1) 一个进程内可以构造多个 Topbit 实例并各自 run()；
// 2) 一个进程内只允许一个实例调用 daemon()（cluster 是进程级独占资源）。
// 用法: node test/test-multi-instance.js

const assert = require('node:assert');
const cluster = require('node:cluster');
const http = require('node:http');
const Topbit = require('../src/topbit.js');

// ---- 场景 1：构造多个实例不再抛错 ----
const a = new Topbit({ parseBody: false });
const b = new Topbit({ parseBody: false });
const c = new Topbit({ parseBody: false });
console.log('PASS 一个进程内构造 3 个实例不抛错');

if (cluster.isWorker) {
  // worker 分支只做 run()，用于场景 3 的 fork 目标，直接静默退出即可。
  process.exit(0);
}

// ---- 场景 2：多个实例各自 run() 不同端口，互不干扰 ----
a.get('/', async ctx => ctx.text('from-a'));
b.get('/', async ctx => ctx.text('from-b'));
a.run(39401);
b.run(39402);

function get(port, cb) {
  http.get({ host: '127.0.0.1', port, path: '/' }, res => {
    let d = '';
    res.on('data', x => d += x);
    res.on('end', () => cb(d));
  }).on('error', e => cb('ERR:' + e.message));
}

setTimeout(() => {
  get(39401, ra => {
    get(39402, rb => {
      assert.strictEqual(ra, 'from-a', '实例 a 应返回自己的内容');
      assert.strictEqual(rb, 'from-b', '实例 b 应返回自己的内容');
      console.log('PASS 两个实例各自 run() 不同端口，互不干扰');

      // ---- 场景 3：第二个 daemon() 抛错 ----
      c.get('/', async ctx => ctx.text('from-c'));
      c.daemon(39403, 1);   // 第 1 个 daemon：primary 分支，fork 1 个 worker

      const d = new Topbit({ parseBody: false });

      assert.throws(
        () => d.daemon(39404, 1),
        /一个进程只能有一个topbit实例调用daemon/,
        '第二个 daemon() 应抛错'
      );
      console.log('PASS 同一进程第二次 daemon() 抛错');

      // 清理 fork 出来的 worker
      for (const id in cluster.workers) cluster.workers[id].process.kill('SIGKILL');

      console.log('\ntest-multi-instance: 全部通过');
      process.exit(0);
    });
  });
}, 300);
