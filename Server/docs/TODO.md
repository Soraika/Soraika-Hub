# TODO（按优先级）

> 背景与决策见 **`docs/ARCHITECTURE.md`**（§10 是路线图）。这里只放**还没做**的、可执行的事项 —— 做完就删掉本条目。

---

## P0 · 数据完整性

### P0-1 确认档案补齐跑完
`needArchive` 归零后：`curl /api/health` 看 `withScore` 占比，并抽查 3 部老番的评分/标签/简介；
顺便确认 `coverage.subgroupDict` 在涨（= 「顺手抓字幕组」在工作）。

---

## P1 · AI v9（一次调用三类产物）

- [ ] **合并调用**：标签 + 集数 + **格式特征** 一次拿齐（现在是 2~3 次独立调用）
- [ ] **缓存 key 加 prompt 内容 hash + model**（换模型/改提示词不再命中旧结果 —— CONVENTIONS §9）
- [ ] 修四处"对不上"：
  - [ ] `season` 没往下传（`classifyReleaseTags` 的上下文里缺季）
  - [ ] `AI_TOOLS` 的 `inputSchema` 缺 `animeTitle` / `season`
  - [ ] `TYPE_ORDER` 里是 `revision`，但 prompt/标签写的是 `version`（对不上会落到 `other`）
  - [ ] `VALID_TYPES` 漏音频类标签

---

## P2 · 下载闭环

- [ ] `qb` 接入：选中资源 → 加种 → 进度 → 归档目录（`{根名}/S01/…`，规则见 CONVENTIONS §10.5）
- [ ] 下载页：按季 / 按系列列「已下 / 缺哪集」

---

## P3 · 体验

- [ ] 搜索页（复用 `useAnimeDetail` 打开面板）
- [ ] 接 `vue-router` 替换现在「侧栏 key → 页面组件」的临时映射

---

## P4 · 设置页二级页面：事件 × AI 提供商 的画板（**先不做**，已排期）

> 目标：把业务抽象出来，做成「画布 + 连线」的形状 —— 左侧是**事件**（解析资源标签、解析集数、
> 系列归一、生成合集名…），右侧是**AI 提供商/模型**，连线表示「这个事件用哪家的哪个模型」。
> 设置页只保留入口（「高级配置 → 编排」），真正的画板放在二级页面。

前置条件（这些已经在这次改造里铺好了）：
- 供应商目录可枚举（`GET /api/ai/providers`，models.dev，带模型名）
- 每个 AI 能力有独立的入口与缓存 key（`classifyReleaseTags` / `classifyEpisodes` /
  `classifyGroupTags` / `classifyReleaseFormat` / `classifySeries`）
- 配置支持整份导出/导入（画板内容可以直接落到 `ai.bindings` 这样的一个配置项里）

落地顺序建议：
1. 配置层：`ai.bindings = { [事件]: { baseUrl, apiKey?, model, maxTokens? } }`（缺省回落 `ai.*`）
2. 调用层：`chatJson` 取 provider 时先查 `bindings[事件]`，没有再用全局
3. UI：二级页面画布（节点 = 事件/供应商，连线 = 绑定）；先做「列表 + 下拉」的过渡版
4. 验收：`verify-ai` 增加「同一事件按绑定选不同模型」的断言

