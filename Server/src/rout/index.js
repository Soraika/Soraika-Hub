/**
 * 路由汇总 —— 所有对外接口都挂在 /api 下
 * 业务逻辑一律在 api/ 层，这里只负责拼装（为以后 MCP 复用 api/ 留好边界）
 */
import { Router } from 'express'
import { countAll, countSubgroupDict, stats } from '../db/anime.js'
import { dbFile } from '../db/index.js'
import { countGaveUp, countMissingBgm } from '../db/queue.js'
import { getWorkerState } from '../jobs/worker.js'
import { SETTINGS_GROUPS } from '../lib/settings.js'
import { aiCacheStats } from '../api/pages/ai.js'
import { aiProviderInfo } from '../api/sources/ai.js'
import { aiRouter } from './ai.js'
import { animeRouter } from './anime.js'
import { downloadsRouter } from './downloads.js'
import { homeRouter } from './home.js'
import { imgRouter } from './img.js'
import { settingsRouter } from './settings.js'

export const apiRouter = Router()

/**
 * 健康检查 / 进度看板：服务活着吗、库里有多少、两条后台队列跑到哪了
 * 浏览器直接打开就能看进度（后台每处理一条都会更新 workerState）
 */
apiRouter.get('/health', (req, res) => {
  res.json({
    ok: true,
    data: {
      status: 'up',
      db: dbFile,
      animeCount: countAll(),
      /** 映射/评分覆盖率 + 补齐队列还剩多少 / 有多少是上游确实没有（拿不到 bgmId 已放弃重试） */
      coverage: {
        ...stats(),
        missingDue: countMissingBgm(),
        gaveUp: countGaveUp(),
        /** 字幕组名字字典的条目数（随补齐/打开面板增长；用来确认"顺手抓字幕组"在工作） */
        subgroupDict: countSubgroupDict(),
      },
      /** 后台守护进程状态快照（未启动时 running=false） */
      worker: getWorkerState(),
      /**
       * 运行时认识哪些设置分组 —— 专门用来排「改了代码但跑的是旧进程」：
       * 新加的分组没出现在这里，就说明这个进程还是旧的（重启没成功/占着端口的是旧实例）。
       */
      settingsGroups: SETTINGS_GROUPS.map((group) => group.key),
      /** 本进程启动时间（ISO）：比 uptimeSec 更直观看「是不是刚重启过」 */
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      /** AI 是否可用（配了 key 才算可用）+ 两个解析缓存的条目数；**不含 key** */
      ai: { ...aiProviderInfo(), caches: aiCacheStats() },
      uptimeSec: Math.round(process.uptime()),
    },
  })
})

apiRouter.use(homeRouter)
apiRouter.use(animeRouter)
apiRouter.use(downloadsRouter)
apiRouter.use(aiRouter)
apiRouter.use(settingsRouter)
apiRouter.use(imgRouter)
