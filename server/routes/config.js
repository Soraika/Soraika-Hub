const express = require('express');
const router = express.Router();
const config = require('../config');
const log = require('../utils/logger').child('config');

// 获取全量配置（敏感字段脱敏）
router.get('/', (req, res) => {
  try {
    res.json({ ok: true, config: config.getAll() });
  } catch (e) {
    log.error({ err: e }, 'GET /api/config 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 合并更新配置
// Body: { mikan: { baseUrl: "..." }, nas: { url: "..." } }
router.put('/', (req, res) => {
  try {
    const { config: updated, saved } = config.update(req.body);
    if (!saved) {
      log.error('PUT /api/config 保存失败：数据目录不可写');
      return res.status(500).json({ ok: false, error: '配置写入失败：请检查数据目录（/data）写入权限' });
    }
    res.json({ ok: true, config: updated });
  } catch (e) {
    log.error({ err: e }, 'PUT /api/config 更新失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;