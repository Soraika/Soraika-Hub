const express = require('express');
const router = express.Router();
const recommend = require('../services/recommend');
const log = require('../utils/logger').child('discover');

// 首屏：五模块各 20 条 + 状态
router.get('/modules', (req, res) => {
  try {
    const modules = recommend.getAllModules();
    const st = recommend.status();
    res.json({ ok: true, ready: st.ready, syncing: st.syncing, updatedAt: st.updatedAt, modules });
  } catch (e) {
    log.error({ err: e }, 'GET /discover/modules 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 换一批：单模块（refresh=1 触发时间权偏移）
router.get('/', (req, res) => {
  try {
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
  } catch (e) {
    log.error({ err: e }, 'GET /discover 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 状态（调试用）
router.get('/status', (req, res) => {
  try {
    res.json({ ok: true, ...recommend.status() });
  } catch (e) {
    log.error({ err: e }, 'GET /discover/status 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;