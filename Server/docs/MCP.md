# MCP 服务

把整个动画库和下载控制交给 agent（Claude Code / Cursor / Claude Desktop / Hermes 都能接）。
实现在 `src/mcp/`，一个 JSON-RPC 2.0 over HTTP 的路由，**跟着主进程跑，不额外起服务**。

```
POST http://<你的地址>:3100/mcp
Authorization: Bearer sk-hub-xxxxx        # 也接受 ?token=sk-hub-xxxxx
Content-Type: application/json
```

---

## 为什么放在同一个进程里

数据在同一份 SQLite 里：全站动画档案（3 万部）+ 季度排期 + 系列链 + 下载任务。
独立服务要么再连一次库、要么走 HTTP 绕一圈，都得把查询/缓存重写一遍。
一个进程的代价是「MCP 挂了服务也挂了」—— 所以所有工具的错误都被收成
`isError: true` 的 content 返回，**任何工具抛错都不会影响服务**。

## 两个开关，不是一个

| 设置项 | 默认 | 作用 |
|---|---|---|
| 启用 MCP 服务 | 关 | 对外开不开这个口子。关着时 `/mcp` 一律 404 |
| 允许写入 | 关 | 加种 / 暂停 / 继续 / 删除 / 改名。开着才放行写工具 |

只读（搜索、推荐、看进度）对 agent 是安全的；**让模型删你下到一半的任务不是功能，是风险**。
写入被拦时工具返回的是可读的中文原因（模型会转告用户去哪打开），而不是协议错误。

令牌在「启用」时自动生成（`sk-hub-…`），设置页的 MCP 卡片里显示、复制、重新生成。
令牌等于密码：拿到的人可以读写你的库。

## 工具清单（19 个）

### 只读（11）

| 工具 | 说明 |
|---|---|
| `search_anime` | 全站搜索：关键词 / 年份 / 季度 / 标签交集 / 评分 / 话数 / 平台 / 是否已在库 |
| `get_anime` | 完整档案：评分与各档人数、排名、标签（含出现次数）、简介、别名、staff、排期与海报 |
| `recommend_anime` | 按标签推荐（命中标签数优先，同分看评分），可排除已看/已在库 |
| `list_tags` | 标签榜（按部数倒序），用来知道能按哪些标签筛 |
| `catalog_stats` | 库概况：部数、有评分数、标签数、staff/简介覆盖率、最早最新放送日 |
| `list_season` | 本库某季排期（带星期几），只读库不刷新上游 |
| `get_series` | 系列链 + 季位（「这个系列看片顺序」） |
| `list_subgroups` | 某作品的字幕组（**实时问 Mikan**），返回该作品下的 rss id |
| `list_releases` | 某字幕组的资源列表（集数 / 画质 / 是否已下载，**实时问 Mikan**） |
| `list_downloads` | qB 任务（进度/速度/状态/路径）+ 迅雷/百度连通性 |
| `list_library_downloads` | 按作品看下到哪了（几集 / 体积 / 状态 / 认不出的任务） |

### 写入（8，需要「允许写入」）

| 工具 | 说明 |
|---|---|
| `add_download` | 加种：传 `items`（`list_releases` 的结果直接给）或直接给 magnet |
| `pause_download` / `resume_download` | 批量暂停 / 继续（传 hash 数组） |
| `delete_download` | 删任务。**默认只移除任务、保留文件**；连文件删要显式 `deleteFiles=true` |
| `rename_download` | 按命名规则重命名。**默认 dry-run**，`apply=true` 才真改 |
| `xunlei_add` / `xunlei_delete` | 迅雷加任务 / 删任务（迅雷没有改名接口） |
| `baidu_offline_add` | 把磁力/直链丢给百度网盘离线下载 |

三条不可协商的实现原则：

1. **删除默认不动文件** —— 删文件不可逆，不能由"顺手"决定。
2. **改名先 dry-run** —— 返回计划，确认后再 `apply`。
3. **批量操作回报逐条结果** —— 10 个里 1 个失败不会被总结成"完成"。

