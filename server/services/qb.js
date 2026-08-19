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

async function getTorrents(category) {
  let path = '/api/v2/torrents/info';
  if (category) path += `?category=${encodeURIComponent(category)}`;
  const res = await qbFetch(path);
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
  params.set('category', 'soraika-hub');
  if (item.tags) {
    params.set('tags', Array.isArray(item.tags) ? item.tags.join(',') : item.tags);
  }
  if (item.savePath) {
    const { basePath } = getQBConfig();
    const fullPath = basePath.replace(/\/$/, '') + '/' + item.savePath.replace(/^\//, '');
    params.set('savepath', fullPath);
  }
  if (item.taskName) {
    params.set('rename', item.taskName);
  }

  const hash = extractHash(url);

  // 带重试的 QB add 请求
  let ok = false;
  let lastError = null;
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      console.warn(`[QB] add 重试 ${attempt}/${maxAttempts - 1} → ${url.slice(0, 60)}...`);
      await new Promise(r => setTimeout(r, 2000));
    }

    try {
      const res = await qbFetch('/api/v2/torrents/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      const text = await res.text();

      if (text === 'Ok.' || text === '') {
        ok = true;
        break;
      } else if (/duplicate|exist/i.test(text)) {
        return { ok: false, error: '已在下载列表中' };
      } else {
        try {
          const json = JSON.parse(text);
          if (json.added_torrent_ids?.length > 0 || json.pending_count > 0) {
            ok = true;
            break;
          } else if (json.failure_count > 0) {
            return { ok: false, error: '添加失败：可能已被阻止或重复', hash };
          } else {
            lastError = JSON.stringify(json);
          }
        } catch {
          lastError = text || `添加失败 (${res.status})`;
        }
      }
    } catch (e) {
      lastError = e.message;
    }
  }

  if (!ok) {
    return { ok: false, error: `QB 添加失败（已重试${maxAttempts}次）: ${lastError}`, hash };
  }

  // 如有 rename 参数则轮询等待元数据就绪后自动重命名
  if (item.rename && hash) {
    const animeName = item.savePath ? item.savePath.split('/')[0] : '';
    waitForMetaThenRename(hash, item.rename, animeName);
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

// ── 重命名轮询 ──

function waitForMetaThenRename(hash, newName, animeName) {
  (async () => {
    await new Promise(r => setTimeout(r, 2000));

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        const filesRes = await qbFetch('/api/v2/torrents/files?hash=' + hash);
        if (!filesRes.ok) { await new Promise(r => setTimeout(r, 3000)); continue; }
        const files = await filesRes.json();
        if (files.length === 0) { await new Promise(r => setTimeout(r, 3000)); continue; }

        if (files.length === 1 && !(files[0].name || '').includes('/')) {
          // 单文件：直接 renameFile
          const oldPath = files[0].name;
          const extMatch = oldPath.match(/\.([a-z0-9]+)$/i);
          const finalName = extMatch ? newName.replace(/\.[^.]+$|$/, extMatch[0]) : newName;
          await qbFetch('/api/v2/torrents/renameFile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `hash=${hash}&oldPath=${encodeURIComponent(oldPath)}&newPath=${encodeURIComponent(finalName)}`,
          });
        } else {
          // 多文件：调 AI 解析真实集数，逐文件 renameFile 并移出文件夹
          const { classifyDownload } = require('./classifier');
          const videoExts = ['.mkv', '.mp4', '.avi', '.mov', '.webm'];
          const baseNames = files.map(f => f.name.split('/').pop());
          const videoFiles = baseNames.filter(n => videoExts.some(e => n.toLowerCase().endsWith(e)));

          if (videoFiles.length > 0) {
            try {
              const aiResult = await classifyDownload(animeName || '', videoFiles);
              const epMap = aiResult?.episodes || {};
              for (const f of files) {
                const oldPath = f.name;
                const baseName = oldPath.split('/').pop();
                const ext = (baseName.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
                const isVideo = videoExts.some(e => baseName.toLowerCase().endsWith(e));
                let finalName;
                if (isVideo) {
                  const ep = epMap[baseName];
                  if (ep != null && typeof ep === 'number') {
                    const seasonNum = (aiResult.season || 1);
                    const epStr = String(ep).padStart(2, '0');
                    finalName = `${animeName || '未命名'} S${String(seasonNum).padStart(2, '0')}E${epStr}.${ext}`;
                  } else {
                    finalName = baseName;
                  }
                } else {
                  finalName = baseName;
                }
                await qbFetch('/api/v2/torrents/renameFile', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: `hash=${hash}&oldPath=${encodeURIComponent(oldPath)}&newPath=${encodeURIComponent(finalName)}`,
                });
              }
            } catch {
              // AI 失败兜底：保持原名移出文件夹
              for (const f of files) {
                const oldPath = f.name;
                const baseName = oldPath.split('/').pop();
                await qbFetch('/api/v2/torrents/renameFile', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: `hash=${hash}&oldPath=${encodeURIComponent(oldPath)}&newPath=${encodeURIComponent(baseName)}`,
                });
              }
            }
          }
        }
        return;
      } catch { await new Promise(r => setTimeout(r, 3000)); }
    }
  })();
}

// ── 文件重命名 ──

async function renameFile(hash, newName) {
  try {
    const filesRes = await qbFetch('/api/v2/torrents/files?hash=' + hash);
    if (!filesRes.ok) return false;
    const files = await filesRes.json();
    if (files.length === 0) return false;

    const oldPath = files[0].name;
    const extMatch = oldPath.match(/\.([a-z0-9]+)$/i);
    const finalName = extMatch ? newName.replace(/\.[^.]+$|$/, extMatch[0]) : newName;

    const res = await qbFetch('/api/v2/torrents/renameFile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `hash=${hash}&oldPath=${encodeURIComponent(oldPath)}&newPath=${encodeURIComponent(finalName)}`,
    });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { getQBConfig, getTransferInfo, getTorrents, addTorrent, addTorrents, renameFile };