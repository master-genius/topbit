'use strict';

/**
 * Array.isArray 替代 instanceof Array 的正确性验证
 *
 * 全仓原有 20 处 `x instanceof Array`，已统一为 `Array.isArray(x)`。
 * 这不只是写法统一：两者在两种情形下结论相反，且都是 instanceof 判错。
 *
 *   跨 realm 数组（vm / worker / 不同 iframe）：原型链指向另一个 realm 的
 *   Array.prototype，instanceof 判 false，但它确实是数组；
 *
 *   Object.create(Array.prototype)：原型链上有 Array.prototype，instanceof
 *   判 true，但它并不是数组，没有 length 也没有索引元素。
 *
 * 对代理扩展尤其相关：配置对象可能来自 require 进来的配置文件、JSON 反序列化，
 * 或由上层应用（如网关）在别处构造后传入。
 */

const vm = require('node:vm');
const Topbit = require('../src/topbit.js');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : '\x1b[31mFAIL\x1b[0m'} ${name}${extra ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
}

//---------- 两者的分歧点 ----------
{
  const foreign = vm.runInNewContext('[1,2,3]');
  const fake = Object.create(Array.prototype);

  check('跨 realm 数组：instanceof 判错', (foreign instanceof Array) === false);
  check('跨 realm 数组：isArray 判对', Array.isArray(foreign) === true);
  check('Object.create(Array.prototype)：instanceof 判错', (fake instanceof Array) === true);
  check('Object.create(Array.prototype)：isArray 判对', Array.isArray(fake) === false);
}

//---------- 源码里不应再有 instanceof Array ----------
{
  const fs = require('node:fs');
  const path = require('node:path');

  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (line.includes('instanceof Array')) hits.push(`${p}:${i + 1}`);
      });
    }
  })(path.join(__dirname, '../src'));

  check('src/ 下无残留 instanceof Array', hits.length === 0, hits.join(' '));
}

//---------- 跨 realm 配置：代理扩展应当正常接受 ----------
{
  const { Proxy, ProxyNoAgent, Http2Proxy } = Topbit.extensions;

  //在另一个 realm 里构造与真实配置同形的对象，数组来自该 realm
  const cfg = vm.runInNewContext(`
    ({ 'x.com': [ { path: '/api', url: 'http://127.0.0.1:9001' } ] })
  `);

  check('配置里的数组确实来自其他 realm',
        (cfg['x.com'] instanceof Array) === false && Array.isArray(cfg['x.com']) === true);

  for (const [name, Cls] of [['Proxy', Proxy], ['ProxyNoAgent', ProxyNoAgent], ['Http2Proxy', Http2Proxy]]) {
    //每个扩展各用一份独立副本，避免 setHostProxy 就地改写互相影响
    const own = vm.runInNewContext(`
      ({ 'x.com': [ { path: '/api', url: 'http://127.0.0.1:9001' } ] })
    `);
    //注意：Http2Proxy 的选项解析只认 config，不认 host（proxy / proxyNoAgent 两者都认），
    //这里统一用两边都支持的 config
    const px = new Cls({ port: 0, config: own });
    const keys = Object.keys(px.hostProxy['x.com'] || {});
    check(`${name} 接受跨 realm 配置数组`, keys.includes('/api/*'),
          `pathTable=${JSON.stringify(Object.keys(px.pathTable))}`);
    if (typeof px.stopAliveCheck === 'function') px.stopAliveCheck();
  }
}

//---------- 跨 realm 数组用作 cors / referer 选项 ----------
{
  const { Cors, Referer } = Topbit.extensions;

  const methods = vm.runInNewContext(`['GET','POST']`);
  const cors = new Cors({ methods });
  check('Cors 接受跨 realm 的 methods 数组',
        Array.isArray(cors.methods) || typeof cors.methods === 'string',
        JSON.stringify(cors.methods));

  const hosts = vm.runInNewContext(`['a.com','b.com']`);
  const ref = new Referer({ allow: hosts });
  check('Referer 接受跨 realm 的 allow 数组',
        Array.isArray(ref.allow) && ref.allow.length === 2, JSON.stringify(ref.allow));
}

console.log(`\n结果: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
