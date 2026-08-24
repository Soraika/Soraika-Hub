const fs = require('fs');
const path = require('path');
const log = require('./utils/logger').child('config');

// 配置目录：优先取环境变量 DATA_DIR（Docker 卷挂载点），默认回退到本目录
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

/** 启动时加载到内存 */
let config = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    // 首次启动/无配置：静默返回空对象并尝试写一个初始空配置文件，
    // 避免每次都打印 ENOENT 吓人，同时也提前占位方便后续保存
    if (e.code !== 'ENOENT') {
      log.warn('加载 config.json 失败:', e.message);
    }
    const empty = {};
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(empty, null, 2), 'utf-8');
    } catch (w) {
      // 写失败不致命（如容器卷只读），保持内存空配置，等设置页再写
      log.warn('初始化 config.json 失败:', w.message);
    }
    return empty;
  }
}

/** 深层读取，如 get('mikan.baseUrl') */
function get(keyPath) {
  const keys = keyPath.split('.');
  let val = config;
  for (const k of keys) {
    if (val == null) return undefined;
    val = val[k];
  }
  return val;
}

/** 深层设置 + 写盘 */
function set(keyPath, value) {
  const keys = keyPath.split('.');
  let obj = config;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') {
      obj[keys[i]] = {};
    }
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
  save();
}

/** 合并更新（前端 PUT 整个模块配置） */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      deepMerge(target[key], sv);
    } else {
      target[key] = sv;
    }
  }
}

/** 获取全量配置（直接返回，不脱敏 — 前端用 password 输入框保护） */
function getAll() {
  return JSON.parse(JSON.stringify(config));
}

/** 合并更新全量配置 */
function update(partial) {
  deepMerge(config, partial);
  save();
  return getAll();
}

function save() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    log.error('保存 config.json 失败:', e.message);
  }
}

module.exports = { get, set, getAll, update };