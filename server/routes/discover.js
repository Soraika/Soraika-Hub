const express = require('express');
const router = express.Router();
const recommend = require('../services/recommend');

// 首屏：五模块各 20 条 + 状态
router.get('/modules', (req, res) => {
  const modules = recommend.getAllModules();
  const st = recommend.status();
  res.json({ ok: true, ready: st.ready, syncing: st.syncing, updatedAt: st.updatedAt, modules });
});

// 换一批：单模块（refresh=1 触发时间权偏移）
router.get('/', (req, res) => {
  const { module, refresh } = req.query;
  const valid = Object.keys(recommend.MODULES);
  const modId = module || 'praise';

  if (!valid.includes(modId)) {
    return res.status(400).json({ ok: false, error: `未知模块: ${modId}，可选: ${valid.join(', ')}` });
  }

  if (refresh === '1' || refresh === 'true') {
    recommend.nextBatch(modId);
  }

  const items = recommend.getModuleBatch(modId);
  const st = recommend.status();
  res.json({
    ok: true,
    module: modId,
    refreshCount: st.refreshCounts[modId] || 0,
    updatedAt: st.updatedAt,
    count: items.length,
    items,
  });
});

// 状态（调试用）
router.get('/status', (req, res) => {
  res.json({ ok: true, ...recommend.status() });
});

module.exports = router;