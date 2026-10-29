# TODO（按优先级）

> 背景与决策见 **`docs/ARCHITECTURE.md`**（§10 是路线图）。这里只放**还没做**的、可执行的事项 —— 做完就删掉本条目。

---

## P0 · 数据完整性

### P0-1 老番字幕组补齐（当前唯一"数据看着齐、实际空着"的地方）

**现状**：档案补齐（触发 ①b）对「已经有 `bgm_id`」的行**跳过 Mikan 详情页**（为了省一次请求/条），
所以扫描进来的老番**从来没抓过字幕组** —— 面板「资源」区对这些作品是空的。

**影响**：老番无法通过面板取资源（下载闭环做不了）。

**方案（二选一，选定后写进 ARCHITECTURE §4）**
- **A. 给 ①b 加开关**：`worker.fetchSubgroups`（默认开）→ 补档案时顺带 `rememberSubgroups(profile.subgroups)`。
  代价：每条多一次 Mikan 请求（当前 ~860 条待补，约多 15 分钟）。
- **B. 单开一条「只补字幕组」的队列**：与 ①b 解耦，谓词自己定（比如按 `bgm_checked_at` 退避）。

**验收**
- `verify-worker.mjs` 加断言：补齐跑过之后 `countSubgroupDict()` 会增长
- 手动：拿一部老番（如 mikan 1433 黑叶草）点开面板，「字幕组」区不再是空态

### P0-2 确认档案补齐跑完
`needArchive` 归零后：`curl /api/health` 看 `withScore` 占比，并抽查 3 部老番的评分/标签/简介。

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
