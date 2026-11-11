import { logger } from '../lib/logger.js';

// ─────────────────────────────────────────────
// 网络层
// ─────────────────────────────────────────────

/**
 * 发送 GET 请求（带超时、重试）
 *
 * @param {string} baseUrl
 * @param {string} apiUrl
 * @param {Object} [params={}]
 * @param {string} apiKey
 * @param {string} tip   - 日志标识
 * @param {number} [retries=2]
 * @returns {Promise<string>} 响应原文
 */
async function fetchQbGet(baseUrl, apiUrl, params = {}, apiKey, tip, retries = 2) {
    const startedAt = Date.now();
    if (!(baseUrl && apiUrl && apiKey)) {
        logger.error({ tip, baseUrl, apiUrl }, 'qb.fetch invalid empty-params');
        throw new Error(`请求 ${tip} 失败：传入参数缺少或为空`);
    }

    let finalUrl;
    try {
        finalUrl = new URL(apiUrl, baseUrl);
    } catch (error) {
        logger.error({ tip, baseUrl, apiUrl, err: error.message }, 'qb.fetch invalid bad-url');
        throw new Error(`请求 ${tip} 失败：baseUrl 或 apiUrl 格式非法`);
    }

    for (const [key, value] of Object.entries(params)) {
        finalUrl.searchParams.set(key, value);
    }

    try {
        logger.debug({ tip, method: 'GET', url: finalUrl.href }, 'qb.fetch start');
        const response = await fetch(finalUrl.href, {
            headers: {
                "Authorization": `Bearer ${apiKey}`
            },
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
            // 把响应体一起带出来：qB 失败时会说明原因（重复种子是 409），
            // 只留 `HTTP 409` 的话排错时什么都看不出来（也避免把对象拼成 [object Object]）。
            const body = await response.text().catch(() => '')
            logger.warn({ tip, method: 'GET', url: finalUrl.href, status: response.status }, 'qb.fetch fail')
            const err = new Error(`HTTP ${response.status}${body ? ` ${body.slice(0, 120)}` : ''}`)
            err.status = response.status
            err.bodyText = body
            throw err
        }

        const text = await response.text();

        logger.debug(
            { tip, method: 'GET', url: finalUrl.href, status: response.status, ms: Date.now() - startedAt },
            'qb.fetch ok',
        );
        return text;
    } catch (error) {
        // 4xx 是「请求本身有问题」（409 = 种子已存在），重试毫无意义、还会白等 10 秒；
        // 只有 5xx / 网络错误才重试。
        const retriable = !error.status || error.status >= 500;
        if (retries > 0 && retriable) {
            logger.warn(
                { tip, method: 'GET', url: finalUrl.href, retriesLeft: retries - 1, err: error.message },
                'qb.fetch retry',
            );
            await new Promise(resolve => setTimeout(resolve, 5000));
            return fetchQbGet(baseUrl, apiUrl, params, apiKey, tip, retries - 1);
        }
        logger.error(
            { tip, method: 'GET', url: finalUrl.href, err: error.message, ms: Date.now() - startedAt },
            'qb.fetch abort',
        );
        const wrapped = new Error(`获取 ${tip} 失败：${error.message}`);
        wrapped.status = error.status;
        wrapped.bodyText = error.bodyText;
        throw wrapped;
    }
}

/**
 * 发送 POST 请求（application/x-www-form-urlencoded，带超时、重试）
 *
 * @param {string} baseUrl
 * @param {string} apiUrl
 * @param {Object} [params={}]
 * @param {string} apiKey
 * @param {string} tip   - 日志标识
 * @param {number} [retries=2]
 * @returns {Promise<string>} 响应原文
 */
async function fetchQbPost(baseUrl, apiUrl, params = {}, apiKey, tip, retries = 2) {
    const startedAt = Date.now();
    if (!(baseUrl && apiUrl && apiKey)) {
        logger.error({ tip, baseUrl, apiUrl }, 'qb.fetch invalid empty-params');
        throw new Error(`请求 ${tip} 失败：传入参数缺少或为空`);
    }

    let finalUrl;
    try {
        finalUrl = new URL(apiUrl, baseUrl);
    } catch (error) {
        logger.error({ tip, baseUrl, apiUrl, err: error.message }, 'qb.fetch invalid bad-url');
        throw new Error(`请求 ${tip} 失败：baseUrl 或 apiUrl 格式非法`);
    }

    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        form.append(key, value);
    }

    try {
        logger.debug({ tip, method: 'POST', url: finalUrl.href }, 'qb.fetch start');
        const response = await fetch(finalUrl.href, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: form.toString(),
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '')
            logger.warn({ tip, method: 'POST', url: finalUrl.href, status: response.status }, 'qb.fetch fail')
            const err = new Error(`HTTP ${response.status}${body ? ` ${body.slice(0, 120)}` : ''}`)
            err.status = response.status
            err.bodyText = body
            throw err
        }

        const text = await response.text();

        logger.debug(
            { tip, method: 'POST', url: finalUrl.href, status: response.status, ms: Date.now() - startedAt },
            'qb.fetch ok',
        );
        return text;
    } catch (error) {
        // 同 GET：4xx 不重试（重复加种是 409，重试只会白等）
        const retriable = !error.status || error.status >= 500;
        if (retries > 0 && retriable) {
            logger.warn(
                { tip, method: 'POST', url: finalUrl.href, retriesLeft: retries - 1, err: error.message },
                'qb.fetch retry',
            );
            await new Promise(resolve => setTimeout(resolve, 5000));
            return fetchQbPost(baseUrl, apiUrl, params, apiKey, tip, retries - 1);
        }
        logger.error(
            { tip, method: 'POST', url: finalUrl.href, err: error.message, ms: Date.now() - startedAt },
            'qb.fetch abort',
        );
        const wrapped = new Error(`获取 ${tip} 失败：${error.message}`);
        wrapped.status = error.status;
        wrapped.bodyText = error.bodyText;
        throw wrapped;
    }
}

