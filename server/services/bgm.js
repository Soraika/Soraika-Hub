const config = require('../config');

const UA = 'MikanAPI/1.0 (NAS bot)';

function getBgmConfig() {
  return {
    baseUrl: config.get('bgm.baseUrl') || 'https://api.bgm.tv',
    token: config.get('bgm.token') || '',
  };
}

// ── 条目详情 ──

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
    type: raw.type,
    summary: raw.summary || '',
    image: raw.images?.large || raw.images?.common || null,
    rating: raw.rating ? {
      score: raw.rating.score || null,
      total: raw.rating.total || 0,
    } : null,
    rank: raw.rank || null,
    tags: (raw.tags || []).map(t => ({ name: t.name, count: t.count })),
    date: raw.date || null,
    eps: raw.eps || null,
    totalEpisodes: raw.total_episodes || null,
    platform: raw.platform || null,
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

async function searchSubjects(keyword, opts = {}) {
  const { baseUrl } = getBgmConfig();
  // BGM 镜像使用旧版 API: /search/subject/:keyword
  const url = `${baseUrl}/search/subject/${encodeURIComponent(keyword)}`;
  const headers = { 'User-Agent': UA };

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return []
    const data = await res.json();
    const list = data.list || data || []
    return (Array.isArray(list) ? list : []).map(item => ({
      id: item.id,
      name: item.name,
      nameCn: item.name_cn || null,
      type: item.type,
      image: item.images?.large || item.images?.common || null,
      rating: item.rating?.score || null,
      summary: item.summary || '',
      date: item.date || null,
    }));
  } catch {
    return []
  }
}

// ── 条目列表（镜像 /v0/search/subjects，支持 sort/filter/分页） ──

/**
 * 批量搜索/榜单条目
 * @param {Object} opts { offset, limit, sort, filter }
 *  - sort: 'heat' | 'rank' | 'score' | 'match'
 *  - filter: { type: [2], air_date: ['>=2000-01-01'], tags: [] }
 * @returns {Array} 精简条目数组
 */
async function fetchSubjectList(opts = {}) {
  const { baseUrl } = getBgmConfig();
  const { offset = 0, limit = 50, sort = 'heat', filter = {} } = opts;

  const url = `${baseUrl}/v0/search/subjects?limit=${limit}&offset=${offset}`;
  const headers = { 'User-Agent': UA, 'Content-Type': 'application/json' };
  const body = {};
  if (sort) body.sort = sort;
  if (filter && Object.keys(filter).length) body.filter = filter;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`BGM search/subjects 请求失败: ${res.status}`);
  const data = await res.json();

  return (data.data || []).map(item => ({
    id: item.id,
    name: item.name,
    nameCn: item.name_cn || null,
    image: item.images?.medium || item.images?.large || item.images?.common || null,
    date: item.date || null,
    nsfw: item.nsfw || false,
    platform: item.platform || null,
    sumTotal: data.total ?? null,
    eps: item.eps || null,
    totalEpisodes: item.total_episodes || null,
    rating: item.rating ? {
      score: item.rating.score || null,
      total: item.rating.total || 0,
      rank: item.rating.rank || null,
      count: item.rating.count || null,
    } : null,
    collection: item.collection ? {
      wish: item.collection.wish || 0,
      collect: item.collection.collect || 0,
      doing: item.collection.doing || 0,
      onHold: item.collection.on_hold || 0,
      dropped: item.collection.dropped || 0,
    } : null,
    tags: (item.tags || []).map(t => t.name).slice(0, 8),
  }));
}

// ── 放送日历（本周每日放送番剧） ──

async function fetchCalendar() {
  const { baseUrl } = getBgmConfig();
  const headers = { 'User-Agent': UA };
  const res = await fetch(`${baseUrl}/calendar`, { headers });
  if (!res.ok) throw new Error(`BGM calendar 请求失败: ${res.status}`);
  const raw = await res.json();
  const DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const days = (Array.isArray(raw) ? raw : []).map(day => {
    const weekdayId = day.weekday?.id ?? null;
    const weekdayCn = day.weekday?.cn || DAYS[weekdayId - 1] || `周${weekdayId}`;
    const items = (day.items || []).map(item => ({
      id: item.id,
      name: item.name,
      nameCn: item.name_cn || null,
      image: item.images?.medium || item.images?.large || item.images?.common || item.image || null,
      date: item.date || null,
      eps: item.eps || null,
      totalEpisodes: item.total_episodes || null,
      rating: item.rating ? { score: item.rating.score || null, total: item.rating.total || 0 } : null,
      collection: item.collection ? {
        wish: item.collection.wish || 0,
        collect: item.collection.collect || 0,
        doing: item.collection.doing || 0,
      } : null,
      tags: (item.tags || []).map(t => t.name).slice(0, 5),
    }));
    return { weekdayId, weekdayCn, items };
  });

  return days;
}

module.exports = { fetchSubjectDetail, searchSubjects, fetchSubjectList, fetchCalendar };
