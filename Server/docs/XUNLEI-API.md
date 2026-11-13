# 迅雷（飞牛 fnOS 版）下载接口 —— 抓包实测规格

> 抓包方式：Edge 调试端口 + 裸 CDP（`Network.enable`），在迅雷界面点开任务列表/详情。
> 采集脚本见 `scripts/`（一次性工具，不在仓库里留）。

## 0. 结论先说

| 问题 | 答案 |
|---|---|
| 它是什么 | **飞牛 fnOS 的应用**，不是独立服务、没有独立端口 |
| 接口真实前缀 | `{fnOS基址}/cgi/ThirdParty/xunlei/index.cgi/` |
| 为什么 `5666/tasks` 打不通 | 那是 fnOS 网关的 SPA fallback，任何未知路径都返回首页 HTML |
| 鉴权 | 查询参数 `pan_auth`（JWT，3 天过期）**+** fnOS 登录 cookie（`fnos-token`）|
| 只给 pan_auth | `invalid token` |
| 只给 cookie | 网关 `502 Bad Gateway` |
| 有改名接口吗 | **没有**。任务名、文件名都改不了（见 §5） |

## 1. 鉴权

两个凭据必须同时给：

```
GET {base}/drive/v1/tasks?space=...&pan_auth={JWT}
Cookie: fnos-token=...; xtoken=...
```

- `pan_auth` 是 JWT，解出来只有 `{"key":"UIAuth","exp":...,"iat":...,"nbf":...}`，有效期 **3 天**。
  过期就回纯文本 `invalid token`。
- `fnos-token` 是 fnOS 桌面登录态（44 字符），从浏览器 cookie 里拿。
- `User-Agent` / `Referer` / `pan-auth` **请求头**都不是必需的（都试过，可以不带）。

刷新方法（目前没有自动续期接口）：浏览器打开迅雷界面 → F12 → Network → 随便一条 `/drive/v1/tasks` → 复制它的 `pan_auth` 和 Cookie。

## 2. 设备空间（space）

任务都挂在一个 `space` 下，形如：

```
device_id#7b39941bc1a9a2942d94c7aa8228c07c
```

取法（`type=user#runner` 那条任务就是设备本身，`params.device_config` 里有下载目录）：

```
GET /drive/v1/tasks?type=user%23runner&device_space=&pan_auth=...
```

## 3. 读接口

### 任务列表

```
GET {base}/drive/v1/tasks?space={space}&filters={"phase":{"in":"PHASE_TYPE_RUNNING,PHASE_TYPE_DONE"}}&limit=100&pan_auth={JWT}
```

`filters` 是 **URL 编码后的 JSON**；`phase` 可用值：
`PHASE_TYPE_PENDING / RUNNING / PAUSED / ERROR / DONE / WAITING`。

**空列表的特殊应答**（别当错误）：

```json
{"HttpStatus":0,"expires_in":3}
```

这是长轮询的空回，`expires_in` = 3 秒后再来。

任务条目（实测字段）：

```json
{
  "kind": "drive#task",
  "id": "VP6KYuMz2VrO_nBu24VjqhafA1",          // 任务 id
  "name": "[Sakurato] ... [24][AVC-8bit 1080p@60FPS AAC][CHS].mp4",  // 任务名
  "type": "user#download-url",
  "file_name": "…同名…",                        // 落盘文件名
  "file_size": "1069060010",                   // 字符串！
  "phase": "PHASE_TYPE_ERROR",
  "message": "失败",
  "created_time": "2026-11-13T23:38:43.583+08:00",
  "updated_time": "…",
  "icon_link": "https://…",
  "space": "device_id#7b399…",
  "params": {
    "real_path": "/var/apps/xunlei/shares/downloads/…[CHS].mp4",  // ★ 真实落盘路径
    "parent_folder_path": "/var/apps/xunlei/shares/downloads/",
    "url": "magnet:?xt=urn:btih:…",
    "total_file_count": "1",
    "sub_file_index": "--1,",
    "status": "{\"phase\":\"error\"}",          // 状态是 JSON 字符串
    "spec": "{\"phase\":\"running\"}",
    "error": "开始任务(9000)",
    "platform": "fnos_community",
    "package_name": "pan.xunlei.cli.fnos_community",
    "target": "device_id#…"
  }
}
```

