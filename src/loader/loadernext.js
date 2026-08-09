'use strict';

const fs = require('node:fs');
const process = require('node:process');

let outWarning = (text, errname = 'Warning', color = '\x1b[2;31;47m') => {
  setTimeout(() => {
    console.error(`${color} ${errname}: ${text} \x1b[0m\n`);
  }, 1280);
};

let nameErrorInfo = '名称不能有空格换行特殊字符等，仅支持 字母 数字 减号 下划线，字母开头。';

class TopbitLoader {

  constructor(options = {}) {
    let appDir = '.';
    
    this.globalMidTable = [];
    this.groupMidTable = Object.create(null);
    this.fileMidTable = Object.create(null);
    this.parentGroupMap = Object.create(null);

    if (typeof options !== 'object') {
      options = {};
    }
    
    if (options.appPath !== undefined && typeof options.appPath === 'string') {
      appDir = options.appPath;
    }

    if (appDir.length > 0 && appDir[0] !== '/') {
      appDir = fs.realpathSync(appDir);
    }

    this.optionsCacheLog = null;

    this.methodNumber = {
      get: 1, post: 2, put: 3, delete: 4, _delete: 4,
      options: 5, head: 6, trace: 7, patch: 8, list: 9
    }

    this.config = {
      name: 'loader',
      appPath     : appDir,
      controllerPath  : appDir + '/controller',
      midwarePath   : appDir + '/middleware',

      prePath: '',
      homeFile: '',
      
      // 控制器初始化参数，默认为 app.service
      initArgs: null,

      optionsRoute: true,

      beforeController: null,
      afterController: null,

      // 新的核心：模型加载钩子函数
      modelLoader: null
    };

    // 目录 OPTIONS 通配路由的分组前缀，避免与文件分组名冲突。
    this.groupTag = '@';

    // 组中间件的缓存
    this.groupCache = {};
    this.globalCache = [];

    this.routepreg = /^[a-z\d\-\_]+$/i;

    this.__loaded__ = false;

    for (let k in options) {
      if (k == 'appPath') continue;

      if ( (k === 'prePath' || k === 'prepath') && typeof options[k] === 'string') {
        this.config.prePath = options[k];
        this.fmtPrePath();
        continue;
      }

      switch (k) {
        case 'beforeController':
        case 'afterController':
        case 'modelLoader': // 仅保留这个与 Model 相关的配置
          if (typeof options[k] === 'function') this.config[k] = options[k];
          break;

        case 'initArgs':
          this.config.initArgs = options[k];
          break;

        case 'homeFile':
          ;(typeof options[k] === 'string') && (this.config[k] = options[k]);
          break;

        case 'optionsRoute':
          this.config[k] = !!options[k];
          break;

        case 'controllerPath':
        case 'midwarePath':
          if (options[k][0] !== '/') {
            this.config[k] = `${this.config.appPath}/${options[k]}`;
          }
          break;
        case 'name':
          if (typeof options[k] === 'string' && options[k].trim() !== '') {
            this.config[k] = options[k].trim();
          }
          break;

        default:;
      }
    }

    // 仅检查 controller 和 middleware 目录
    try {
      fs.accessSync(this.config.controllerPath, fs.constants.F_OK);
    } catch (err) {
      if (this.config.controllerPath.length > 0) {
        fs.mkdirSync(this.config.controllerPath);
      }
    }

    try {
      fs.accessSync(this.config.midwarePath, fs.constants.F_OK);
    } catch (err) {
      if (this.config.midwarePath.length > 0) {
        fs.mkdirSync(this.config.midwarePath);
      }
    }
  }

  fmtPrePath() {
    let prepath = this.config.prePath.trim().replace(/\/+/g, '/');
    if (prepath === '/') prepath = '';
    else if (prepath.length > 0) {
      if (prepath[0] !== '/') prepath = `/${prepath}`;
      if (prepath[ prepath.length - 1 ] === '/') prepath = prepath.substring(0, prepath.length - 1);
    }
    this.config.prePath = prepath;
  }

