const { fetchSubjectList, fetchCalendar } = require('./bgm');
const log = require('../utils/logger').child('recommend');
const fs = require('fs');
const path = require('path');

// 候选池持久化缓存（与 db/日志同目录，server/data 已被 gitignore）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_PATH = path.join(DATA_DIR, 'candidates.json');

// ── 常量 ──

const GLOBAL_AVG = 6.5;          // Bangumi 全站动画平均分
const SMOOTHING = 500;           // 贝叶斯平滑系数
const PAGE_SIZE = 50;            // 每页条数（镜像上限 50）
const MODULE_SIZE = 20;          // 每模块展示 20 张

// 年代分段（用于候选池分段拉取，保证覆盖不同年代）
const YEAR_SEGMENTS = [
  { label: 'retro', from: '2000-01-01', to: '2005-12-31' },
  { label: 'retro2', from: '2006-01-01', to: '2010-12-31' },
  { label: 'classic', from: '2011-01-01', to: '2015-12-31' },
  { label: 'recent', from: '2016-01-01', to: '2018-12-31' },
  { label: 'new2019', from: '2019-01-01', to: '2019-12-31' },
  { label: 'new2020', from: '2020-01-01', to: '2020-12-31' },
  { label: 'new2021', from: '2021-01-01', to: '2021-12-31' },
  { label: 'new2022', from: '2022-01-01', to: '2022-12-31' },
  { label: 'new2023', from: '2023-01-01', to: '2023-12-31' },
  { label: 'new2024', from: '2024-01-01', to: '2024-12-31' },
  { label: 'new2025', from: '2025-01-01', to: '2025-12-31' },
];

// 模块定义
const MODULES = {
  praise: { id: 'praise', label: '口碑神作榜', minScore: 8.0, minTotal: 1000, yearRatio: [30, 30, 25, 15], sort: 'bayesian' },
  hot:    { id: 'hot',    label: '热门佳作榜', minScore: 7.0, maxScore: 8.0, minTotal: 500,  yearRatio: [50, 30, 15, 5],  sort: 'mix' },
  try:    { id: 'try',    label: '值得一试榜', minScore: 6.0, maxScore: 7.0, minTotal: 200,  yearRatio: [35, 35, 20, 10], sort: 'bayesian' },
  popular: { id: 'popular', label: '人气之作', minTotal: 1500, maxScore: 6.5, maxScoreInclusive: true, yearRatio: [45, 35, 15, 5], sort: 'popularity' },
};

// 年代层判断（按播出年份）
const YEARS_BY_BUCKET = [
  { bucket: 'new', min: 2020 },
  { bucket: 'recent', min: 2015 },
  { bucket: 'classic', min: 2010 },
  { bucket: 'retro', min: 2000 },
];

// ── 内存状态 ──

let candidateMap = new Map();   // id -> 精简条目（候选池）
let calendarCache = [];         // 今日更新（周放送缓存）
let refreshCounts = {};         // module -> 刷新次数（时间权偏移）
let lastSyncAt = null;
let syncing = false;
let syncError = null;
let ready = false;

// ── 工具函数 ──

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 贝叶斯加权分 */
function bayesian(score, total) {
  if (!score || !total) return 0;
  return (score * total + GLOBAL_AVG * SMOOTHING) / (total + SMOOTHING);
}

/** 热度分 */
function heatOf(item) {
  const c = item.collection || {};
  return (c.wish || 0) + (c.collect || 0) + (c.doing || 0) + (c.onHold || 0);
}

/** 探索因子：评分人数越少提升越大 */
function exploreFactor(total) {
  return 1 + 0.2 * SMOOTHING / (total + SMOOTHING);
}

/** 取年份 */
function yearOf(item) {
  return item.date ? parseInt(item.date.slice(0, 4)) : null;
}

/** 年代层 bucket */
function bucketOf(item) {
  const y = yearOf(item);
  for (const b of YEARS_BY_BUCKET) if (y >= b.min) return b.bucket;
  return 'retro';
}

/** 排序分 */
function sortScore(item, module) {
  const score = item.rating?.score || 0;
  const total = item.rating?.total || 0;
  const b = bayesian(score, total);
  switch (module.sort) {
    case 'mix':
      return b * 0.6 + Math.min(heatOf(item) / 5000, 10) * 0.4;
    case 'explore':
      return b * exploreFactor(total);
    case 'popularity':
      return total;
    default:
      return b;
  }
}

// ── 候选池采集 ──

/**
 * 按年份分段拉取 sort=heat 动画，合并去重为候选池。
 * 每段按 offset 翻页拉取。
 */
