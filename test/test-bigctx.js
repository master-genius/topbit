'use'

const Topbit = require('../src/topbit.js');

let app = new Topbit({
  debug: true,
  //http2: true
});

let start_time = Date.now()

let ctx = null

let total = 20000

for (let i=0; i < total; i++) {
  ctx = new app.httpServ.Context()
  ctx.path = '/';
  ctx.ip = '127.0.0.1';
  ctx.requestCall = c => {
    c.to('success')
  }

  ctx.box.rand = Math.random()
  ctx = null
}

let end_time = Date.now()

let rtm = end_time - start_time;

console.log(rtm, 'ms', `${parseInt(total * 1000 / rtm)}/s`)
