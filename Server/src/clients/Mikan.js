import * as cheerio from 'cheerio';
// 日志统一走 lib/logger.js（不在各 client 里各建一个 pino —— 那样输出格式会不一致）
import { logger } from '../lib/logger.js';


async function fetchWithTimeOut(fetchUrl, tip, retries = 2) {
  const startedAt = Date.now();

  // 地址为空 / 格式非法：属于调用方参数错误，不重试
  if (!fetchUrl) {
    logger.error({ tip }, 'mikan.fetch invalid empty-url');
    throw new Error(`请求 ${tip} 失败：请求地址为空`);
  }

  let finalUrl;
  try {
    finalUrl = new URL(fetchUrl);
  } catch (error) {
    logger.error({ tip, fetchUrl, err: error.message }, 'mikan.fetch invalid bad-url');
    throw new Error(`请求 ${tip} 失败：请求地址格式非法`);
  }

  try {
    // 请求/成功是高频细节 → debug，默认（info）不刷屏；要排上游问题设 LOG_LEVEL=debug
    logger.debug({ tip, url: finalUrl.href }, 'mikan.fetch start');
    const response = await fetch(finalUrl.href, {
      method: 'GET',
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      logger.warn({ tip, url: finalUrl.href, status: response.status }, 'mikan.fetch fail');
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    if (!html) {
      logger.warn({ tip, url: finalUrl.href }, 'mikan.fetch empty');
      throw new Error('返回值为空');
    }

    logger.debug(
      { tip, url: finalUrl.href, status: response.status, ms: Date.now() - startedAt },
      'mikan.fetch ok',
    );
    return html;
  } catch (error) {
    if (retries > 0) {
      logger.warn(
        { tip, url: finalUrl.href, retriesLeft: retries - 1, err: error.message },
        'mikan.fetch retry',
      );
      await new Promise(resolve => setTimeout(resolve, 5000));
      return fetchWithTimeOut(finalUrl.href, tip, retries - 1);
    }

    logger.error(
      { tip, url: finalUrl.href, err: error.message, ms: Date.now() - startedAt },
      'mikan.fetch abort',
    );
    throw new Error(`获取 ${tip} 失败：${error.message}`);
  }
}

async function getMikanHomePage(baseUrl, retries = 2) {
  return await fetchWithTimeOut(baseUrl, 'MikanHomePage', retries);
}

async function getMikanSeasonPage(baseUrl, year, season, retries = 2) {
  if (!(baseUrl && year && season)) {
    logger.error({ baseUrl, year, season }, 'mikan.season invalid-params');
    throw new Error('请求 MikanSeasonPage 失败：传入参数缺少或为空');
  }

  // 构成新请求地址
  let finalUrl;
  try {
    finalUrl = new URL('/Home/BangumiCoverFlowByDayOfWeek', baseUrl);
  } catch (error) {
    logger.error({ baseUrl, err: error.message }, 'mikan.season invalid-base');
    throw new Error(`请求 MikanSeasonPage 失败：baseUrl 格式非法`);
  }
  finalUrl.searchParams.set('year', year);
  finalUrl.searchParams.set('seasonStr', season);

  return await fetchWithTimeOut(finalUrl.href, 'MikanSeasonPage', retries);
}

async function getAnimeDetailPage(baseUrl, mikanid, retries = 2) {
  if (!(baseUrl && mikanid)) {
    logger.error({ baseUrl, mikanId: mikanid }, 'mikan.detail invalid-params');
    throw new Error('请求 AnimeDetailPage 失败：传入参数缺少或为空');
  }

  // 构造请求地址
  let finalUrl;
  try {
    finalUrl = new URL(`/Home/Bangumi/${mikanid}`, baseUrl);
  } catch (error) {
    logger.error({ baseUrl, err: error.message }, 'mikan.detail invalid-base');
    throw new Error(`请求 AnimeDetailPage 失败：baseUrl 格式非法`);
  }

  return await fetchWithTimeOut(finalUrl.href, 'AnimeDetailPage', retries);
}

async function getAnimeRSSPage(baseUrl, mikanid, subgroupRSSId, retries = 2) {
  if (!(baseUrl && mikanid && subgroupRSSId)) {
    logger.error({ baseUrl, mikanId: mikanid, subgroupRSSId }, 'mikan.rss invalid-params');
    throw new Error('请求 AnimeRSSPage 失败：传入参数缺少或为空');
  }

  // 构造请求地址
  let finalUrl;
  try {
    finalUrl = new URL('/RSS/Bangumi', baseUrl);
  } catch (error) {
    logger.error({ baseUrl, err: error.message }, 'mikan.rss invalid-base');
    throw new Error(`请求 AnimeRSSPage 失败：baseUrl 格式非法`);
  }
  finalUrl.searchParams.set('bangumiId', mikanid);
  finalUrl.searchParams.set('subgroupid', subgroupRSSId);

  return await fetchWithTimeOut(finalUrl.href, 'AnimeRSSPage', retries);
}

// 解析函数入参校验：内容为空或非法时记录日志并返回 false
function validateParseInput(html, tip) {
  if (!html || typeof html !== 'string') {
    logger.warn({ tip }, 'mikan.parse invalid-input');
    return false;
  }
  return true;
}

function getSeasonList(MikanHomePage) {
  if (!validateParseInput(MikanHomePage, 'MikanHomePage')) return null;

  logger.debug('mikan.season-list start');
  const $ = cheerio.load(MikanHomePage);

  // 收集所有原始数据
  const items = $('[data-year][data-season]')
    .map((i, el) => ({
      year: $(el).data('year'),
      season: $(el).data('season')
    }))
    .get();

  // 去重
  const seen = new Set();
  const unique = items.filter(item => {
    const key = `${item.year}-${item.season}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 错误处理
  if (unique.length === 0) {
    logger.warn('mikan.season-list empty');
    return null;
  }

  // 然后再 reduce 分组
  const grouped = unique.reduce((acc, { year, season }) => {
    if (!acc[year]) acc[year] = [];
    acc[year].push(season);
    return acc;
  }, {});

  logger.debug({ years: Object.keys(grouped).length }, 'mikan.season-list ok');
  return grouped;
}

function getSeasonAnimeList(MikanSeasonPage) {
  if (!validateParseInput(MikanSeasonPage, 'MikanSeasonPage')) return null;

  logger.debug('mikan.season-anime start');
  const $ = cheerio.load(MikanSeasonPage);
  const seasonAnimeList = [];

  $('div[data-dayofweek]').each((i, div) => {
    // 放送日期（星期）
    const dayofweek = $(div).data('dayofweek');
    $(div).find('li').each((j, li) => {

      // 获取元素
      const $spanTag = $(li).find('span[data-src][data-bangumiid]');
      const $aTag = $(li).find('a[href][title]');

      if (!$aTag.length || !$spanTag.length) return;

      // 番剧名称
      const title = $aTag.attr('title');
      if (!title) return;

      // MikanId
      const href = $aTag.attr('href');
      const matchMikanId = href?.match(/\/Home\/Bangumi\/(\d+)/);
      const mikanId = $spanTag.data('bangumiid');

      // 没想好咋处理这玩意，不过我觉得应该不怎么会出现这个问题
      if (!matchMikanId || !mikanId || (matchMikanId[1] != mikanId)) {
        logger.warn({ title, href, mikanId }, 'mikan.season-anime skip mikan-id-mismatch');
        return;
      }

      // 番剧海报
      const coverSrc = $spanTag.data('src');
      const matchDParamCoverSrc = coverSrc?.match(/^[^?]+/);
      if (!matchDParamCoverSrc) {
        logger.warn({ title }, 'mikan.season-anime skip no-cover');
        return;
      }
      const deParamCoverSrc = matchDParamCoverSrc[0];

      seasonAnimeList.push({ title, dayofweek, mikanId, deParamCoverSrc });
    })
  })

  // 检查是否为空
  if (seasonAnimeList.length === 0) {
    logger.warn({ length: seasonAnimeList.length }, 'mikan.season-anime empty');
    return null;
  }

  logger.debug({ length: seasonAnimeList.length }, 'mikan.season-anime ok');
  return seasonAnimeList;
}

function getSubGroupList(AnimeDetailPage) {
  if (!validateParseInput(AnimeDetailPage, 'AnimeDetailPage')) return null;

  logger.debug('mikan.subgroup start');
  const $ = cheerio.load(AnimeDetailPage);
  const animeSubGroupList = [];

  $('div.subgroup-text[id]').each((i, el) => {

    // 字幕组名称
    const $aTag = $(el).find('a[href*=PublishGroup]');
    const subgroupName = $aTag.text().trim();

    // 字幕组RSSID
    const subgroupRSSId = $(el).attr('id');

    // 字幕组MikanId
    const href = $aTag.attr('href');
    const matchSubgroupMikanId = href?.match(/\/Home\/PublishGroup\/(\d+)/);
    if (!matchSubgroupMikanId) {
      logger.warn({ subgroupName, subgroupRSSId, href }, 'mikan.subgroup skip mikan-id');
      return;
    }

    // 字幕组名称为空时跳过
    if (!subgroupName) {
      logger.warn({ subgroupRSSId, href }, 'mikan.subgroup skip empty-name');
      return;
    }

    const subgroupMikanId = matchSubgroupMikanId[1];
    animeSubGroupList.push({ subgroupName, subgroupRSSId, subgroupMikanId });
  })

  // 检查是否为空
  if (animeSubGroupList.length === 0) {
    logger.warn({ length: animeSubGroupList.length }, 'mikan.subgroup empty');
    return null;
  }

  logger.debug({ length: animeSubGroupList.length }, 'mikan.subgroup ok');
  return animeSubGroupList;
}

function getAnimeBangumiId(AnimeDetailPage) {
  if (!validateParseInput(AnimeDetailPage, 'AnimeDetailPage')) return null;

  const $ = cheerio.load(AnimeDetailPage);
  const bangumiUrl = $('p.bangumi-info a[href*=subject]').attr('href');
  const matchBangumiId = bangumiUrl?.match(/\/(\d+)$/);
  if (!matchBangumiId) {
    logger.warn({ bangumiUrl }, 'mikan.bgm-id missing');
    return null;
  }
  const bangumiId = matchBangumiId[1];
  return { bangumiId };
}

function getAnimeReleaseFromRSS(AnimeRSSPage) {
  if (!validateParseInput(AnimeRSSPage, 'AnimeRSSPage')) return null;

  logger.debug('mikan.rss start');
  const $ = cheerio.load(AnimeRSSPage, { xml: true });
  const animeReleaseList = [];

  const nameMatch = $('title:first').text().match(/^Mikan Project\s*-\s*(.+)$/);
  if (!nameMatch) {
    logger.warn({ title: $('title:first').text() }, 'mikan.rss title-mismatch');
    return null;
  }
  const animeName = nameMatch[1].trim();
  const RSSLink = $('link:first').text();

  $('item').each((i, el) => {
    const torrentTitle = $(el).find('title').text();
    // 注意区分两个 link：
    //   · 顶层 <link>（children 才是它，find 会连 <torrent><link> 一起捞）→ 详情页地址，
    //     末段就是 info hash，拼磁力链接要用它
    //   · <torrent><link> → 种子文件地址；<enclosure url> → 同一个种子的下载地址（带 key）
    const torrentLink = $(el).find('torrent link').text();
    const torrentLength = $(el).find('torrent contentLength').text();
    const pageLink = $(el).children('link').first().text();
    const torrentUrl = $(el).find('enclosure').attr('url') || '';
    const pubDate = $(el).find('torrent pubDate').text() || $(el).find('pubDate').text();

    // 种子标题或链接为空时跳过
    if (!torrentTitle || !torrentLink) {
      logger.warn({ torrentTitle, torrentLink }, 'mikan.rss skip empty-torrent');
      return;
    }

    animeReleaseList.push({
      animeName,
      RSSLink,
      torrentTitle,
      torrentLink,
      torrentLength,
      pageLink,
      torrentUrl,
      pubDate,
    })
  })

  // 检查是否为空
  if (animeReleaseList.length === 0) {
    logger.warn({ animeName, length: animeReleaseList.length }, 'mikan.rss empty');
    return null;
  }

  logger.debug({ animeName, length: animeReleaseList.length }, 'mikan.rss ok');
  return animeReleaseList;
}

export {
  getMikanHomePage,
  getMikanSeasonPage,
  getAnimeDetailPage,
  getAnimeRSSPage,
  getSeasonList,
  getSeasonAnimeList,
  getSubGroupList,
  getAnimeBangumiId,
  getAnimeReleaseFromRSS,
};
