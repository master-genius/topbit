'use strict'

const Titbit = require('../src/topbit.js')

const app = new Titbit({debug: true})

app.run({port:3456})