async function collectCandidates() {
  const pool = new Map();
  const concurrency = 4;
  const delayMs = 250;

  const tasks = [];
  for (const seg of YEAR_SEGMENTS) {
    for (const offset of [0, 50, 100, 150, 200]) {
      tasks.push(async () => {
        try {
          await sleep(delayMs);
          const items = await fetchSubjectList({
            offset,
            limit: PAGE_SIZE,
            sort: 'heat',
            filter: { type: [2], air_date: ['>=' + seg.from, '<=' + seg.to] },
          });
          for (const it of items) {
            if (it.nsfw || !it.id) continue;
            if (!pool.has(it.id)) pool.set(it.id, it);
          }
        } catch (e) {
          log.warn({ seg: seg.label, offset }, '采集失败: %s', e.message);
        }
      });
    }
  }

  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < tasks.length) {
      const task = tasks[idx++];
      await task();
    }
  });
  await Promise.all(workers);
  return pool;
}

// ── 今日更新（calendar） ──

async function refreshCalendar() {
  try {
    const days = await fetchCalendar();
    calendarCache = days;
  } catch (e) {
    log.warn('calendar 刷新失败: %s', e.message);
  }
}

/** 取本周放送条目（含星期标记） */
function getWeeklyItems() {
  const items = [];
  for (const day of calendarCache) {
    for (const it of (day.items || [])) {
      items.push({ ...it, weekday: day.weekdayCn, weekdayId: day.weekdayId });
    }
  }
  return items;
}

// ── 候选池持久化（json 缓存：启动秒恢复，避免每次全量采集） ──

/** 写盘候选池 */
function saveLocalCandidates() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(Array.from(candidateMap.values())), 'utf-8');
  } catch (e) {
    log.warn({ err: e }, '候选池缓存写盘失败');
  }
}

/** 启动时读取本地候选池缓存；返回是否命中 */
function loadLocalCandidates() {
  try {
    const arr = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    if (Array.isArray(arr)) {
      candidateMap = new Map(arr.filter(it => it && it.id).map(it => [it.id, it]));
      log.info('已从本地缓存恢复候选池：%d 部', candidateMap.size);
      return candidateMap.size > 0;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log.warn({ err: e }, '候选池缓存读取失败');
    }
  }
  return false;
}

// ── 主刷新流程 ──

async function syncAll(force = false) {
  if (syncing && !force) return false;
  syncing = true;
  try {
    try {
      const pool = await collectCandidates();
      candidateMap = pool;
      saveLocalCandidates();
      log.info('候选池刷新完成：%d 部动画', candidateMap.size);
    } catch (e) {
      syncError = '候选池采集失败: ' + e.message;
      log.error({ err: e }, '候选池采集失败');
    }

    await refreshCalendar();

    lastSyncAt = Date.now();
    syncError = null;
    if (candidateMap.size > 0) ready = true;
    return true;
  } catch (e) {
    syncError = e.message;
    return false;
  } finally {
    syncing = false;
  }
}

// ── 定时刷新（每日 03:00） ──

function scheduleNext() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(() => {
    syncAll(true).then(() => scheduleNext());
  }, delay);
}

// ── 模块采样（时间权分层 + 换一批） ──

function sampleByYear(items, ratio, count, excludeIds) {
  const buckets = { new: [], recent: [], classic: [], retro: [] };
  for (const it of items) {
    const b = bucketOf(it);
    if (buckets[b]) buckets[b].push(it);
  }

  const picked = [];
  const bucketNames = ['new', 'recent', 'classic', 'retro'];
  for (let i = 0; i < bucketNames.length; i++) {
    const name = bucketNames[i];
    const need = Math.round(count * (ratio[i] || 0) / 100);
    const candidates = buckets[name] || [];
    const available = candidates.filter(it => !excludeIds.has(it.id));
    const source = available.length >= need ? available : (available.length > 0 ? available : candidates);
    const shuffled = [...source].sort(() => Math.random() - 0.5);
    picked.push(...shuffled.slice(0, need));
  }
  return picked;
}

function getRefreshCount(moduleId) {
  return refreshCounts[moduleId] || 0;
}