  async _coreinit(app) {
    if (this.__loaded__) return;
    // 注入应用基础信息到 service，供 Controller 或 Model 使用
    if (!app.service[this.config.name]) {
      app.service[this.config.name] = {
        name: this.config.name,
        prepath: this.config.prePath,
      };
    }

    if (Object.getOwnPropertyDescriptor(app.service, '__prepath__') === undefined) {
      Object.defineProperties(app.service, {
        __prepath__: {
          value: this.config.prePath,
          configurable: false, writable: false, enumerable: false
        },
        __appdir__: {
          value: this.config.appPath,
          configurable: false, writable: false, enumerable: false
        }
      });
    }

    // 1. 执行模型加载钩子 (如果存在)
    if (this.config.modelLoader) {
      await this.config.modelLoader(app.service);
    }

    // 2. 加载控制器 (路由)
    this.loadController(app);

    // 3. 加载中间件
    this.loadMidware(app);
    
    this.__loaded__ = true;
  }

  /**
   * 初始化入口 (Async)，提供回调函数在完成后执行
   */
  async init(app, cb) {
    await this._coreinit(app);
    if (cb && typeof cb === 'function') {
      cb(app);
    }
  }

  async daemonInit(app, cb) {
    if (app.isWorker) {
      await this._coreinit(app);
    }

    if (cb && typeof cb === 'function') {
      cb(app);
    }
  }

  loadController(app) {
    if (this.__loaded__) {
      outWarning('您已经使用topbit-loader加载过路由，多次加载容易导致路由冲突，重复操作将会被终止。');
      return false;
    }

    this.optionsCacheLog = {};

    let cfiles = {};
    this.readControllers(this.config.controllerPath, cfiles);
    let cob = null;
    let Ctlr;
    
    // 默认注入 app.service
    const initArg = this.config.initArgs || app.service;

    for (let k in cfiles) {
      try {
        Ctlr = require(k);
        //不是函数或箭头函数无法进行new操作。
        if (typeof Ctlr !== 'function' || !Ctlr.prototype) {
          continue;
        }

        cob = new Ctlr();

        if (cob.init && typeof cob.init === 'function') {
          cob.init(initArg);
        }
        
        if (this.config.beforeController) {
          try {
            this.config.beforeController(cob, cfiles[k], app);
          } catch (err) {
            outWarning(`beforeController: ${err.message}`);
          }
        }

        this.setRouter(app, cob, cfiles[k]);
        
        if (this.config.afterController) {
          try {
            this.config.afterController(cob, cfiles[k], app);
          } catch (err) {
            outWarning(`afterController: ${err.message}`);
          }
        }

        cob = null;
      } catch (err) {
        outWarning(`load router file : ${k}\x1b[0m\n  \x1b[1;33m${err.message}\n\x1b[1;36m${err.stack || ''}`, 
          'Error', '\x1b[1;35m');
      }
    }

    this.optionsCacheLog = null;

    return cfiles;
  }

  _autoAddOptions(app, options_path, group) {
    app.router.apiTable.OPTIONS[options_path] === undefined
      &&
    app.router.options(options_path, async c => {}, {group: group});
  }

