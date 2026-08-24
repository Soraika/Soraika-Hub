const express = require('express');
const router = express.Router();
const { classifyTags, classifyDownload } = require('../services/classifier');
const log = require('../utils/logger').child('classify');

/**
 * POST /api/classify/tags
 * Body: { tags: string[], fileNames: string[], apiKey?, model?, baseUrl? }
 */
router.post('/tags', async (req, res) => {
  try {
    const { fileNames, apiKey, model, baseUrl } = req.body;

    if (!fileNames || !Array.isArray(fileNames) || fileNames.length === 0) {
      return res.json({ ok: true, results: {} });
    }

    const results = await classifyTags(fileNames, apiKey, { model, baseUrl });
    res.json({ ok: true, results });
  } catch (e) {
    log.error({ err: e }, 'classify/tags 路由错误');
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/classify/download
 * Body: { cardTitle: string, fileNames: string[], apiKey?, model?, baseUrl? }
 */
router.post('/download', async (req, res) => {
  try {
    const { cardTitle, fileNames, apiKey, model, baseUrl } = req.body;

    if (!cardTitle || !fileNames || !Array.isArray(fileNames) || fileNames.length === 0) {
      return res.status(400).json({ ok: false, error: '请提供 cardTitle 和 fileNames' });
    }

    // 流式 NDJSON：每批 AI 结果立即写入一行 JSON
    const results = await Promise.race([
      classifyDownload(cardTitle, fileNames, apiKey, { model, baseUrl }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('classify/download 超时（120s）')), 120000)),
    ]);
    res.json({ ok: true, ...results });
  } catch (e) {
    log.error({ err: e }, 'classify/download 路由错误');
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;