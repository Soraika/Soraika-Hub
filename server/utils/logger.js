/**
 * pino 日志封装（server 端统一出口）
 *
 * 特性：
 *  - 级别过滤：LOG_LEVEL（debug | info | warn | error，默认 info）
 *  - 输出：LOG_OUTPUT = both（默认，stdout+文件） | stdout | file
 *    · 文件写入 DATA_DIR/logs（可用 LOG_DIR 覆盖），pino-roll 按日轮转、保留 7 天
 *  - 内置脱敏：redact 路径 + 字符串内容正则兜底（sk-xxx / Bearer xxx / qbt_xxx / token=...）
 *  - 带模块标签：const log = require('../utils/logger').child('recommend')
 */
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_OUTPUT = process.env.LOG_OUTPUT || 'both'; // both | stdout | file

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LOG_DIR = process.env.LOG_DIR || path.join(DATA_DIR, 'logs');

/** 字符串内容兜底脱敏（redact 路径覆盖不了的场景） */
function redactString(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/qbt_[A-Za-z0-9:_-]+/g, 'qbt_***')
    .replace(/(token|api[_-]?key|password|secret|authorization)(["']?\s*[:=]\s*["'])[^"'\s]{4,}["']/gi, '$1$2***');
}

/** 组装输出 targets（stdout + 按日轮转文件） */
function buildTargets() {
  const targets = [];
  const wantStdout = LOG_OUTPUT === 'both' || LOG_OUTPUT === 'stdout';
  const wantFile = LOG_OUTPUT === 'both' || LOG_OUTPUT === 'file';

  if (wantStdout) {
    targets.push({ target: 'pino/file', options: { destination: 1 }, level: LOG_LEVEL });
  }
  if (wantFile) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      targets.push({
        target: 'pino-roll',
        options: {
          file: path.join(LOG_DIR, 'app.log'),
          frequency: 'daily',
          dateFormat: 'yyyy-MM-dd',
          limit: { count: 7, removeOtherLogFiles: true },
          mkdir: true,
        },
        level: LOG_LEVEL,
      });
    } catch (e) {
      // logger 本身初始化失败时的兜底（此时 pino 可能不可用，只能用原生 console）
      console.warn(`[logger] 日志目录不可用，已降级为仅控制台: ${e.message}`);
    }
  }
  if (targets.length === 0) {
    targets.push({ target: 'pino/file', options: { destination: 1 }, level: LOG_LEVEL });
  }
  return targets;
}

const logger = pino({
  level: LOG_LEVEL,
  base: { service: 'soraikas-hub' },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    // pino-http 记录请求时对 req/res 精简，避免把整个 Node 对象序列化
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  redact: {
    paths: [
      '*.apiKey', '*.token', '*.password', '*.secret', '*.authorization',
      '*.Authorization', '*.ApiKey', '*.Token', '*.cookie',
      'req.headers.authorization', 'req.headers.cookie',
    ],
    censor: '[REDACTED]',
  },
  hooks: {
    logMethod(inputArgs, method) {
      const args = inputArgs.map((a) => (typeof a === 'string' ? redactString(a) : a));
      method.apply(this, args);
    },
  },
  transport: { targets: buildTargets() },
});

/**
 * 子日志器：
 *  - child('recommend')：绑定模块标签（业务代码用法）
 *  - child(bindings, options)：透传给 pino 原生 child（pino-http 等第三方库会用），避免把 bindings 误当 tag
 */
const baseChild = logger.child.bind(logger);
function child(tagOrBindings, options) {
  if (typeof tagOrBindings === 'string') {
    return baseChild({ tag: tagOrBindings }, options);
  }
  return baseChild(tagOrBindings, options);
}

module.exports = logger;
module.exports.child = child;
