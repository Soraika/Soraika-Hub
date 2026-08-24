const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const config = require('../config');
const log = require('../utils/logger').child('mikanMapping');

// 数据目录：与 db.js 一致（优先 DATA_DIR 环境变量，Docker 卷挂载；本地回退 server/data）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const MAPPING_PATH = path.join(DATA_DIR, 'bangumi-mikan.json');

// 默认源：bangumi-data 仓库的 Mikan → Bangumi ID 转换表
const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/xiaoyvyv/bangumi-data/main/data/mikan/bangumi-mikan.json';

// ── 内存状态 ──
let mapping = {};            // mikanId -> bgmId
let reverseMap = new Map();  // bgmId -> mikanId（反查）
let lastSyncAt = null;       // 最近一次成功同步时间戳
let syncing = false;
let syncError = null;

function source() {
  return config.get('mikan.mappingUrl') || DEFAULT_SOURCE;
}

/** 校验并写入内存 + 反查表 */
function applyData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('转换表格式不正确：应为 { mikanId: bgmId } 对象');
  }
  const cleaned = {};
  const reverse = new Map();
  for (const [k, v] of Object.entries(data)) {
    const mikanId = String(k).trim();
    const bgmId = String(v).trim();
    if (!mikanId || !bgmId) continue;
    cleaned[mikanId] = bgmId;
    // 同一 bgmId 对应多个 mikanId 时，后写覆盖（保留最新）
    reverse.set(bgmId, mikanId);
  }
  mapping = cleaned;
  reverseMap = reverse;
}

/** 读取本地 json 文件到内存（启动时保证立即可查） */
function loadLocal() {
  try {
    const raw = fs.readFileSync(MAPPING_PATH, 'utf-8');
    applyData(JSON.parse(raw));
    return true;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log.warn({ err: e }, '加载本地转换表失败');
    }
    return false;
  }
}

/** 保存到本地 json 文件 */
function saveLocal() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MAPPING_PATH, JSON.stringify(mapping, null, 2), 'utf-8');
  } catch (e) {
    log.error({ err: e }, '写入本地转换表失败');
  }
}

/**
 * 拉取远程 json。自托管/国内网络常有本地代理拦截 HTTPS（自签证书），
 * 首次证书校验失败时自动降级为“跳过证书校验”重试一次，并打警告日志。
 * 仅用于转换表数据源，不影响其他请求的 TLS 安全性。
 */
function fetchWithFallback(url, { headers, signal } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;

    function doRequest(rejectUnauthorized) {
      const req = mod.get(url, { headers, rejectUnauthorized }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            json: () => Promise.resolve(JSON.parse(text)),
          });
        });
      });
      req.on('error', (err) => {
        if (rejectUnauthorized !== false && /certificate|TLS|SSL|CERT|ERR_TLS/i.test(err.message)) {
          log.warn('TLS 证书校验失败，已降级为跳过校验重试（仅转换表数据源）: %s', err.message);
          return doRequest(false);
        }
        reject(err);
      });
      if (signal) {
        signal.addEventListener('abort', () => req.destroy(new Error('Aborted')));
      }
    }

    doRequest(true);
  });
}

/** 从远程源拉取并更新（含写盘）。返回 true 表示本次成功。 */
async function sync() {
  if (syncing) return false;
  syncing = true;
  try {
    const url = source();
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 30000);
    let res;
    try {
      res = await fetchWithFallback(url, {
        headers: { 'User-Agent': 'MikanAPI/1.0 (NAS bot)', 'Accept': 'application/json' },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(to);
    }
    if (!res.ok) throw new Error(`拉取转换表失败: ${res.status}`);
    applyData(await res.json());
    saveLocal();
    lastSyncAt = Date.now();
    syncError = null;
    log.info('转换表已更新：%d 条（%s）', Object.keys(mapping).length, url);
    return true;
  } catch (e) {
    syncError = e.message;
    log.error({ err: e }, '同步转换表失败');
    return false;
  } finally {
    syncing = false;
  }
}

/** 定时刷新：每日 03:00（与 recommend.js 对齐） */
function scheduleNext() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(() => {
    sync().then(() => scheduleNext());
  }, delay);
}

/**
 * 把任意入参解析为 Mikan 番剧 ID：
 *  - 命中 key：本身就是 Mikan ID，直接返回
 *  - 命中 value（BGM 条目 ID）：反查返回 Mikan ID
 *  - 都没命中：返回 null（调用方按原值兜底）
 */
function lookupMikanId(input) {
  if (input == null) return null;
  const id = String(input).trim();
  if (!id) return null;
  if (mapping[id]) return parseInt(id) || id;
  const mikanId = reverseMap.get(id);
  return mikanId != null ? parseInt(mikanId) || mikanId : null;
}

/** Mikan ID → BGM 条目 ID */
function lookupBgmId(mikanId) {
  if (mikanId == null) return null;
  return mapping[String(mikanId)] || null;
}

function status() {
  return {
    count: Object.keys(mapping).length,
    syncing,
    lastSyncAt,
    error: syncError,
    source: source(),
    file: MAPPING_PATH,
  };
}

/** 初始化：加载本地 → 后台拉取 → 每日定时刷新 */
function init() {
  loadLocal();
  sync().then(() => { scheduleNext(); });
}

module.exports = { init, sync, lookupMikanId, lookupBgmId, status, DEFAULT_SOURCE };
