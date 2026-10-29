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
