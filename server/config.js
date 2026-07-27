const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

/** 启动时加载到内存 */
let config = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    console.warn('加载 config.json 失败:', e.message);
    return {};
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

/** 获取全量配置（用于 API 返回，敏感字段脱敏） */
function getAll() {
  const safe = JSON.parse(JSON.stringify(config));
  // 脱敏：Token/Key/Password 类替换为 ***
  if (safe.qbittorrent?.token && safe.qbittorrent.token.length > 0) {
    safe.qbittorrent.token = '***';
  }
  if (safe.nas?.apiKey && safe.nas.apiKey.length > 0) {
    safe.nas.apiKey = '***';
  }
  if (safe.bgm?.token && safe.bgm.token.length > 0) {
    safe.bgm.token = '***';
  }
  if (safe.deepseek?.apiKey && safe.deepseek.apiKey.length > 0) {
    safe.deepseek.apiKey = '***';
  }
  return safe;
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
    console.error('保存 config.json 失败:', e.message);
  }
}

module.exports = { get, set, getAll, update };