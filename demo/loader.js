'use strict'

process.chdir(__dirname)

let Topbit = require('../src/topbit.js')
let {Loader} = Topbit

let app = new Topbit({
  debug: true,
  loadInfoFile: '--mem',
})

if (app.isWorker) {
  app.get('/', async ctx => {
    ctx.ok('ok')
  })

  let ld = new Loader()

  ld.init(app)
}

app.sched('none')
  .autoWorker(12)
  .printServInfo(100)
  .daemon(1234, 5)

//console.log(app.midware.midGroup)
//console.log({...app.router})