/**
 * settings 表 repository —— 设置页改过的配置项（key → JSON 值）
 * ---------------------------------------------------------------------------
 * 只负责「存 / 取 / 删」这三件事，**不校验、不应用**：
 * 校验（格式对不对）在 lib/settings.js，应用（写进 config 对象）在 api/pages/settings.js。
 * 值一律 JSON 包一层：`'deepseek-chat'`、`120`、`true` 存进去再读出来类型不变。
 */
import { db } from './index.js'

const stmt = {
  all: db.prepare('SELECT key, value_json FROM settings'),
  upsert: db.prepare(`
    INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `),
  del: db.prepare('DELETE FROM settings WHERE key = ?'),
  clear: db.prepare('DELETE FROM settings'),
  /** 看板/排错用：谁被改过、什么时候改的 */
  meta: db.prepare('SELECT key, updated_at FROM settings ORDER BY updated_at DESC'),
}

/** 全部覆盖项 → `{ 'ai.model': 'deepseek-chat', … }` */
export function listSettings() {
  const out = {}
  for (const row of stmt.all.all()) {
    try {
      out[row.key] = JSON.parse(row.value_json)
    } catch {
      // 手改坏了库也不该让服务起不来：跳过这一条，日志里能看出来
      out[row.key] = null
    }
  }
  return out
}

/**
 * 批量写入（一个事务）：`{ path: value }`；value 为 null 表示**删除覆盖**（回落到代码默认值）
 * @param {Record<string, any>} patch
 */
export function setSettings(patch) {
  const entries = Object.entries(patch)
  if (!entries.length) return 0

  const now = Date.now()
  db.exec('BEGIN')
  try {
    for (const [key, value] of entries) {
      if (value === null) stmt.del.run(key)
      else stmt.upsert.run(key, JSON.stringify(value), now)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return entries.length
}

/** 重置：paths 为空 = 全部清掉 */
export function clearSettings(paths = []) {
  if (!paths.length) {
    const n = listSettings()
    stmt.clear.run()
    return Object.keys(n).length
  }
  db.exec('BEGIN')
  try {
    for (const key of paths) stmt.del.run(key)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return paths.length
}

/** 覆盖项的元信息：`[{ key, updatedAt }]` */
export const settingsMeta = () => stmt.meta.all().map((r) => ({ key: r.key, updatedAt: r.updated_at }))
