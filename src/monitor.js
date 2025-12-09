'use strict';

const cluster = require('node:cluster');
const os = require('node:os');
const fs = require('node:fs');
const process = require('node:process');

const hrtime = process.hrtime

class Monitor {

  constructor(options) {
    this.config = options.config
    this.workers = options.workers
    this.rundata = options.rundata
    this.secure = options.secure

    this.workerCount = options.workerCount

    this.isLoadObj = ['obj', 'orgobj'].includes(this.config.loadInfoType)

    this.rundata.cpus = os.cpus().length

    this.loadCount = 0
    this.loadInfo = {}

    this.sendInterval = null

    this.loadCache = null

    this.cpuLastTime = hrtime.bigint() - 1n

    this.cpuNowTime = hrtime.bigint()

    //this.cpuPercentFactor = 10 * this.rundata.cpus;
    this.cpuHighRatio = 0

    this.cooling = 0

    //用于自动检测是否需要创建worker的节拍记录。
    this.clock = 0

    //worker进程发送请求状况的时间片。
    this.timeSlice = this.config.monitorTimeSlice

    this.maxLife = 500

    this.maxCooling = 100000

    this.life = 20

    this.maxRate = this.config.maxLoadRate

    this.loadfd = null

    this.ipcMsgCache = {
      type: '_load',
      pid: 0,
      cpu: null,
      cputm: 0,
      mem: null,
      conn: 0
    }

     this.loadjson = {
        masterPid : process.pid,
        listen : `${this.rundata.host}:${this.rundata.port}`,
        CPULoadavg : {
          '1m' : '0',
          '5m' : '0',
          '15m' : '0'
        },
        https: this.config.https,
        http2: this.config.http2,
        workers : []
    }

    queueMicrotask(() => {
      this.loadjson.listen = `${this.rundata.host}:${this.rundata.port}`
    })

  }

  autoWorker() {
    if (this.clock < this.workerCount.cur) {
      this.clock += 1
      return;
    }

    this.clock = 0

    if (this.workerCount.cur < this.workerCount.max) {
      let cpuratio = 0

      for (let k in this.workers) {
        cpuratio = (this.workers[k].cpu.user + this.workers[k].cpu.system) / this.workers[k].cputm

        if (cpuratio > this.maxRate) {
          this.cpuHighRatio++
        } else {
          if (this.cpuHighRatio > 0) {
            this.cpuHighRatio--
          }

          break
        }
      }
    }

    if (this.cpuHighRatio >= this.workerCount.cur) {
      this.cpuHighRatio--

      if (this.workerCount.cur < this.workerCount.max) {
        if (this.workerCount.canAutoFork) {
          this.workerCount.canAutoFork = false

          cluster.fork()
          
          if (this.life < this.maxLife) {
            this.life += 5
          } else {
            this.life = 25
          }

          this.cooling += this.life
        }

      } else {
        //此时升温，表示负载高，不要kill多余的进程。
        if (this.cooling < this.maxCooling) {
          this.cooling += 20 + ((Math.random() * 60) | 0)
        }
      }

    } else {

      if (this.workerCount.cur > this.workerCount.total) {
        if (this.cooling > 0) {
          this.cooling--
        } else {
          for (let k in this.workers) {
            if (this.workers[k].conn === 0) {
              
              if (cluster.workers[k]) {
                cluster.workers[k].send({type: '_disconnect'})
                cluster.workers[k].disconnect()
              }

              break
            }
          }
        }
      }

    }

  }

  msgEvent() {
    if (this.config.loadInfoFile.length > 0 && this.config.loadInfoFile !== '--mem') {
      fs.open(this.config.loadInfoFile, 'w+', 0o644, (err, fd) => {
        if (!err) {
          this.loadfd = fd
        } else {
          this.config.debug && this.config.errorHandle(err, '--ERR-OPEN-FILE--')
        }
      })
    }

    let self = this
    
    return (w, msg, handle = undefined) => {
      if (self.checkMem(w, msg)) {
        if (self.workerCount.max > self.workerCount.total) {
          self.autoWorker();
        }

        self.showLoadInfo(msg, w.id);
      }
    }
  }

  workerSend() {
    if (this.sendInterval) return;

    let will_disconnect = false

    process.on('message', (msg) => {
      if (msg.type === '_disconnect') {
        will_disconnect = true
      }
    })

    let MAX_MEM_COUNT = 28

    let mem_count = MAX_MEM_COUNT

    this.sendInterval = setInterval(() => {
      if (will_disconnect) return;

      this.cpuLastTime = this.cpuNowTime
      this.cpuNowTime = hrtime.bigint()
      let diffNs = this.cpuNowTime - this.cpuLastTime
      let diffUs = (Number(diffNs) / 1000) + 0.01

      //此处是计算微秒的cpu变化，而计算负载正好按照微秒进行
      this.rundata.cpuTime = process.cpuUsage(this.rundata.cpuLast)

      if (mem_count < MAX_MEM_COUNT) {
        this.rundata.mem.rss = process.memoryUsage.rss()
        mem_count++
      } else {
        this.rundata.mem = process.memoryUsage()
        mem_count = 0
      }

      this.rundata.mem.total = this.rundata.mem.rss + this.rundata.mem.external

      const msg = this.ipcMsgCache
      msg.pid = process.pid
      msg.cpu = this.rundata.cpuTime
      msg.cputm = diffUs
      msg.mem = this.rundata.mem
      msg.conn = this.rundata.conn

      process.send(msg, err => {
        if (err) this.config.errorHandle(err, '--ERR-WORKER-SEND--')
        // 忽略管道关闭错误
        //if (err && err.code !== 'ERR_IPC_CHANNEL_CLOSED') {}
      })

      this.rundata.cpuLast = process.cpuUsage()

    }, this.timeSlice)

  }

