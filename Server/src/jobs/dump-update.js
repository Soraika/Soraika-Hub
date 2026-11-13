/**
 * 离线 dump 的自动更新 —— 检查有没有新版 → 有才下载 → 流式解压导入
 * ---------------------------------------------------------------------------
 * 为什么"检查"和"更新"分开：
 *   索引只有 539 字节，一天查一次几乎零成本；而下载是 450MB。
 *   所以默认路径是「查一下，digest 没变就结束」，一周里有 6 天走这条。
 *
 * 状态存在 `dump_state`（不是配置）：重启、换进程都不会重复导同一版。
 *
 * 用法：
 *   npm run dump                 # 检查 + 有新版就更新（自动）
 *   npm run dump -- --check      # 只检查（不打库、不下载）
 *   npm run dump -- --force      # 忽略"已导入"，重灌一次
 *   npm run dump -- --keep-zip   # 导入后保留 zip
 */
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { downloadDump, fetchDumpIndex } from './../api/sources/bgm-dump.js'
import { config } from './../config.js'
import { getDumpState, saveDumpState } from './../db/dump.js'
import { logger } from './../lib/logger.js'
import { runArchiveImport } from './import-archive.js'

/**
 * 只检查：拿到索引并与本地记录的 digest 比对（顺手写 checked_at）
 * @param {{ log?: object }} [options]
 * @returns {Promise<{ index: object, state: object|null, hasNew: boolean }>}
 */
export async function checkDump({ log = logger } = {}) {
  const index = await fetchDumpIndex({ log })
  const state = saveDumpState({ checked_at: Date.now() })
  const hasNew = !state?.digest || state.digest !== index.digest
  log.info(
    { name: index.name, hasNew, local: state?.name || '(从未导入)', digest: index.digest.slice(0, 12) },
    'dump.check ok',
  )
  return { index, state, hasNew }
}

/**
 * 完整更新：检查 → 下载（需要时）→ 导入 → 记状态
 * @param {{ force?: boolean, keepZip?: boolean, dryRun?: boolean, log?: object }} [options]
 */
export async function updateDump({ force = false, keepZip, dryRun = false, log = logger } = {}) {
  const startedAt = Date.now()
  const { index, hasNew } = await checkDump({ log })
  if (!hasNew && !force) {
    return { status: 'up-to-date', index, ms: Date.now() - startedAt }
  }

  const dir = resolve(process.cwd(), config.bgm?.dumpDir || 'data/dump')
  const cached = join(dir, index.name)
  // 上次下载成功但导入失败时，zip 还在 → 直接复用，别再拉 450MB
  const zip = existsSync(cached)
    ? (log.info({ zip: cached }, 'dump.download cached'), cached)
    : (await downloadDump({ asset: index, dir, log })).file

  const imported = await runArchiveImport({ dir: zip, dryRun, log })
  if (!dryRun) {
    saveDumpState({
      name: index.name,
      digest: index.digest,
      size: index.size,
      source_url: index.url,
      imported_at: Date.now(),
    })
    const keep = keepZip ?? Boolean(config.bgm?.dumpKeepZip)
    if (!keep) rmSync(zip, { force: true })
  }
  log.info(
    {
      name: index.name,
      patched: imported.patched,
      needArchive: `${imported.before.needArchive} → ${imported.after.needArchive}`,
      kept: dryRun ? '(dry-run)' : Boolean(keepZip ?? config.bgm?.dumpKeepZip),
      ms: Date.now() - startedAt,
    },
    'dump.update done',
  )
  return { status: 'imported', index, imported, zip, ms: Date.now() - startedAt }
}

// ── 直接执行时作为 CLI 运行（npm run dump）────────────────────────────────
const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isCli) {
  const flag = (name) => process.argv.includes(`--${name}`)
  try {
    if (flag('check')) {
      const { index, state, hasNew } = await checkDump()
      logger.info(
        { latest: index.name, local: state?.name || '(从未导入)', hasNew, size: index.size },
        hasNew ? 'dump.check new-version' : 'dump.check up-to-date',
      )
    } else {
      await updateDump({ force: flag('force'), keepZip: flag('keep-zip'), dryRun: flag('dry-run') })
    }
  } catch (err) {
    logger.error({ err: err?.message || String(err) }, 'dump.fail')
    process.exitCode = 1
  }
}