  setRouter(app, cob, cf) {
    if (cob.mode === undefined) {
      cob.mode = 'restful';
    }

    let group = cf.filegroup;

    let npre = cf.filegroup;
    let prepath = this.config.prePath;

    let route_path = `${prepath}${cf.filegroup}`;

    npre = `${prepath}${npre}`;
    group = `${prepath}${group}`;
    // 目录级 dirgroup，用于 OPTIONS 通配路由。
    let dirgroup = `${prepath}${cf.dirgroup}`;

    let routeParam = '/:id';

    if (cob.param !== undefined && cob.param !== null && typeof cob.param === 'string') {
      routeParam = cob.param.trim().replace(/\s+/g, '').replace(/\/{2,}/g, '/');
      if (routeParam.length > 0 && routeParam[0] !== '/') {
        routeParam = `/${routeParam}`;
      }
    }

    Object.defineProperty(cob, '__route__', {
      configurable: false, writable: false, enumerable: false,
      value: route_path
    });

    // 辅助函数：简化路由注册
    const bindRoute = (method, suffix, fnName, typeName) => {
        app.router[method](`${route_path}${suffix}`, cob[fnName].bind(cob), {
            name: `${npre}/${typeName}`,
            group: group
        });
    };

    if (cob.post && typeof cob.post === 'function') {
      let postParam = (cob.postParam && typeof cob.postParam === 'string') ? cob.postParam : '';
      postParam = postParam.replace(/\/+/g, '/');
      if (postParam === '/') postParam = '';
      if (postParam.length > 0 && postParam[0] !== '/') postParam = `/${postParam}`;
      
      bindRoute('post', postParam, 'post', this.methodNumber.post);
    }

    let real_delete_method = '';
    if (cob.delete && typeof cob.delete === 'function') real_delete_method = 'delete';
    else if (cob._delete && typeof cob._delete === 'function') real_delete_method = '_delete';

    if (real_delete_method) {
        bindRoute('delete', routeParam, real_delete_method, this.methodNumber.delete);
    }

    if (cob.put && typeof cob.put === 'function') {
        bindRoute('put', routeParam, 'put', this.methodNumber.put);
    }

    if (cob.get && typeof cob.get === 'function') {
        bindRoute('get', routeParam, 'get', this.methodNumber.get);
        // 主页路由
        if (this.config.homeFile === cf.pathname) {
            app.router.get('/', cob.get.bind(cob), { name: 'home', group: group });
        }
    }

    if (cob.list && typeof cob.list === 'function') {
      let listParam = (cob.listParam && typeof cob.listParam === 'string') ? cob.listParam : '';
      listParam = listParam.replace(/\/+/g, '/');
      if (listParam === '/') listParam = '';
      if (listParam.length > 0 && listParam[0] !== '/') listParam = `/${listParam}`;
      
      bindRoute('get', listParam, 'list', this.methodNumber.list);
    }

    if (cob.patch && typeof cob.patch === 'function') {
        bindRoute('patch', routeParam, 'patch', this.methodNumber.patch);
    }

    if (cob.options && typeof cob.options === 'function') {
        bindRoute('options', routeParam, 'options', this.methodNumber.options);
    } else if (this.config.optionsRoute) {
      let real_group = dirgroup;
      let tag = this.groupTag;

      if (real_group === `${this.config.prePath}/`) {
        this._autoAddOptions(app, `${route_path}/*`, tag + real_group);
      } else if (this.optionsCacheLog[real_group] === undefined) {
        this._autoAddOptions(app, `${real_group}/*`, tag + real_group);
        this.optionsCacheLog[real_group] = true;
      }
    }

    if (cob.head && typeof cob.head === 'function') {
        bindRoute('head', routeParam, 'head', this.methodNumber.head);
    }

    this.fileMidTable[cf.filegroup] = {
      //group已经是带有前缀的。
      group : group,
      dirgroup: cf.dirgroup,
      mid   : []
    };

    if (cob.__mid && typeof cob.__mid === 'function') {
      let mid = cob.__mid();
      if (mid && Array.isArray(mid) ) {
        this.fileMidTable[cf.filegroup].mid = mid;
      }
    }
  }

  _getGroupList() {
    this.orgGroupList = ['/'];

    try {
      let flist = fs.readdirSync(this.config.controllerPath, {withFileTypes: true});
      for (let f of flist) {
        if (!f.isDirectory()) continue;
        if (f.name[0] === '!' || f.name[0] === '.') continue;

        this.orgGroupList.push(`/${f.name}`);
        let subdir = `${this.config.controllerPath}/${f.name}`;
        let sublist = fs.readdirSync(subdir, {withFileTypes: true});
        for (let sf of sublist) {
          if (!sf.isDirectory()) continue;
          if (sf.name[0] === '!' || sf.name[0] === '.') continue;

          this.orgGroupList.push(`/${f.name}/${sf.name}`);
        }
      }
    } catch (err) {
      console.error('获取全局所有分组失败，若获取失败会导致程序运行错误，故进程退出，请检查错误。');
      console.error(err);
      process.exit(1);
    }

    return this.orgGroupList;
  }

