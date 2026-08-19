const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');
const config = require('../config');

const UA = 'MikanAPI/1.0 (NAS bot)';
const DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六', '剧场版', 'OVA'];

/** 获取 Mikan 站点地址：优先参数覆盖，其次 config */
function getBaseUrl(override) {
  return override || config.get('mikan.baseUrl') || 'https://mikanime.tv';
}

// ── 解析 RSS 条目 ──

/** 从 RSS 条目提取基础字段 */
function parseItem(raw) {
  const title = raw.title || raw.guid || '';
  const hash = raw.link ? raw.link.split('/').pop() : null;

  return {
    title,
    magnetHash: hash,
    magnet: hash ? `magnet:?xt=urn:btih:${hash}` : null,
    torrent: raw.enclosure?.url || null,
    link: raw.link || null,
    sizeBytes: raw.torrent?.contentLength ? parseInt(raw.torrent.contentLength) : null,
    pubDate: raw.torrent?.pubDate || raw.pubDate || null,
  };
}

/** 解析 RSS XML 的通用方法 */
function parseRSSXml(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (name) => name === 'item',
  });
  const parsed = parser.parse(xml);
  return parsed?.rss?.channel?.item || [];
}

// ── 最新更新（RSS） ──

async function fetchRSS(baseUrlOverride) {
  const BASE = getBaseUrl(baseUrlOverride);
  const res = await fetch(`${BASE}/RSS/Classic`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`RSS 请求失败: ${res.status}`);
  return parseRSSXml(await res.text()).map(parseItem);
}

// ── RSS 搜索 ──

async function searchRSS(keyword, baseUrlOverride) {
  const BASE = getBaseUrl(baseUrlOverride);
  const res = await fetch(`${BASE}/RSS/Search?searchstr=${encodeURIComponent(keyword)}`, {
    headers: { 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`RSS 搜索失败: ${res.status}`);
  return parseRSSXml(await res.text()).map(parseItem);
}

// ── 首页排期（本周 / 历史季度） ──

async function fetchSchedule(opts = {}) {
  const { year, season } = opts;
  const BASE = getBaseUrl(opts.baseUrl);

  let url = BASE;
  if (year && season) {
    url = `${BASE}/Home/BangumiCoverFlowByDayOfWeek?year=${year}&seasonStr=${encodeURIComponent(season)}`;
  }

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 10000);
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
  clearTimeout(to);

  if (!res.ok) throw new Error(`排期页面请求失败: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const schedule = [];

  for (let day = 0; day <= 8; day++) {
    const dayBlock = $(`.sk-bangumi[data-dayofweek="${day}"]`);
    if (!dayBlock.length) continue;

    const animes = [];
    dayBlock.find('li').each((_, li) => {
      const $li = $(li);
      const link = $li.find('a.an-text');
      const href = link.attr('href') || '';
      const bgmid = href.replace('/Home/Bangumi/', '');
      const name = link.attr('title') || link.text().trim();
      if (!bgmid || !name) return;

      const span = $li.find('span.js-expand_bangumi');
      const posterThumb = span.data('src') || span.attr('data-src') || '';

      animes.push({
        bgmid: parseInt(bgmid) || bgmid,
        name,
        poster: posterThumb ? `${BASE}${posterThumb.replace(/\?.*$/, '')}` : '',
      });
    });

    if (animes.length > 0) {
      schedule.push({ day, dayLabel: DAYS[day] || `Day${day}`, animes });
    }
  }

  return schedule;
}

// ── 番剧详情（海报 + 字幕组列表） ──

async function fetchBangumiDetail(bangumiId, baseUrlOverride) {
  const BASE = getBaseUrl(baseUrlOverride);
  const url = `${BASE}/Home/Bangumi/${bangumiId}`;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 8000);
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
  clearTimeout(to);

  if (!res.ok) throw new Error(`详情页请求失败: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const title = $('p.bangumi-title').first().text().trim() || $('title').text().trim();

  const posterDiv = $('.bangumi-poster');
  let poster = '';
  if (posterDiv.length) {
    const bg = posterDiv.attr('style') || '';
    const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (m) {
      poster = m[1].replace(/\?.*$/, '');
      if (!poster.startsWith('http')) poster = `${BASE}${poster}`;
    }
  }

  const subgroups = [];
  const seen = new Set();
  $('a.subgroup-name').each((_, a) => {
    const href = $(a).attr('data-anchor') || $(a).attr('href') || '';
    const sgId = href.replace('#', '');
    const sgName = $(a).text().trim();
    if (sgId && sgName && !seen.has(sgId)) {
      seen.add(sgId);
      subgroups.push({ id: sgId, name: sgName });
    }
  });
  $('.subgroup-text').each((_, div) => {
    const sgId = $(div).attr('id');
    if (!sgId || seen.has(sgId)) return;
    seen.add(sgId);
    const sgName = ($(div).find('.dropdown-toggle span').text() || $(div).first().text() || '').trim();
    if (sgName) subgroups.push({ id: sgId, name: sgName });
  });

  return { bgmid: parseInt(bangumiId) || bangumiId, title, poster, subgroups };
}

// ── 番剧字幕组 RSS ──

async function fetchBangumiRSS(bangumiId, subgroupId, baseUrlOverride) {
  const BASE = getBaseUrl(baseUrlOverride);
  const url = `${BASE}/RSS/Bangumi?bangumiId=${bangumiId}&subgroupid=${subgroupId}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`RSS 请求失败: ${res.status}`);

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const parsed = parser.parse(await res.text());
  const raw = parsed?.rss?.channel?.item || [];
  const items = Array.isArray(raw) ? raw : [raw];

  return items.map(parseItem);
}

// ── 按番剧名分组 ──

function groupByAnime(items) {
  const map = new Map();
  for (const item of items) {
    const cleaned = item.title.replace(/^\[[^\]]+\]\s*/, '');
    const key = cleaned.replace(/\s*-\s*\d+.*$/, '').trim() || cleaned;
    if (!map.has(key)) {
      map.set(key, { animeName: key, releases: [] });
    }
    map.get(key).releases.push(item);
  }
  return Array.from(map.values());
}

// ── HTML 番剧搜索 ──

async function searchBangumi(keyword, baseUrlOverride) {
  const BASE = getBaseUrl(baseUrlOverride);
  const url = `${BASE}/Home/Search?searchstr=${encodeURIComponent(keyword)}`;

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 10000);
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
  clearTimeout(to);

  if (!res.ok) throw new Error(`搜索请求失败: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const items = [];
  $('a[href*="/Home/Bangumi/"]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    const bgmid = href.replace('/Home/Bangumi/', '');
    if (!bgmid) return;

    // 从 .an-text 的 title 获取番剧名
    const textEl = $a.find('.an-text');
    const name = textEl.attr('title') || textEl.text().trim();
    if (!name) return;

    // 从 span.b-lazy 的 data-src 获取海报缩略图
    const imgSpan = $a.find('span.b-lazy');
    const src = imgSpan.attr('data-src') || imgSpan.data('src') || '';
    let poster = '';
    if (src) {
      poster = src.startsWith('http') ? src : `${BASE}${src}`;
      poster = poster.replace(/\?.*$/, ''); // 去查询参数
    }

    items.push({ bgmid: parseInt(bgmid) || bgmid, name, poster });
  });

  return items;
}

module.exports = {
  parseItem,
  fetchRSS,
  searchRSS,
  searchBangumi,
  fetchSchedule,
  fetchBangumiDetail,
  fetchBangumiRSS,
  groupByAnime,
};