// ─────────────────────────────────────────────
// 中间层
// ─────────────────────────────────────────────

/**
 * qB API 通用调用：自动选择 GET/POST，对 JSON 响应自动解析。
 * 响应是纯文本（如 version）时原样返回。
 *
 * @param {Object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiUrl            - 如 "/api/v2/torrents/info"
 * @param {"GET"|"POST"} [opts.method="GET"]
 * @param {Object} [opts.params={}]
 * @param {string} opts.apiKey
 * @param {string} opts.tip
 * @param {number} [opts.retries=2]
 * @returns {Promise<any|null>} 解析结果，失败返回 null
 */
async function qbApiCall({ baseUrl, apiUrl, method = "GET", params = {}, apiKey, tip, retries = 2 }) {
    try {
        const raw = method === "POST"
            ? await fetchQbPost(baseUrl, apiUrl, params, apiKey, tip, retries)
            : await fetchQbGet(baseUrl, apiUrl, params, apiKey, tip, retries);

        // 仅对对象/数组做 JSON.parse，避免把 "2.0" 之类纯文本转成数字
        const trimmed = raw.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                return JSON.parse(trimmed);
            } catch {
                return raw;
            }
        }
        return raw;
    } catch (error) {
        logger.error({ tip, err: error.message }, 'qb.api fail');
        return null;
    }
}

// ─────────────────────────────────────────────
// 业务层
// ─────────────────────────────────────────────

/**
 * @typedef {Object} QbVersion
 * @property {string} applicationVersion - 应用版本，如 "v4.1.3"
 * @property {string} apiVersion         - WebAPI 版本，如 "2.0"
 */

/**
 * 获取 qBittorrent 应用版本和 WebAPI 版本
 *
 * 并发请求：
 * - GET /api/v2/app/version
 * - GET /api/v2/app/webapiVersion
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {number} [retries=2]
 * @returns {Promise<QbVersion | null>}
 */
async function getQbVersion(baseUrl, apiKey, retries = 2) {
    const [applicationVersion, apiVersion] = await Promise.all([
        qbApiCall({ baseUrl, apiUrl: "/api/v2/app/version",       apiKey, tip: "QbAppVersion", retries }),
        qbApiCall({ baseUrl, apiUrl: "/api/v2/app/webapiVersion", apiKey, tip: "QbApiVersion", retries }),
    ]);
    if (!applicationVersion || !apiVersion) return null;
    return { applicationVersion, apiVersion };
}

