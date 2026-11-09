/**
 * 离线 dump 的导入状态（`dump_state`，单行）
 * ---------------------------------------------------------------------------
 * 只有一件事重要：**digest**。索引里的 digest 和它一样就说明"这版已经导过了"，
 * 直接跳过 450MB 下载。其余字段（name/size/source_url/时间）只用于设置页展示与排查。
 */
import { db, val } from './index.js'

const stmt = {
  select: db.prepare('SELECT * FROM dump_state WHERE id = 1'),
  upsert: db.prepare(`
    INSERT INTO dump_state (id, name, digest, size, source_url, checked_at, imported_at)
    VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name        = COALESCE(excluded.name, dump_state.name),
      digest      = COALESCE(excluded.digest, dump_state.digest),
      size        = COALESCE(excluded.size, dump_state.size),
      source_url  = COALESCE(excluded.source_url, dump_state.source_url),
      checked_at  = COALESCE(excluded.checked_at, dump_state.checked_at),
      imported_at = COALESCE(excluded.imported_at, dump_state.imported_at)
  `),
}

/** 当前记录（没有就是 null） */
export const getDumpState = () => stmt.select.get() ?? null

/**
 * 写状态 —— 只传要改的字段（null/undefined 不覆盖已有值）
 * @param {{ name?: string, digest?: string, size?: number, source_url?: string,
 *           checked_at?: number, imported_at?: number }} patch
 */
export function saveDumpState(patch = {}) {
  stmt.upsert.run(
    val(patch.name),
    val(patch.digest),
    val(patch.size),
    val(patch.source_url),
    val(patch.checked_at),
    val(patch.imported_at),
  )
  return getDumpState()
}