## 客户端配置

设置页 MCP 卡片里直接给出可复制的三份（URL 与令牌都跟着当前部署）。

Claude Code：

```bash
claude mcp add --transport http soraikas-hub "http://192.168.5.2:3100/mcp" \
  --header "Authorization: Bearer sk-hub-xxxx"
```

Cursor / Claude Desktop（`mcp.json` / `claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "soraikas-hub": {
      "type": "http",
      "url": "http://192.168.5.2:3100/mcp",
      "headers": { "Authorization": "Bearer sk-hub-xxxx" }
    }
  }
}
```

Hermes Agent（`config.yaml`）：

```yaml
mcp_servers:
  soraikas-hub:
    transport: http
    url: "http://192.168.5.2:3100/mcp"
    headers:
      Authorization: "Bearer sk-hub-xxxx"
```

不支持自定义 header 的客户端：把 `?token=` 拼在 URL 后面即可。

## 协议细节

- 支持协议版本 `2025-06-18` / `2025-03-26` / `2024-11-05`，`initialize` **回声**客户端报的版本（不认识就回最新的）。
- 只实现 **tools**（不实现 resources / prompts）：本地资料库的需求都是"问一句 / 做一件"。
- 一次请求一条 JSON-RPC 消息，**不支持 batch**（发 batch 回 `-32600`）。
- 通知（`notifications/*`）返回 202 空 body。
- 工具错误不走 JSON-RPC error，而是 `isError: true` —— 协议那层错误留给"协议本身坏了"。
- 鉴权在方法分发之前：未带令牌的 `initialize` 也是 401（否则能列举你的工具清单）。

## 数据从哪来

`bgm_subject` 现在是**全站动画档案**（dump 里 `type=2` 全部落库，实测 31297 行 / 库约 105MB）：

| 字段 | 内容 |
|---|---|
| 评分 / 各档人数 / 排名 | `score` / `score_details` / `bgm_rank` |
| 标签 | `tags`（展示用 8 个）+ `tags_all`（全量 30 个）；倒排在 `bgm_tag` 表 |
| staff | `staff`（从 infobox 抽：导演 / 动画制作 / 系列构成 / 音乐 …） |
| 别名 | `aliases`（中日英罗马字混着） |
| 话数 | `total_episodes`（章节表数出来的；计划话数兜底） |

所以「2020 年以后评分 8 以上的机战番」这类问题是**一次本地 SQL**，
一条上游请求都不发。只有字幕组/资源列表要上网（那是 Mikan 的实时数据，没有离线源）。

维护入口：设置 → 离线数据 → 更新离线包（手动或每周自动），跑完档案表即全量刷新。
`--only-missing` 模式下整行**只填空**，不会覆盖已有值。

## 自检

设置页 MCP 卡片的「自检」按钮 = 后端假装客户端，按真实协议打一次
`initialize → tools/list`（走 127.0.0.1 回环，绕开反代与域名问题）。
失败时带**卡在哪一步**的中文原因：`enabled` / `token` / `auth` / `initialize` / `tools/list` / `connect`。

命令行等价物：

```bash
curl -s http://127.0.0.1:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-hub-xxxx" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 验收

`npm run verify` 里的 `scripts/verify-mcp.mjs`（49 条断言，独立库 + 独立端口 + 假 qB）：

- 未启用 → 404；启用即自动生成令牌；无/错令牌 → 401；`?token=` 可用
- initialize 回声版本 / 未知版本回落 / 通知 202 / 未知方法 `-32601` / batch `-32600` / 坏 JSON 400
- tools/list 与设置页一致，每个工具都有 name/title/inputSchema
- 只读工具真能查到（搜索排序、详情 staff、排期星期、标签、推荐、系列）
- `allowWrite=false` 时写工具被拦且**一次上游都没打**；打开后打到假 qB
- 删除默认 `deleteFiles=false`；空 hash 报错；关掉开关立刻又拦
- 自检接口通、令牌轮换后旧令牌立刻失效