/**
 * @typedef {Object} QbTransferInfo
 * @property {number} dl_info_speed     - 全局下载速率（字节/秒）
 * @property {number} dl_info_data      - 本次会话下载的数据量（字节）
 * @property {number} up_info_speed     - 全局上传速率（字节/秒）
 * @property {number} up_info_data      - 本次会话上传的数据量（字节）
 * @property {number} dl_rate_limit     - 下载速率限制（字节/秒）
 * @property {number} up_rate_limit     - 上传速率限制（字节/秒）
 * @property {number} dht_nodes         - 已连接的 DHT 节点数
 * @property {string} connection_status - "connected" / "firewalled" / "disconnected"
 */

/**
 * 获取 qBittorrent 全局传输信息
 *
 * GET /api/v2/transfer/info
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {number} [retries=2]
 * @returns {Promise<QbTransferInfo | null>}
 */
async function getQbGlobalTransferInfo(baseUrl, apiKey, retries = 2) {
    return qbApiCall({
        baseUrl,
        apiUrl: "/api/v2/transfer/info",
        apiKey,
        tip: "QbGlobalTransferInfo",
        retries,
    });
}

/**
 * @typedef {Object} QbTorrentListParams
 * @property {string}  [filter]   - all / downloading / seeding / completed / paused / active / inactive / resumed / stalled / stalled_uploading / stalled_downloading / errored
 * @property {string}  [category] - 分类名（空串=无分类，不传=任意分类）
 * @property {string}  [tag]      - 标签（空串=无标签，不传=任意标签）
 * @property {string}  [sort]     - 排序字段
 * @property {boolean} [reverse]  - 是否反向排序，默认 false
 * @property {number}  [limit]    - 返回数量上限
 * @property {number}  [offset]   - 偏移量（<0 从末尾计算）
 * @property {string}  [hashes]   - 多个 hash 用 | 分隔
 */

/**
 * @typedef {Object} QbTorrent
 * @property {string}  hash                - 种子哈希
 * @property {string}  name                - 种子名称
 * @property {string}  category            - 所属分类
 * @property {string}  tags                - 逗号连接的标签列表
 * @property {string}  state               - 种子状态
 * @property {number}  size                - 已选择下载的文件总大小（字节）
 * @property {number}  total_size          - 所有文件总大小（字节）
 * @property {number}  progress            - 进度（0~1）
 * @property {number}  ratio               - 分享率
 * @property {number}  dlspeed             - 下载速度（字节/秒）
 * @property {number}  upspeed             - 上传速度（字节/秒）
 * @property {number}  downloaded          - 已下载数据量（字节）
 * @property {number}  uploaded            - 已上传数据量（字节）
 * @property {number}  amount_left         - 剩余待下载数据量（字节）
 * @property {number}  eta                 - 预计剩余时间（秒）
 * @property {number}  added_on            - 添加时间（Unix 时间戳）
 * @property {number}  completion_on       - 完成时间（Unix 时间戳）
 * @property {number}  last_activity       - 最近活动时间（Unix 时间戳）
 * @property {string}  save_path           - 数据保存路径
 * @property {string}  content_path        - 内容绝对路径
 * @property {string}  magnet_uri          - Magnet URI
 * @property {string}  tracker             - 第一个正常工作的 Tracker
 * @property {number}  num_seeds           - 已连接做种者数
 * @property {number}  num_leechs          - 已连接下载者数
 * @property {number}  dl_limit            - 下载速度限制（字节/秒），-1 无限制
 * @property {number}  up_limit            - 上传速度限制（字节/秒），-1 无限制
 * @property {boolean} auto_tmm            - 是否由自动种子管理
 * @property {boolean} seq_dl              - 是否顺序下载
 * @property {boolean} force_start         - 是否强制开始
 * @property {boolean} super_seeding       - 是否超级做种
 * @property {number}  priority            - 优先级，-1 表示禁用排队或做种模式
 * @property {number}  seeding_time        - 完成后做种时间（秒）
 * @property {number}  time_active         - 总活动时间（秒）
 * @property {number}  seen_complete       - 最后一次看到完成的时间（Unix 时间戳）
 * @property {boolean} isPrivate           - 是否来自私有 Tracker
 */

