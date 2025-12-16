'use strict'

const Topbit = require('../src/topbit.js')

const app = new Topbit({debug: true})

app.daemon({port:3456, host: '127.0.0.1', worker: 2})
