'use strict'

const Topbit = require('../src/topbit.js')

const app = new Topbit({
  debug: true,
  http2: true,
  loadInfoFile: '/tmp/loadinfo.log',
  globalLog: true,
  monitorTimeSlice: 512,
  timeout: 0
})

app.use(async (c, next) => {
  c.setHeader('x-set-key', `${parseInt(Math.random() * 10000) + Date.now()}`)
  await next(c)
})

app.get('/header', async c => {
  c.to(c.headers)
})

app.get('/', async c => {
  c.to(Math.random())
})

app.get('/:name/:age/:mobile/:info', async c => {
  c.to(c.param)
})

app.post('/p', async c => {
  c.to(c.body)
})

let port = 2022
let port_ind = process.argv.indexOf('--port')

if (port_ind > 0 && port_ind < process.argv.length - 1) {
  port = parseInt(process.argv[port_ind + 1])

  if (typeof port !== 'number')
    port = 2022
}

app.run(port)
