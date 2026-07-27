const express = require('express');
const router = express.Router();
const {
  fetchRSS,
  searchRSS,
  fetchSchedule,
  fetchBangumiDetail,
  fetchBangumiRSS,
} = require('../services/parser');

// 最新资源列表（RSS）
router.get('/list', async (req, res) => {
  try {
    const items = await fetchRSS();
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
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
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 番剧字幕组列表（海报 + 字幕组）
router.get('/subdetail/:bgmid', async (req, res) => {
  try {
    const detail = await fetchBangumiDetail(req.params.bgmid);
    res.json({ ok: true, detail });
  } catch (e) {
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 搜索番剧（RSS 搜索，返回磁链+种子列表）
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ ok: false, error: '缺少搜索关键词 q' });
    const items = await searchRSS(q);
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;