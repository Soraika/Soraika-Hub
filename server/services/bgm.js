const config = require('../config');

const UA = 'MikanAPI/1.0 (NAS bot)';

/** 获取 BGM 配置 */
function getBgmConfig() {
  return {
    baseUrl: config.get('bgm.baseUrl') || 'https://api.bgm.tv',
    token: config.get('bgm.token') || '',
  };
}

// ── 条目详情 ──

/**
 * 获取 BGM 条目详情（评分、简介、标签等）
 * @param {number} subjectId - BGM 条目 ID
 * @returns {Promise<object>}
 */
async function fetchSubjectDetail(subjectId) {
  const { baseUrl, token } = getBgmConfig();
  const url = `${baseUrl}/v0/subjects/${subjectId}`;
  const headers = { 'User-Agent': UA };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`BGM API 请求失败: ${res.status}`);
  const raw = await res.json();

  return {
    id: raw.id,
    name: raw.name,
    nameCn: raw.name_cn || null,
    type: raw.type,               // 1=书籍 2=动画 3=音乐 4=游戏 6=三次元
    summary: raw.summary || '',
    image: raw.images?.large || raw.images?.common || null,
    rating: raw.rating ? {
      score: raw.rating.score || null,
      total: raw.rating.total || 0,
    } : null,
    rank: raw.rank || null,
    tags: (raw.tags || []).map(t => ({ name: t.name, count: t.count })),
    date: raw.date || null,         // 发售/开播日期
    eps: raw.eps || null,           // 总集数
    totalEpisodes: raw.total_episodes || null,
    platform: raw.platform || null, // TV/剧场版/OVA等
    infobox: (raw.infobox || []).map(i => ({ key: i.key, value: i.value })),
    collection: raw.collection ? {
      wish: raw.collection.wish || 0,
      collect: raw.collection.collect || 0,
      doing: raw.collection.doing || 0,
      onHold: raw.collection.on_hold || 0,
      dropped: raw.collection.dropped || 0,
    } : null,
  };
}

// ── 搜索 ──

/**
 * 搜索 BGM 条目
 * @param {string} keyword - 关键词
 * @param {object} [opts]
 * @param {string} [opts.type] - 条目类型 1/2/3/4/6
 * @param {number} [opts.limit=10]
 */
async function searchSubjects(keyword, opts = {}) {
  const { baseUrl, token } = getBgmConfig();
  const params = new URLSearchParams({ keyword, limit: opts.limit || 10 });
  if (opts.type) params.set('type', opts.type);

  const url = `${baseUrl}/v0/search/subjects?${params}`;
  const headers = { 'User-Agent': UA };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`BGM 搜索失败: ${res.status}`);
  const data = await res.json();

  return (data.data || []).map(item => ({
    id: item.id,
    name: item.name,
    nameCn: item.name_cn || null,
    type: item.type,
    image: item.images?.large || item.images?.common || null,
    rating: item.rating?.score || null,
    summary: item.summary || '',
    date: item.date || null,
  }));
}

module.exports = { fetchSubjectDetail, searchSubjects };