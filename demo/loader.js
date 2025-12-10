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

app.autoWorker(12)

app.daemon(1234, 5)

//console.log(app.midware.midGroup)
//console.log({...app.router})