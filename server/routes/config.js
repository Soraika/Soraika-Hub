const express = require('express');
const router = express.Router();
const config = require('../config');

// 获取全量配置（敏感字段脱敏）
router.get('/', (req, res) => {
  res.json({ ok: true, config: config.getAll() });
});

// 合并更新配置
// Body: { mikan: { baseUrl: "..." }, nas: { url: "..." } }
router.put('/', (req, res) => {
  try {
    const updated = config.update(req.body);
    res.json({ ok: true, config: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;