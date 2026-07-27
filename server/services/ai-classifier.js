const { LRUCache } = require('lru-cache');
const config = require('../config');

// 标题分类结果缓存，同标题 24 小时内不重复请求
const cache = new LRUCache({ max: 2000, ttl: 1000 * 60 * 60 * 24 });

/** 获取 DeepSeek 配置：优先参数覆盖，其次 config */
function getDeepseekConfig(opts) {
  return {
    baseUrl: opts?.baseUrl || config.get('deepseek.baseUrl') || 'https://api.deepseek.com/v1',
    model: opts?.model || config.get('deepseek.model') || 'deepseek-chat',
    apiKey: opts?.apiKey || config.get('deepseek.apiKey') || '',
  };
}

/**
 * 批量 AI 分类标题
 * @param {string[]} titles - 待分类的标题数组
 * @param {string} [apiKeyOverride] - API Key（可选，优先使用；不传则从 config 读取）
 * @param {object} [opts]
 * @returns {Promise<object[]>} 分类结果数组
 */
async function classifyBatch(titles, apiKeyOverride, opts = {}) {
  const { model, baseUrl, apiKey } = getDeepseekConfig({ apiKey: apiKeyOverride, ...opts });
  if (!apiKey) throw new Error('API Key 未配置，请在设置页填写 DeepSeek API Key');
  if (!titles || titles.length === 0) return [];

  // 1. 先查缓存，分出未命中的
  const uncached = [];
  const results = new Array(titles.length);

  for (let i = 0; i < titles.length; i++) {
    const cached = cache.get(titles[i]);
    if (cached) {
      results[i] = cached;
    } else {
      uncached.push({ index: i, title: titles[i] });
    }
  }

  if (uncached.length === 0) return results;

  // 2. 分批调用 AI（每批最多 20 条）
  const BATCH_SIZE = 20;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    const classified = await callAI(batch.map(b => b.title), apiKey, model, baseUrl);

    for (let j = 0; j < batch.length; j++) {
      const { index, title } = batch[j];
      const result = classified[j] || fallbackClassify(title);
      cache.set(title, result);
      results[index] = result;
    }
  }

  return results;
}

// ── 调用 DeepSeek API ──

async function callAI(titles, apiKey, model, baseUrl) {
  const systemPrompt = `你是动漫字幕组标题解析专家。根据给定的动漫资源标题，提取结构化信息。

返回一个 JSON 数组，每个元素对应一个标题的解析结果，包含以下字段（无法确定的字段用 null）：

{
  "group": "字幕组/压制组名称，如 ANi、LoliHouse、VCB-Studio。不要和发布组混淆",
  "animeName": "番剧名称（去掉集数、字幕组、编码等关键字后的纯番名）",
  "episode": 数字集数或 null,
  "resolution": "分辨率，如 1080p、720p、4K 或 null",
  "codec": ["编码", ...] 如 ["HEVC","10bit"] 或 null,
  "source": ["来源", ...] 如 ["Baha","WEB-DL"] 或 null,
  "subLang": ["字幕语言", ...] 如 ["简中","繁中","日语"] 或 null,
  "subType": "字幕类型：内嵌、内封、外挂 或 null",
  "audioLang": ["音轨语言", ...] 如 ["日语","粤语","中配"] 或 null,
  "releaseGroup": "发布组名称，如 VCB-Studio、ReinForce、Snow-Raws 或 null",
  "quality": "画质来源：BDrip、WebRip、WEB-DL、BDMV、TVrip 或 null",
  "season": 季度数字或 null,
  "isComplete": true/false/null，是否全集/完结包
}

规则：
- episode 只返回纯数字，如果标题无集数填 null。"第01话"→1，"OVA"→null，"1-12"→null
- group 是方括号 [xxx] 里的第一个名字，如果无法区分字幕组和发布组，填 null
- codec：用数组，包含 HEVC/AVC/AV1 + 10bit 等
- 字幕语言可能有多个，用数组
- 只返回 JSON 数组，不要 Markdown 代码块`;

  const userPrompt = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`AI API 错误 ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '[]';

  // 清理可能的 Markdown 代码块标记
  const jsonStr = content
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn('AI 返回非 JSON，使用正则兜底:', jsonStr.slice(0, 200));
    return titles.map(fallbackClassify);
  }
}

// ── 正则兜底（AI 失败或返回异常时使用） ──

function fallbackClassify(title) {
  const group = title.match(/^\[([^\]]+)\]/);
  return {
    group: group ? group[1].trim() : null,
    animeName: null,
    episode: null,
    resolution: null,
    codec: null,
    source: null,
    subLang: null,
    subType: null,
    audioLang: null,
    releaseGroup: null,
    quality: null,
    season: null,
    isComplete: null,
  };
}

// ── 单个标题分类（内部走批量） ──

async function classify(title, apiKeyOverride, opts) {
  const results = await classifyBatch([title], apiKeyOverride, opts);
  return results[0];
}

module.exports = { classifyBatch, classify };