  /**
   * 加载中间件
   */
  loadMidware(app) {
    if (this.__loaded__) return;

    this._getGroupList();

    for (let i = 0; i < this.globalMidTable.length; i++) {
      this.loadGlobalMidware(app, this.globalMidTable[i]);
    }

    //加载组，此时组已经确定

    for (let k in this.parentGroupMap) {
      let parent_group = this.parentGroupMap[k];
      if (parent_group && this.groupMidTable[parent_group] ) {
        let parent_mids = this.groupMidTable[parent_group];
        this.groupMidTable[k] = [...parent_mids, ...(this.groupMidTable[k]||[])];
      }
    }

    for (let k in this.groupMidTable) {
      for (let i=0; i < this.groupMidTable[k].length; i++) {
        this.loadGroupMidware(app, this.groupMidTable[k][i], k);
      }
    }
    
    if (this.config.optionsRoute) {
      for (let g of this.orgGroupList) {
        this._loadMidForFileAsGroup(app, `${this.groupTag}${this.config.prePath}${g}`, g);
      }
    }

    for (let k in this.fileMidTable) {
      this._loadMidForFileAsGroup(app,
                this.fileMidTable[k].group,
                this.fileMidTable[k].dirgroup);

      for (let i = 0; i < this.fileMidTable[k].mid.length; i++) {
        this.loadFileMidware(app, 
          this.fileMidTable[k].mid[i],
          k,
          this.fileMidTable[k].group,
          this.fileMidTable[k].dirgroup
        );
      }
    }

  }

  _loadMidForFileAsGroup(app, group, dirgroup) {
    //此时文件作为分组，从groupCache中取出中间件，并添加到分组。
    let tmp_opts;
    for (let g of this.globalCache) {
      tmp_opts = {...g[1]};
      tmp_opts.group = group;
      app.use(g[0], tmp_opts);
    }

    let ggp = this.groupCache[dirgroup];
    if (ggp && Array.isArray(ggp)) {
      for (let g of ggp) {
        tmp_opts = {...g[1]};
        tmp_opts.group = group;
        app.use(g[0], tmp_opts);
      }
    }
  }

  checkMiddleware(m) {
    if (m.middleware === undefined) return false;
    if (typeof m.middleware === 'function' && m.middleware.constructor.name === 'AsyncFunction') return true;
    if (m.middleware.mid && typeof m.middleware.mid === 'function') return true;
    if (m.middleware.middleware && typeof m.middleware.middleware === 'function') return true;
    return false;
  }

  getMidwareInstance(m) {
    if ( this.checkMiddleware(m) ) {
      return m.middleware;
    }

    if (typeof m.name !== 'string' || m.name.trim() === '') {
      console.error(`--Middleware Error--: less name.`, m);
      return null;
    }

    let mt = null;
    let tmp = null;
    if (m.name[0] == '@') {
      tmp = require(this.config.midwarePath+'/'+m.name.substring(1));
      if (m.args === undefined) {
        mt = new tmp();
      } else {
        mt = new tmp(m.args);
      }

      if (mt.middleware && typeof mt.middleware === 'function') {
        return mt.middleware.bind(mt);
      } else if (mt.mid && typeof mt.mid === 'function') {
        return mt.mid()
      }
    } else {
      mt = require(this.config.midwarePath+'/'+m.name);
    }
    return mt;
  }

