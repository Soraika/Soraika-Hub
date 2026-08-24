const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pinoHttp = require('pino-http');
const logger = require('./utils/logger');
const configRoutes = require('./routes/config');
const mikanRoutes = require('./routes/mikan');
const classifyRoutes = require('./routes/classify');
const bgmRoutes = require('./routes/bgm');
const qbRoutes = require('./routes/qb');
const discoverRoutes = require('./routes/discover');
const recommend = require('./services/recommend');
const mikanMapping = require('./services/mikanMapping');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 3001;

// ── 启动自检：数据目录可写性（部署环境常见权限问题，启动即暴露） ──
// 与 config.js / logger.js 的数据目录约定保持一致
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const probe = path.join(DATA_DIR, '.write-test');
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
} catch (e) {
  logger.error({ err: e }, '数据目录不可写，配置/日志/转换表将无法保存：请检查卷权限（PUID/PGID 或目录属主）');
}

// ── 全局兜底：未捕获异常 / 未处理 rejection ──
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, '未捕获异常，进程即将退出');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, '未处理的 Promise rejection');
});

// 全局中间件
// 禁用 ETag：API 返回动态数据，避免浏览器 If-None-Match 命中返回 304（axios 拿不到 body，导致发现页/排期加载不出）
app.disable('etag');
app.use(cors());
app.use(express.json({ limit: '1mb' }));
// HTTP 访问日志（健康检查不刷屏；>=500 记 error、>=400 记 warn）
app.use(pinoHttp({
  logger,
  customSerializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  autoLogging: {
    ignore: (req) => req.url === '/api/health',
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
}));

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: "Soraika's Hub" });
});

// ── 路由挂载 ──
app.use('/api/config', configRoutes);     // 统一配置
app.use('/api/mikan', mikanRoutes);       // Mikan 解析
app.use('/api/classify', classifyRoutes); // AI 标题分类
app.use('/api/bgm', bgmRoutes);           // Bangumi 条目
app.use('/api/qb', qbRoutes);             // qBittorrent 下载
app.use('/api/discover', discoverRoutes); // 番剧推荐（发现页）

// ── 生产环境：托管前端构建产物（client/dist） ──
// Docker 镜像内 WORKDIR=/app，前端产物位于 /app/client/dist，故用 __dirname/client/dist
// （本地开发 __dirname=server，server/client/dist 不存在则跳过，由 vite dev server 托管前端）
const DIST_DIR = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(DIST_DIR)) {
  // 静态资源显式保留 ETag + 短缓存（全局已禁用 ETag，这里对构建产物单独开启）
  app.use(express.static(DIST_DIR, { etag: true, maxAge: '1d' }));
  // SPA 回退：非 /api 的 GET 请求一律走 index.html（交给前端路由）
  // 用中间件而非 app.get('*')，兼容新版 path-to-regexp（express 5）
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// 启动推荐引擎（后台采集候选池 + 每日刷新）
recommend.init();
// 启动 Mikan → Bangumi ID 转换表（每日自动更新 + 本地 json 缓存）
mikanMapping.init();

app.listen(PORT, () => {
  logger.info(`Soraika's Hub 启动成功 → http://localhost:${PORT}`);
  logger.info('   数据源: mikan=%s | bgm=%s | qb=%s', config.get('mikan.baseUrl'), config.get('bgm.baseUrl'), config.get('qbittorrent.url') || '未配置');
  logger.info('   转换表: %s', config.get('mikan.mappingUrl') || mikanMapping.DEFAULT_SOURCE);
  logger.info('   API: GET/PUT /config · GET /mikan/list|schedule|subdetail/:id|rss/:id/:sub|search|mapping · POST /mikan/mapping/sync · POST /classify/tags|download · GET /bgm/subject/:id|search · GET/POST/DELETE /qb/* · GET /discover/*');
});