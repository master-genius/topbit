'use strict';

/**
 * Http2Pool 重连退避阶梯
 *
 * 间隔按 reconnLadder 逐级放大，走完一轮回到第一级循环，而不是停在最大间隔上。
 * 单调递增的退避一旦爬到最大值就不再回头，后端早已恢复却仍要空等一整个长间隔
 * 才被发现——这个可用性窟窿完全由退避策略自己造成。
 */

const Http2Pool = require('../src/extends/Http2Pool.js');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
}

/**
 * 采集前 n 次重连的间隔。
 * 不真的等待——替换 setTimeout 记录传入的 delay，立即触发下一轮调度。
 */
function collect(pool, n) {
  const delays = [];
  const realSetTimeout = global.setTimeout;

  global.setTimeout = (fn, ms) => {
    delays.push(ms);
    return { unref() {} };      //不执行回调，避免真的去建连接
  };

  try {
    for (let i = 0; i < n; i++) {
      pool._reconnTimer = null;   //模拟上一轮定时器已触发
      pool._scheduleReconnect();
    }
  } finally {
    global.setTimeout = realSetTimeout;
  }

  return delays;
}

function makePool(opts = {}) {
  //构造器可能立即尝试建连接，这里只关心调度逻辑：屏蔽掉真实的定时器与建连
  const realSetTimeout = global.setTimeout;
  global.setTimeout = () => ({unref() {}});

  let p;
  try {
    p = new Http2Pool(Object.assign({url: 'http://127.0.0.1:1'}, opts));
    p._createConnection = () => null;
  } finally {
    global.setTimeout = realSetTimeout;
  }

  p.sessions = [];
  p._reconnTimer = null;
  p._reconnAttempts = 0;
  return p;
}

//---- 默认阶梯 ----
{
  const p = makePool();
  check('默认基准为 500ms', p.reconnDelay === 500, String(p.reconnDelay));
  check('默认阶梯为 [1,2,4,8,16,32]',
        JSON.stringify(p.reconnLadder) === '[1,2,4,8,16,32]', JSON.stringify(p.reconnLadder));

  const d = collect(p, 14);
  const want = [500, 1000, 2000, 4000, 8000, 16000,
                500, 1000, 2000, 4000, 8000, 16000,
                500, 1000];

  check('序列为 500ms→1s→2s→4s→8s→16s 后回到 500ms 循环',
        JSON.stringify(d) === JSON.stringify(want),
        d.map(v => v >= 1000 ? v / 1000 + 's' : v + 'ms').join(' → '));

  check('封顶为 16s，不会超过', Math.max(...d) === 16000, String(Math.max(...d)));
  check('每轮都有一次 500ms 快速探测',
        d.filter(v => v === 500).length === 3, `出现 ${d.filter(v => v === 500).length} 次`);
}

//---- 连接成功后归零，下次从第一级重新开始 ----
{
  const p = makePool();
  collect(p, 4);                       //爬到第 5 级
  p._reconnAttempts = 0;               //模拟连接成功（_createConnection 成功时归零）
  const d = collect(p, 2);
  check('连接成功后退避归零，重新从 500ms 起', d[0] === 500 && d[1] === 1000, d.join(','));
}

//---- 基准可调，阶梯形状不变 ----
{
  const p = makePool({reconnDelay: 50});
  const d = collect(p, 7);
  check('调小基准后整体按比例加快',
        JSON.stringify(d) === JSON.stringify([50, 100, 200, 400, 800, 1600, 50]), d.join(','));
}

//---- 自定义阶梯 ----
{
  const p = makePool({reconnDelay: 100, reconnLadder: [1, 3]});
  const d = collect(p, 5);
  check('自定义 reconnLadder 生效并循环',
        JSON.stringify(d) === JSON.stringify([100, 300, 100, 300, 100]), d.join(','));
}

//---- 非法阶梯回退到默认 ----
{
  for (const bad of [[], [0, 1], ['a'], [-5], 'x', {}]) {
    const p = makePool({reconnLadder: bad});
    if (JSON.stringify(p.reconnLadder) !== '[1,2,4,8,16,32]') {
      check(`非法 reconnLadder ${JSON.stringify(bad)} 应回退默认`, false,
            JSON.stringify(p.reconnLadder));
    }
  }
  check('非法 reconnLadder 一律回退默认阶梯', true);
}

//---- 同一时刻只保留一个在途任务 ----
{
  const p = makePool();
  const realSetTimeout = global.setTimeout;
  let calls = 0;
  global.setTimeout = (fn, ms) => { calls++; return {unref(){}}; };
  try {
    p._scheduleReconnect();
    p._scheduleReconnect();       //已有在途任务，应直接返回
    p._scheduleReconnect();
  } finally {
    global.setTimeout = realSetTimeout;
  }
  check('已有在途重连任务时不重复调度', calls === 1, `调度 ${calls} 次`);
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
