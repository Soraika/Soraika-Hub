const express = require('express');
const router = express.Router();
const { classifyBatch } = require('../services/ai-classifier');

/**
 * 批量 AI 分类标题
 * Body: { titles: string[], apiKey?: string, model?, baseUrl? }
 * apiKey 可选，不传则从 config 读取 deepseek.apiKey
 */
router.post('/', async (req, res) => {
  try {
    const { titles, apiKey, model, baseUrl } = req.body;

    if (!titles || !Array.isArray(titles) || titles.length === 0) {
      return res.status(400).json({ ok: false, error: '请提供待分类的标题数组' });
    }

    const results = await classifyBatch(titles, apiKey, { model, baseUrl });
    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;