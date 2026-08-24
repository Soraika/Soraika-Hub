const express = require('express');
const router = express.Router();
const {
  fetchRSS,
  searchRSS,
  searchBangumi,
  fetchSchedule,
  fetchBangumiDetail,
  fetchBangumiRSS,
} = require('../services/parser');
const recommend = require('../services/recommend');
const mikanMapping = require('../services/mikanMapping');
const log = require('../utils/logger').child('mikan');

// 最新资源列表（RSS）
router.get('/list', async (req, res) => {
  try {
    const items = await fetchRSS();
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    log.error({ err: e }, 'GET /mikan/list 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 排期列表（本周 / 历史季度）
router.get('/schedule', async (req, res) => {
  try {
    const { year, season, concurrency } = req.query;
    const opts = {};
    if (year) opts.year = parseInt(year);
    if (season) opts.season = season;
    if (concurrency) opts.concurrency = parseInt(concurrency);
    const items = await fetchSchedule(opts);
    // 首页排期默认只有 bgmid/name/poster，这里补评分/人数/题材/年份，供卡片展示
    const enriched = items.map(group => ({
      ...group,
      animes: (group.animes || []).map(a => {
        const meta = recommend.getSubjectMeta(a.bgmid);
        return meta ? { ...a, ...meta } : a;
      }),
    }));
    res.json({ ok: true, items: enriched });
  } catch (e) {
    log.error({ err: e }, 'GET /mikan/schedule 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 番剧字幕组列表（海报 + 字幕组）
// 入参兼容两种 ID：Mikan 番剧 ID（首页排期）或 BGM 条目 ID（发现页卡片，经转换表反查）
router.get('/subdetail/:bgmid', async (req, res) => {
  try {
    const input = req.params.bgmid;
    const mikanId = mikanMapping.lookupMikanId(input) || input;
    const detail = await fetchBangumiDetail(mikanId);
    // detail.bgmid 固定为 Mikan 番剧 ID，供前端后续字幕组 RSS 调用
    detail.bgmid = parseInt(mikanId) || mikanId;
    res.json({ ok: true, resolvedBgmid: detail.bgmid, detail });
  } catch (e) {
    log.error({ err: e, bgmid: req.params.bgmid }, 'GET /mikan/subdetail/:bgmid 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 转换表状态（Mikan → Bangumi ID）
router.get('/mapping', (req, res) => {
  res.json({ ok: true, ...mikanMapping.status() });
});

// 立即更新转换表
router.post('/mapping/sync', async (req, res) => {
  try {
    const ok = await mikanMapping.sync();
    res.json({ ok, ...mikanMapping.status() });
  } catch (e) {
    log.error({ err: e }, 'POST /mikan/mapping/sync 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 字幕组种子列表
router.get('/rss/:bangumiId/:subgroupId', async (req, res) => {
  try {
    const { bangumiId, subgroupId } = req.params;
    const items = await fetchBangumiRSS(bangumiId, subgroupId);
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    log.error({ err: e, bangumiId: req.params.bangumiId }, 'GET /mikan/rss/:id/:sub 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 搜索：默认番剧搜索（type=bangumi），type=rss 走种子搜索
router.get('/search', async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q) return res.status(400).json({ ok: false, error: '缺少搜索关键词 q' });
    if (type === 'rss') {
      const items = await searchRSS(q);
      res.json({ ok: true, count: items.length, items });
    } else {
      const items = await searchBangumi(q);
      res.json({ ok: true, count: items.length, items });
    }
  } catch (e) {
    log.error({ err: e, q: req.query.q }, 'GET /mikan/search 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
