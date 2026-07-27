const express = require('express');
const router = express.Router();
const { getTransferInfo, getTorrents, addTorrent, addTorrents, renameFile } = require('../services/qb');

// QB 连接状态
router.get('/status', async (req, res) => {
  try {
    const st = await getTransferInfo();
    if (st.connected) {
      const dl = st.dlSpeed ? (st.dlSpeed / 1024 / 1024).toFixed(1) + ' MB/s' : '0 B/s';
      const up = st.upSpeed ? (st.upSpeed / 1024 / 1024).toFixed(1) + ' MB/s' : '0 B/s';
      res.json({ ok: true, dlSpeed: dl, upSpeed: up });
    } else {
      res.json({ ok: false, error: st.error });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 任务列表
router.get('/torrents', async (req, res) => {
  try {
    const list = await getTorrents();
    res.json({ ok: true, torrents: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 普通下载（单条，含自动重命名）
router.post('/add', async (req, res) => {
  try {
    const { magnet, torrent, savePath, rename } = req.body;
    if (!magnet && !torrent) {
      return res.status(400).json({ ok: false, error: '缺少 magnet 或 torrent 参数' });
    }
    const result = await addTorrent({ magnet, torrent, savePath, rename });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 番剧批量下载（含自动重命名）
router.post('/anime', async (req, res) => {
  try {
    const { torrents } = req.body;
    if (!torrents || !Array.isArray(torrents) || torrents.length === 0) {
      return res.status(400).json({ ok: false, error: '请提供 torrents 数组，每项含 magnet/torrent/savePath/rename' });
    }
    const results = await addTorrents(torrents);
    const success = results.filter(r => r.ok).length;
    res.json({ ok: true, total: results.length, success, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 手动重命名文件（下载中即可调用）
router.post('/rename', async (req, res) => {
  try {
    const { hash, name } = req.body;
    if (!hash || !name) {
      return res.status(400).json({ ok: false, error: '缺少 hash 或 name 参数' });
    }
    const ok = await renameFile(hash, name);
    res.json({ ok, error: ok ? undefined : '重命名失败' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;