const { LRUCache } = require('lru-cache');
const config = require('../config');

const tagCache = new LRUCache({ max: 5000, ttl: 1000 * 60 * 30 });
const downloadCache = new LRUCache({ max: 2000, ttl: 1000 * 60 * 60 * 24 });

const AI_TIMEOUT = 60000;
const BATCH_SIZE = 5;
const MAX_TOKENS_TAGS = 2048;
const MAX_TOKENS_DOWNLOAD = 4096;

function getDeepseekConfig(opts) {
  return {
    baseUrl: opts?.baseUrl || config.get('deepseek.baseUrl') || 'https://api.deepseek.com/v1',
    model: opts?.model || config.get('deepseek.model') || 'deepseek-chat',
    apiKey: opts?.apiKey || config.get('deepseek.apiKey') || '',
  };
}

async function callDeepseek(messages, apiKey, model, baseUrl, maxTokens = 2048) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), AI_TIMEOUT);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: maxTokens, thinking: { type: 'disabled' } }),
        signal: ac.signal,
      });
      clearTimeout(to);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`AI API 错误 ${res.status}: ${errText}`);
      }

      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (e) {
      clearTimeout(to);
      if (attempt === 0 && (e.name === 'AbortError' || e.name === 'TypeError')) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw e;
    }
  }
  throw new Error('AI API 请求失败');
}

function parseJsonResponse(content, fallback) {
  const jsonStr = content
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    const lastBrace = jsonStr.lastIndexOf('}');
    if (lastBrace > 0) {
      const suffix = jsonStr[lastBrace + 1] === ']' ? '' : ']';
      try { return JSON.parse(jsonStr.slice(0, lastBrace + 1) + suffix); } catch {}
    }
    console.warn('AI 返回非 JSON，原始内容:');
    console.warn(content);
    return fallback;
  }
}

/**
 * 分批并行调 AI，合并结果
 */
async function batchCallAI(items, callFn, concurrency = 8) {
  if (items.length === 0) return [];
  const batches = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }
  const results = [];
  for (let i = 0; i < batches.length; i += concurrency) {
    const chunk = batches.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map(b => callFn(b)));
    results.push(...chunkResults);
  }
  return results;
}

// ────────────────────────────────────────
// AI 1：标签类型分类
// ────────────────────────────────────────

async function classifyTags(fileNames, apiKeyOverride, opts = {}) {
  const { model, baseUrl, apiKey } = getDeepseekConfig({ apiKey: apiKeyOverride, ...opts });
  if (!apiKey) throw new Error('API Key 未配置');
  if (!fileNames || fileNames.length === 0) return {};

  const systemPrompt = `你是动漫资源标签提取与分类专家。分析文件名列表，生成筛选标签。

返回纯 JSON：
{
  "tags": [
    { "display": "用户看的名", "match": ["文件名里实际出现的写法1", "写法2"], "type": "类型" }
  ]
}

类型定义 - type：
- res: 分辨率
- codec: 编码
- sub: 字幕
- source: 来源
- other: 其他有价值
- null: 无意义（不返回）

**规则**：
- display: 归一化后的人类友好名（如 1080p、720p、HEVC）
- match: 从输入文件名中**精确摘抄**该标签实际出现的所有写法，用于前端字符串匹配
- 同类标签去重合并
- **不要**返回合集/单集类标签（前台另有逻辑判断）
- 忽略：容器格式（MP4/MKV）、音频编码（AAC/FLAC）、字幕组名/番剧名

只返回 JSON，不要 Markdown。`;

  const results = {};
  const cacheKey = `tags_v3|${fileNames.length}`;
  const cached = tagCache.get(cacheKey);
  if (cached) return cached;

  const sample = fileNames.slice(0, 30);
  const userPrompt = `分析文件名列表，生成标签。display 归一化，match 从原文件摘抄实际写法：

${sample.map((f, i) => `${i + 1}. ${f}`).join('\n')}

返回 { "tags": [...] } 格式。`;

  const content = await callDeepseek([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], apiKey, model, baseUrl, MAX_TOKENS_TAGS);

  const parsed = parseJsonResponse(content, {});
  if (parsed && Array.isArray(parsed.tags)) {
    for (const t of parsed.tags) {
      const type = t.type === 'null' ? null : t.type;
      const display = t.display;
      if (!display || !type) continue;
      results[display] = { type, match: t.match || [display] };
      tagCache.set(display, { type, match: t.match || [display] });
    }
  }

  tagCache.set(cacheKey, results);
  return results;
}

// ────────────────────────────────────────
// AI 2：下载元数据
// ────────────────────────────────────────

async function classifyDownload(cardTitle, fileNames, apiKeyOverride, opts = {}) {
  const { model, baseUrl, apiKey } = getDeepseekConfig({ apiKey: apiKeyOverride, ...opts });
  if (!apiKey) throw new Error('API Key 未配置');
  if (!cardTitle || !fileNames || fileNames.length === 0) {
    return { rawName: cardTitle || '未命名', season: 1, episodes: {} };
  }

  const cacheKey = `${cardTitle}|${fileNames.length}`;
  const cached = downloadCache.get(cacheKey);
  if (cached) return cached;

  const systemPrompt = `你是动漫标题解析专家。提取下载所需的结构化信息。

返回纯 JSON：
{
  "rawName": "纯番名（去掉季数标识如'第三季'/'S3'/'Season 3'后的名称）",
  "season": 数字季度,
  "episodes": { "文件名": 集数数字 | null }
}

规则：
- 你只能返回数字或者 null 或者 xx-xx
- rawName 以卡片大标题为准，去掉季节标识
- season: 从卡片标题或文件名中提取。"第X季"→X, "S3"→3, 无季节→1
- 如果连续编号超过12且卡片无季节标识，根据集数推算 season
- episode: 从文件名提取集数。"第04集"→4, "OVA"→null, "1-12"→"1-12"（合集保留范围字符串）
- 只返回 JSON，不要 Markdown`;

  let season = 1;
  let rawName = cardTitle || '未命名';
  let allEpisodes = {};

  // 全部批次并行调用
  const batches = [];
  for (let i = 0; i < fileNames.length; i += BATCH_SIZE) {
    batches.push(fileNames.slice(i, i + BATCH_SIZE));
  }

  const processBatch = async (batch, isFirst) => {
    const up = `卡片大标题：${cardTitle}\n\n文件名：\n${batch.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
    const c = await callDeepseek([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: up },
    ], apiKey, model, baseUrl, MAX_TOKENS_DOWNLOAD);
    const p = parseJsonResponse(c, {});
    return { parsed: p, isFirst };
  };

  // 并行所有批次
  const batchResults = await Promise.all(
    batches.map((b, idx) => processBatch(b, idx === 0))
  );

  for (const { parsed, isFirst } of batchResults) {
    if (isFirst && parsed) {
      if (parsed.season) season = parsed.season;
      if (parsed.rawName) rawName = parsed.rawName;
    }
    if (parsed && parsed.episodes) {
      Object.assign(allEpisodes, parsed.episodes);
    }
  }

  const result = { rawName, season, episodes: allEpisodes };
  downloadCache.set(cacheKey, result);
  return result;
}

module.exports = { classifyTags, classifyDownload };