  _checkMidwareMode(app, m) {
    if (m.mode !== undefined) {
      if (m.mode === 'test' || m.mode === 'dev') {
        if (app.service.TEST || app.service.DEV) {
          return true;
        }
        return false;
      } else if (m.mode === 'online' || m.mode === 'product') {
        if (app.service.TEST || app.service.DEV) {
          return false;
        }
        return true;
      }
    }
    return true;
  }

  loadGlobalMidware(app, m) {
    if (this._checkMidwareMode(app, m) === false) return;

    let makeOpts = () => {
      let op = {};
      if (m.method !== undefined) op.method = m.method;
      if (m.pre) op.pre = true;
      return op;
    };

    let mobj = this.getMidwareInstance(m);
    if (mobj) {
      this.globalCache.push([mobj, makeOpts()]);
    }
  }

  loadGroupMidware(app, m, group) {
    if (this._checkMidwareMode(app, m) === false) return;
    if ((!m.name || m.name === '') && !m.middleware) return;
    let opts = {
      group: `${this.config.prePath}${group}`,
    };
    if (m.method !== undefined) opts.method = m.method;
    if (m.pre) opts.pre = true;

    let mobj = this.getMidwareInstance(m);
    if (mobj) {
      if (!this.groupCache[group]) { this.groupCache[group] = [[mobj, opts]]; }
      else { this.groupCache[group].push([mobj, opts]); }
    }
  }

  loadFileMidware(app, m, f, group, dirgroup) {
    if (this._checkMidwareMode(app, m) === false) return;

    let opts = { group };
    f = `${this.config.prePath}${f}`;

    if (m.handler && typeof m.handler === 'string') m.handler = [ m.handler ];

    if (m.handler && Array.isArray(m.handler)) {
      opts.name = [];
      let handler_num;
      for (let p of m.handler) {
        handler_num = this.methodNumber[p.toLowerCase()];
        if (handler_num === undefined) continue;
        opts.name.push(`${f}/${handler_num}`);
      }
    }

    if (m.pre) opts.pre = true;
    let mobj = this.getMidwareInstance(m);
    if (mobj) app.use(mobj, opts);
  }

  stripExtName(filename) {
    let sf = filename.split('.js');
    return `${sf[0]}`;
  }

  /**
   * 读取控制器目录中的文件
   */
  readControllers(cdir, cfiles, deep=0, dirgroup='', parent_group='') {
    let files = fs.readdirSync(cdir, {withFileTypes:true});

    let tmp = '';
    for (let i = 0; i < files.length; i++) {

      if (files[i].isDirectory() && deep < 2) {

        if (files[i].name[0] == '!') continue;

        if (this.routepreg.test(files[i].name) === false) {
          outWarning(`${files[i].name}/ ${nameErrorInfo}`, 'Error');
          continue;
        }

        this.readControllers(cdir+'/'+files[i].name, 
          cfiles, deep+1,
          `${dirgroup}/${files[i].name}`,
          dirgroup
        );

      } else if (files[i].isFile()) {
        if (files[i].name[0] === '!') continue;
        if (files[i].name.length < 4) continue;
        if (files[i].name.substring(files[i].name.length-3) !== '.js') continue;

        if (files[i].name == '__mid.js') {
          if (deep == 0) {
            this.globalMidTable = require(cdir+'/'+files[i].name);
          } else {
            this.groupMidTable[dirgroup] = require(cdir+'/'+files[i].name);
          }
          continue;
        }

        tmp = this.stripExtName(files[i].name);

        if (this.routepreg.test(tmp) === false) {
          outWarning(`${files[i].name} ${nameErrorInfo}`, 'Error');
          continue;
        }

        cfiles[cdir+'/'+files[i].name] = {
          filegroup: dirgroup + '/' + tmp,
          dirgroup: dirgroup || '/',
          name: files[i].name,
          modname: tmp,
          pathname : `${dirgroup}${dirgroup ? '/' : ''}${files[i].name}`
        };

        deep > 0 && (this.parentGroupMap[dirgroup] = parent_group);
      }
    }
  }

}

module.exports = TopbitLoader;
