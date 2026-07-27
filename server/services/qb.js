const config = require('../config');

function getQBConfig() {
  return {
    url: config.get('qbittorrent.url') || '',
    token: config.get('qbittorrent.token') || '',
    basePath: config.get('qbittorrent.basePath') || '/downloads',
  };
}

async function qbFetch(path, opts = {}) {
  const { url, token } = getQBConfig();
  if (!url || !token) throw new Error('qBittorrent 未配置');
  return fetch(`${url}${path}`, {
    ...opts,
    headers: { 'Authorization': `Bearer ${token}`, ...(opts.headers || {}) },
    redirect: 'manual',
  });
}

// ── 状态查询 ──

async function getTransferInfo() {
  try {
    const res = await qbFetch('/api/v2/transfer/info');
    if (!res.ok) return { connected: false, error: `QB 请求失败 (${res.status})` };
    const info = await res.json();
    return { connected: true, dlSpeed: info.dl_info_speed || 0, upSpeed: info.up_info_speed || 0 };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

async function getTorrents() {
  const res = await qbFetch('/api/v2/torrents/info');
  if (!res.ok) throw new Error(`QB 请求失败 (${res.status})`);
  return res.json();
}

// ── 工具 ──

function extractHash(url) {
  const m = url.match(/btih:([a-f0-9]+)/i);
  if (m) return m[1].toLowerCase();
  const m2 = url.match(/\/([a-f0-9]{40})\.torrent/i);
  if (m2) return m2[1].toLowerCase();
  return null;
}

// ── 添加下载 ──

async function addTorrent(item) {
  const url = item.torrent || item.magnet;
  if (!url) throw new Error('缺少 magnet 或 torrent 参数');

  const params = new URLSearchParams();
  params.set('urls', url);
  if (item.savePath) params.set('savepath', item.savePath);
  if (item.rename) params.set('rename', item.rename);

  const res = await qbFetch('/api/v2/torrents/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const text = await res.text();

  let ok = false;
  if (text === 'Ok.' || text === '') ok = true;
  else if (/duplicate|exist/i.test(text)) return { ok: false, error: '已在下载列表中' };
  else {
    try {
      const json = JSON.parse(text);
      if (json.added_torrent_ids?.length > 0 || json.pending_count > 0) ok = true;
      else if (json.failure_count > 0) return { ok: false, error: '添加失败：可能已被阻止或重复' };
      else return { ok: false, error: JSON.stringify(json) };
    } catch {
      return { ok: false, error: text || `添加失败 (${res.status})` };
    }
  }

  // 添加成功后，如有 rename 参数则自动重命名实际文件
  const hash = extractHash(url);
  if (ok && item.rename && hash) {
    try {
      await renameFile(hash, item.rename);
    } catch {}
  }

  return { ok: true, hash };
}

async function addTorrents(torrents) {
  const results = [];
  for (const item of torrents) {
    try {
      const r = await addTorrent(item);
      results.push({ ...r, magnet: item.magnet });
    } catch (e) {
      results.push({ ok: false, error: e.message, magnet: item.magnet });
    }
  }
  return results;
}

// ── 文件重命名（QB 5.0: /api/v2/torrents/renameFile, oldPath + newPath）──

async function renameFile(hash, newName) {
  // 1. 获取文件列表，取第一个文件的原始名称作为 oldPath
  let oldPath = newName;
  try {
    const filesRes = await qbFetch('/api/v2/torrents/files?hash=' + hash);
    if (filesRes.ok) {
      const files = await filesRes.json();
      if (files.length > 0) oldPath = files[0].name;
    }
  } catch {}

  // 2. 调用 renameFile（QB 5.0 驼峰命名）
  const res = await qbFetch('/api/v2/torrents/renameFile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `hash=${hash}&oldPath=${encodeURIComponent(oldPath)}&newPath=${encodeURIComponent(newName)}`,
  });
  return res.ok;
}

module.exports = { getTransferInfo, getTorrents, addTorrent, addTorrents, renameFile };