const express = require('express');
const router = express.Router();
const { getTransferInfo, getTorrents, addTorrent, addTorrents, deleteTorrents, renameFile } = require('../services/qb');
const log = require('../utils/logger').child('qb');

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
    log.error({ err: e }, 'GET /qb/status 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 任务列表（支持 ?category= 过滤本平台任务）
router.get('/torrents', async (req, res) => {
  try {
    const { category } = req.query;
    const list = await getTorrents(category);
    res.json({ ok: true, torrents: list });
  } catch (e) {
    log.error({ err: e }, 'GET /qb/torrents 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 删除/取消任务
router.delete('/torrents/:hash', async (req, res) => {
  try {
    const ok = await deleteTorrents(req.params.hash);
    res.json({ ok });
  } catch (e) {
    log.error({ err: e }, 'DELETE /qb/torrents/:hash 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 普通下载（单条，含自动重命名）
router.post('/add', async (req, res) => {
  try {
    const { magnet, torrent, savePath, rename, taskName } = req.body;
    if (!magnet && !torrent) {
      return res.status(400).json({ ok: false, error: '缺少 magnet 或 torrent 参数' });
    }
    const result = await addTorrent({ magnet, torrent, savePath, rename, taskName });
    res.json(result);
  } catch (e) {
    log.error({ err: e }, 'POST /qb/add 失败');
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
    log.error({ err: e }, 'POST /qb/anime 失败');
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
    log.error({ err: e }, 'POST /qb/rename 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 已下载的 hash 列表（直接查 QB soraika-hub 分类，不依赖数据库）
router.get('/download-hashes', async (req, res) => {
  try {
    const { getQBConfig } = require('../services/qb');
    const { url, token } = getQBConfig();
    const qbRes = await fetch(`${url}/api/v2/torrents/info?category=soraika-hub`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!qbRes.ok) throw new Error(`QB 请求失败 (${qbRes.status})`);
    const torrents = await qbRes.json();
    const hashes = torrents.map(t => t.hash);
    res.json({ ok: true, hashes });
  } catch (e) {
    log.error({ err: e }, 'GET /qb/download-hashes 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 番剧下载列表（从 QB 任务名解析 bgmid/番名/季/集，用于下载页面）
router.get('/anime-torrents', async (req, res) => {
  try {
    const { getQBConfig } = require('../services/qb');
    const { url, token } = getQBConfig();
    const qbRes = await fetch(`${url}/api/v2/torrents/info?category=soraika-hub`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!qbRes.ok) throw new Error(`QB 请求失败 (${qbRes.status})`);

    const torrents = await qbRes.json();

    // 并发查询文件信息
    const fileResults = await Promise.all(
      torrents.map(t =>
        fetch(`${url}/api/v2/torrents/files?hash=${t.hash}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        }).then(r => r.ok ? r.json() : []).catch(() => [])
      )
    );

    const results = torrents.map((t, i) => {
      // 新任务：元数据存在 tags 的 soraika: 前缀里（任务名为原始标题）；旧任务回退从任务名解析
      // QB API 的 tags 可能是逗号分隔字符串，也可能是数组，做兼容
      const tags = typeof t.tags === 'string' ? t.tags.split(',') : (Array.isArray(t.tags) ? t.tags : []);
      const metaTag = tags.find(x => String(x).startsWith('soraika:'));
      let m = null
      if (metaTag) {
        m = String(metaTag).slice('soraika:'.length).match(/^\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]/);
      }
      if (!m) m = t.name.match(/^\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]/);
      const files = fileResults[i] || [];
      const fileNames = files.map(f => {
        const p = f.name.split('/').pop();
        return p;
      });
      return {
        hash: t.hash,
        name: t.name,
        savePath: t.save_path,
        state: t.state,
        progress: t.progress,
        size: t.size,
        mikanId: m ? (m[1] === 'null' ? null : m[1]) : null,
        animeName: m ? (m[2] === 'null' ? null : m[2]) : null,
        season: m && m[3] !== 'null' ? parseInt(m[3]) : 1,
        episode: m ? (m[4] === 'null' ? null : m[4]) : null,
        subgroupId: m ? (m[5] === 'null' ? null : m[5]) : null,
        subgroupName: m ? (m[6] === 'null' ? null : m[6]) : null,
        fileCount: files.length,
        files: fileNames,
      };
    });

    res.json({ ok: true, torrents: results });
  } catch (e) {
    log.error({ err: e }, 'GET /qb/anime-torrents 失败');
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;