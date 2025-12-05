'use strict'

process.chdir(__dirname)

let Topbit = require('../src/topbit.js')
let {Resource} = Topbit.extensions

let app = new Topbit({
  debug: true,
  loadInfoFile: '--mem',
  globalLog: true,
  logType: 'stdio'
})

if (app.isWorker) {
  app.get('/', async ctx => {
    ctx.ok('ok')
  })

  let rse = new Resource({
    staticPath: './',
    routePath: '/static/*'
  })

  rse.init(app)
}

app.sched('none')

app.autoWorker(3)

app.daemon(1234, 1)