  showLoadInfo(w, id) {
    if (!this.config.loadInfoType || this.config.loadInfoType === 'null') {
      return
    }
  
    let wk = this.workers[id]

    if (!wk) {
      return
    }

    wk.cpu.user = w.cpu.user;
    wk.cpu.system = w.cpu.system;
    wk.mem.rss = w.mem.rss;
    wk.mem.heapTotal = w.mem.heapTotal;
    wk.mem.heapUsed = w.mem.heapUsed;
    wk.mem.external = w.mem.external;
    wk.mem.total = w.mem.total;
    wk.mem.arrayBuffers = w.mem.arrayBuffers;
    
    wk.conn = w.conn;
    wk.cputm = w.cputm;
  
    this.loadCount += 1;
    if (this.loadCount < this.workerCount.cur) {
      return
    }
    
    let load_info = this.fmtLoadInfo(this.config.loadInfoType);

    if (this.config.loadInfoFile === '--mem') {
      this.loadCache = load_info;
    } else if (this.loadfd !== null) {
      fs.write(this.loadfd, this.isLoadObj ? JSON.stringify(load_info) : load_info, 0,
          (err, bytes, data) => {
              if (err && this.config.debug) this.config.errorHandle(err, '--ERR-WRITE-FILE--');
              
              if (!err) {
                fs.ftruncate(this.loadfd, bytes, e => {});
              }
          }
      );
    } else if (process.ppid > 1 && !this.config.daemon && !this.config.loadInfoFile) {
      console.clear();
      //只有没有开启守护进程才会输出到屏幕
      console.log(load_info);
    }
  
    this.loadCount = 0;
  }

  checkMem(w, msg) {
    if (this.secure.maxrss > 0 && this.secure.maxrss <= msg.mem.rss) {
      //process.kill(msg.pid, 'SIGTERM');
      w.send({type: '_disconnect'});
      w.disconnect();
      return false;
    }

    if (this.secure.diemem > 0 && this.secure.diemem <= msg.mem.total) {
      w.send({type: '_disconnect'});
      w.disconnect();
      return false;
    }

    if (this.secure.maxmem > 0 
      && this.secure.maxmem <= msg.mem.rss
      && msg.conn == 0)
    {
      w.send({type: '_disconnect'});
      w.disconnect();
      return false;
    }
    return true;
  }

  fmtLoadInfo(type = 'text') {
    let oavg = os.loadavg();
  
    let p = null;
  
    if (type === 'text') {
      let oscpu = `CPU Load avg  1m: ${oavg[0].toFixed(2)}  `
                  + `5m: ${oavg[1].toFixed(2)}  15m: ${oavg[2].toFixed(2)}\n`;
  
      let cols = ['PID      CPU     CONN    MEM     HEAP    USED    EXT      TOTAL·M'];
      let tmp = '';
      let t = '';
      let p = null;
  
      for (let id in this.workers) {
        p = this.workers[id];
        tmp = [(`${p.pid}`).padEnd(9, ' ')];
        t = p.cpu.user + p.cpu.system;
        tmp.push((( t * 100 / p.cputm ).toFixed(2) + '%').padEnd(8, ' '),
            (`${p.conn}`).padEnd(8, ' '),
            (p.mem.rss / 1048576).toFixed(1).padEnd(8, ' '),
            (p.mem.heapTotal / 1048576).toFixed(1).padEnd(8, ' '),
            (p.mem.heapUsed / 1048576).toFixed(1).padEnd(8, ' '),
            (p.mem.external / 1048576).toFixed(1).padEnd(9, ' '),
            (p.mem.total / 1048576).toFixed(1)
        );
  
        cols.push(tmp.join(''));
      }

      cols.push(`PID: ${process.pid} | Listen ${this.rundata.host}:${this.rundata.port}\n`);
  
      return `${oscpu}${cols.join('\n')}`
          +`HTTPS: ${this.config.https ? 'true' : 'false'}; HTTP/2: ${this.config.http2 ? 'true' : 'false'}\n`;
    }
  
    if (type === 'obj') {
      let lj = this.loadjson
      lj.CPULoadavg['1m'] = oavg[0].toFixed(2)
      lj.CPULoadavg['5m'] = oavg[1].toFixed(2)
      lj.CPULoadavg['15m'] = oavg[2].toFixed(2)
      lj.workers = []

      for (let id in this.workers) {
        p = this.workers[id];
  
        lj.workers.push({
          pid: p.pid,
          cpu: `${((p.cpu.user + p.cpu.system) * 100 / p.cputm).toFixed(2)}%`,
          cputm: p.cputm,
          mem: {
            rss : (p.mem.rss / 1048576).toFixed(1),
            heap : (p.mem.heapTotal / 1048576).toFixed(1),
            heapused : (p.mem.heapUsed / 1048576).toFixed(1),
            external :  (p.mem.external / 1048576).toFixed(1),
          },
          conn : p.conn
        })
      }

      return lj
    }
  
    if (type === 'orgobj') {
      let lj = this.loadjson
      lj.CPULoadavg['1m'] = oavg[0].toFixed(2)
      lj.CPULoadavg['5m'] = oavg[1].toFixed(2)
      lj.CPULoadavg['15m'] = oavg[2].toFixed(2)
      lj.workers = this.workers

      return lj
    }
    
    return null
  }

}

module.exports = Monitor