### 容量

```
GET /drive/v1/about?with_quotas=CREATE_USER_DOWNLOAD_TASK_LIMIT_INTERNAL&pan_auth=…
→ {"kind":"drive#about","quota":{"limit":3298534883328,"usage":1572727919678}}
```

### 设备信息 / 下载目录（要 POST）

```
POST /device/info/watch?space={space}&device_space=&pan_auth=…
→ {"downloads":[{"name":"/应用文件/xunlei/downloads","path":"/var/apps/xunlei/shares/downloads/",
                 "usage":248300253184,"limit":499969425408,"is_root_path":false}, …],
   "user":{"name":"15******405","vip":{"is_vip":true,"level":5}}, "runner_status":{…}}
```

### 目录列举

```
GET /drive/v1/files?space={space}&parent_id=&limit=20&pan_auth=…
→ {"kind":"drive#fileList","files":[],"next_page_token":""}
```

### 流量

```
GET /flow/v1/about?scene=DownloadUrl&pan_auth=…   → 限额与统计
```

## 4. 写接口

### 加下载任务（**实测有完整请求体**）

```
POST /drive/v1/task?pan_auth=…
Content-Type: application/json

{
  "type": "user#download-url",
  "name":       "[2549][无职转生…][2][24][203][桜都字幕组]",   // 任务名
  "file_name":  "[Sakurato] … [24][…].mp4",                    // 落盘文件名
  "file_size":  "1069060010",
  "space": "device_id#7b399…",
  "params": {
    "target": "device_id#7b399…",
    "url": "magnet:?xt=urn:btih:…",
    "total_file_count": "1",
    "parent_folder_path": "/var/apps/xunlei/shares/downloads/",  // 落盘目录（真实路径）
    "sub_file_index": "--1,"
  }
}
→ 200 {"HttpStatus":0,"task":{…}}
```

`name` 与 `file_name` 可以不同 —— 这是**唯一能"预先定名"的机会**：
`.torrent` 解析出的文件名直接作为 `file_name` 传进去，落地即正确，事后不用改（反正也改不了）。

### 删除任务

```
POST /method/delete/drive/v1/tasks?space={space}&task_ids={id}&pan_auth=…
```

## 5. 没有的能力（都用「路由是否存在」探过）

探测方法：给不存在的 `task_id` 打一下 ——
· 路由存在但对象不存在 → `200 Not Found`
· 路由根本不存在 → `200 stat /var/apps/xunlei/target/ui/index.cgi: no such file or directory`（静态兜底）

| 想做的事 | 结果 |
|---|---|
| `/method/rename/drive/v1/tasks` | 无此路由 |
| `/method/update/drive/v1/tasks` | 无此路由 |
| `/method/pause|resume|start|stop|retry|move|priority` | 全部无此路由 |
| `/method/rename|move/drive/v1/files` | `404 page not found`（无此路由）|
| `PATCH /drive/v1/files` | 无此路由 |

**结论：迅雷 fnOS 版只开放了「加任务 / 读任务 / 删任务」。**
所以本项目的分工是：**迅雷负责下载，改名交给 qB（或直接改 NAS 上的文件）**。

## 6. 与本项目的关系

- 适配器：`src/api/sources/xunlei.js`（读任务 / 容量 / 设备 / 加任务 / 删任务）
- 设置项：`xunlei.base` / `xunlei.cookie` / `xunlei.panAuth` / `xunlei.space` / `xunlei.downloadDir`
- 路由：`GET /api/xunlei/status`、`GET /api/xunlei/tasks`
- **目录是两棵不同的树**：迅雷 `/var/apps/xunlei/shares/downloads/`（对外显示 `/应用文件/xunlei/downloads`）
  vs qB `/downloads/anime/{番名}/Season 01`。两边不能互认，别拿迅雷的 `real_path` 去套 qB 的归档规则。