function currentRatio(moduleId, baseRatio) {
  const rc = getRefreshCount(moduleId);
  const steps = Math.floor(rc / 3);
  const newPct = Math.min(60, baseRatio[0] + steps * 2);
  const retroPct = Math.max(5, baseRatio[3] - steps * 2);
  const midScale = (100 - newPct - retroPct) / Math.max(1, 100 - baseRatio[0] - baseRatio[3]);
  const recentPct = Math.round(baseRatio[1] * midScale);
  const classicPct = Math.round(baseRatio[2] * midScale);
  const total = newPct + recentPct + classicPct + retroPct;
  return [
    Math.round(newPct * 100 / total),
    Math.round(recentPct * 100 / total),
    Math.round(classicPct * 100 / total),
    Math.round(retroPct * 100 / total),
  ];
}

function moduleCandidates(moduleId) {
  const mod = MODULES[moduleId];
  let list = Array.from(candidateMap.values());
  if (mod) {
    list = list.filter(it => {
      const score = it.rating?.score || 0;
      const total = it.rating?.total || 0;
      if (total < mod.minTotal) return false;
      if (mod.minScore != null && score < mod.minScore) return false;
      if (mod.maxScore != null) {
        if (mod.maxScoreInclusive ? score > mod.maxScore : score >= mod.maxScore) return false;
      }
      if (mod.maxTotal != null && total >= mod.maxTotal) return false;
      return true;
    });
  }
  return list;
}

/** 按 bgmid（即 BGM 条目 id）从候选池取元信息，供首页排期卡片补评分/题材 */
function getSubjectMeta(bgmid) {
  const item = candidateMap.get(bgmid) || candidateMap.get(Number(bgmid)) || candidateMap.get(String(bgmid));
  if (!item) return null;
  return {
    score: item.rating?.score || null,
    ratingTotal: item.rating?.total || 0,
    tags: item.tags || [],
    year: item.date ? item.date.slice(0, 4) : null,
    eps: item.eps ?? item.totalEpisodes ?? null,
    totalEpisodes: item.totalEpisodes ?? null,
  };
}

function fmtCard(item, moduleId, mod) {
  return {
    id: item.id,
    bgmId: item.id,
    name: item.name,
    nameCn: item.nameCn || null,
    title: item.nameCn || item.name,
    poster: item.image || null,
    date: item.date || null,
    year: item.date ? item.date.slice(0, 4) : null,
    score: item.rating?.score || null,
    ratingTotal: item.rating?.total || 0,
    rank: item.rating?.rank || null,
    heat: heatOf(item),
    tags: item.tags || [],
    eps: item.eps ?? item.totalEpisodes ?? null,
    totalEpisodes: item.totalEpisodes ?? null,
    weekday: item.weekday || null,
    weekdayId: item.weekdayId || null,
    module: moduleId,
    moduleLabel: mod?.label || (moduleId === 'today' ? '今日更新' : moduleId),
  };
}

function getModuleBatch(moduleId, opts = {}) {
  const mod = MODULES[moduleId];
  const count = opts.count || MODULE_SIZE;
  const excludeIds = new Set(opts.excludeIds || []);

  if (!mod) return [];

  const candidates = moduleCandidates(moduleId);
  const ratio = currentRatio(moduleId, mod.yearRatio);
  const sampled = sampleByYear(candidates, ratio, count * 2, new Set());
  const dedup = sampled.filter(it => !excludeIds.has(it.id));
  const finalPool = dedup.length >= count ? dedup : sampled;

  const sorted = [...finalPool].sort((a, b) => sortScore(b, mod) - sortScore(a, mod));
  return sorted.slice(0, count).map(it => fmtCard(it, moduleId, mod));
}

// ── 对外 API ──

function getAllModules() {
  const result = {};
  for (const modId of Object.keys(MODULES)) result[modId] = getModuleBatch(modId);
  return result;
}

function nextBatch(moduleId) {
  refreshCounts[moduleId] = (refreshCounts[moduleId] || 0) + 1;
  return getModuleBatch(moduleId);
}

function status() {
  return {
    ready,
    syncing,
    error: syncError,
    candidateCount: candidateMap.size,
    calendarCount: getWeeklyItems().length,
    lastSyncAt,
    updatedAt: lastSyncAt,
    refreshCounts,
  };
}

/** 初始化：先读本地缓存秒级就绪，再后台采集刷新 + 每日定时 */
function init() {
  // 命中本地候选池缓存 → 推荐引擎立即可用（发现页秒出；BGM API 不可用时也有兜底）
  loadLocalCandidates();
  if (candidateMap.size > 0) {
    ready = true;
    lastSyncAt = Date.now();
  }
  syncAll().then(() => {
    scheduleNext();
  });
}

module.exports = { init, syncAll, getAllModules, nextBatch, getModuleBatch, getSubjectMeta, status, MODULES };