/**
 * 获取 qBittorrent 种子列表
 *
 * GET /api/v2/torrents/info
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {QbTorrentListParams} [params={}]
 * @param {number} [retries=2]
 * @returns {Promise<QbTorrent[] | null>}
 */
async function getQbTorrentList(baseUrl, apiKey, params = {}, retries = 2) {
    return qbApiCall({
        baseUrl,
        apiUrl: "/api/v2/torrents/info",
        method: "GET",
        params,
        apiKey,
        tip: "QbTorrentList",
        retries,
    });
}

/**
 * 获取指定种子的通用属性
 *
 * GET /api/v2/torrents/properties
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {{ hash: string }} params - 必须包含 hash
 * @param {number} [retries=2]
 * @returns {Promise<Object | null>}
 */
async function getQbTorrentProperties(baseUrl, apiKey, params = {}, retries = 2) {
    return qbApiCall({
        baseUrl,
        apiUrl: "/api/v2/torrents/properties",
        method: "GET",
        params,
        apiKey,
        tip: "QbTorrentProperties",
        retries,
    });
}

/**
 * @typedef {Object} QbAddTorrentParams
 * @property {string}  [urls]               - 种子链接 / magnet，多个用 \n 分隔
 * @property {string}  [savepath]           - 保存路径
 * @property {string}  [category]           - 分类
 * @property {string}  [tags]               - 标签，多个用逗号分隔
 * @property {string}  [rename]             - 重命名
 * @property {boolean} [paused]             - 是否暂停添加
 * @property {boolean} [skip_checking]      - 跳过校验
 * @property {boolean} [sequentialDownload] - 顺序下载
 * @property {boolean} [autoTMM]            - 自动种子管理
 */

/**
 * 添加新种子
 *
 * POST /api/v2/torrents/add
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {QbAddTorrentParams} params
 * @param {number} [retries=2]
 * @returns {Promise<string | Object | null>}
 */
async function postQbAddTorrent(baseUrl, apiKey, params = {}, retries = 2) {
    return qbApiCall({
        baseUrl,
        apiUrl: "/api/v2/torrents/add",
        method: "POST",
        params,
        apiKey,
        tip: "QbAddTorrent",
        retries,
    });
}

/**
 * 重命名种子（任务名）—— qB 的 `/api/v2/torrents/rename`
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {{ hash: string, name: string }} params
 * @param {number} [retries=0]
 * @returns {Promise<string | Object | null>}
 */
async function postQbRenameTorrent(baseUrl, apiKey, params = {}, retries = 0) {
    return qbApiCall({
        baseUrl,
        apiUrl: "/api/v2/torrents/rename",
        method: "POST",
        params,
        apiKey,
        tip: "QbRenameTorrent",
        retries,
    });
}

/**
 * 重命名种子内的文件 —— qB 的 `/api/v2/torrents/renameFile`
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {{ hash: string, oldPath: string, newPath: string }} params
 * @param {number} [retries=0]
 * @returns {Promise<string | Object | null>}
 */
async function postQbRenameFile(baseUrl, apiKey, params = {}, retries = 0) {
    return qbApiCall({
        baseUrl,
        apiUrl: "/api/v2/torrents/renameFile",
        method: "POST",
        params,
        apiKey,
        tip: "QbRenameFile",
        retries,
    });
}



// ⚠️ 这里原来有一句顶层 console.log(await getQbTorrentProperties("http://192.168.5.2:8080/", "qbt_…"))
// —— 导入本模块就会发一次请求，而且把内网地址和真实 API Key 硬编码在了源码里。
// 已删除：QB 地址与 API Key 一律从配置读（config.qb.base / config.qb.apiKey ← .env）
// 联调时请另外写脚本调用 getQbTorrentList(config.qb.base, config.qb.apiKey)，不要把密钥写回源码。

export {
    fetchQbGet,
    fetchQbPost,
    qbApiCall,
    getQbVersion,
    getQbGlobalTransferInfo,
    getQbTorrentList,
    getQbTorrentProperties,
    postQbAddTorrent,
    postQbRenameTorrent,
    postQbRenameFile,

};