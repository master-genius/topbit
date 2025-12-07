'use strict'

process.chdir(__dirname)

const fs = require('node:fs')
const Topbit = require('../src/topbit.js')

let app = new Topbit({
  debug: true,
  globalLog: true
})

let {ToFile,Timing} = Topbit.extensions

app.pre(new Timing({test: true}))

app.use(new ToFile, {group: 'upload'})

let fsp = fs.promises

fsp.access('./tmp').catch(err => {
  fsp.mkdir('tmp')
})

app.post('/file', async ctx => {
  
  let f = ctx.getFile('file')

  if (!f) return ctx.status(400).oo('file not found')

  ctx.to( await f.toFile('tmp') )

}, {group: 'upload'})

app.run(1234)
