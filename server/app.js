const express = require('express');
const cors = require('cors');
const configRoutes = require('./routes/config');
const mikanRoutes = require('./routes/mikan');
const classifyRoutes = require('./routes/classify');
const bgmRoutes = require('./routes/bgm');
const qbRoutes = require('./routes/qb');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 3001;

// 全局中间件
app.use(cors());
app.use(express.json({ limit: '1mb' }));

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

app.listen(PORT, () => {
  console.log(`🚀 Soraika's Hub 启动成功 → http://localhost:${PORT}`);
  console.log(`   配置: mikan=${config.get('mikan.baseUrl')}  bgm=${config.get('bgm.baseUrl')}  qb=${config.get('qbittorrent.url') || '未配置'}`);
  console.log(`   GET  /api/health               — 健康检查`);
  console.log(`   GET  /api/config               — 读取配置`);
  console.log(`   PUT  /api/config               — 更新配置`);
  console.log(`   GET  /api/mikan/list            — 最新 RSS`);
  console.log(`   GET  /api/mikan/schedule        — 排期列表`);
  console.log(`   GET  /api/mikan/subdetail/:bgmid — 番剧字幕组`);
  console.log(`   GET  /api/mikan/rss/:id/:sub    — 字幕组种子`);
  console.log(`   GET  /api/mikan/search?q=       — 搜索番剧`);
  console.log(`   POST /api/classify              — AI 分类`);
  console.log(`   GET  /api/bgm/subject/:id       — BGM 条目详情`);
  console.log(`   GET  /api/bgm/search?q=         — BGM 搜索`);
  console.log(`   GET  /api/qb/status             — QB 状态`);
  console.log(`   GET  /api/qb/torrents           — 任务列表`);
  console.log(`   POST /api/qb/add                — 普通下载`);
  console.log(`   POST /api/qb/anime              — 番剧批量下载`);
});