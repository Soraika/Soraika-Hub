const express = require('express');
const router = express.Router();
const { fetchSubjectDetail, searchSubjects } = require('../services/bgm');
const log = require('../utils/logger').child('bgm');

// 条目详情（评分、简介、标签、收藏数等）
router.get('/subject/:id', async (req, res) => {
  try {
    const detail = await fetchSubjectDetail(req.params.id);
    res.json({ ok: true, detail });
  } catch (e) {
    log.error({ err: e, id: req.params.id }, 'GET /bgm/subject/:id 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 搜索
router.get('/search', async (req, res) => {
  try {
    const { q, type, limit } = req.query;
    if (!q) return res.status(400).json({ ok: false, error: '缺少搜索关键词 q' });
    const items = await searchSubjects(q, { type, limit: parseInt(limit) || 10 });
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    log.error({ err: e, q: req.query.q }, 'GET /bgm/search 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;