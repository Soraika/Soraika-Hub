/**
 * 系列链的数据源：dump 里的关系表（`bgm_relation` + `bgm_stub`）
 * ---------------------------------------------------------------------------
 * 为什么单独一层：`walkSeries` 只要一个 `loadRelated(bgmId)` 回调 —— 有 dump 时它是
 * 两次索引查询，没有时退回打 BGM 上游。上层（jobs/series.js）只做一次判断，链逻辑零改动。
 *
 * 三条规则：
 *   · 只返回 `type = 2`（动画）：关系表里还有音乐 / 书籍 / 游戏，它们不进系列链；
 *   · 两个方向都读：dump 一般两边都写，只有单边时用逆关系（3↔2、6↔12、4↔5）补名字；
 *   · 名字/日期从 `bgm_stub` 带出来 —— `ensureChainStubs` 建骨架行要用，`fillMissingDates`
 *     排剧场版季位也要用（省掉每部一次 BGM 请求）。
 */
import { db } from './index.js'
import { inverseRelationNameOf, relationNameOf } from '../lib/bgm-archive.js'

const stmt = {
  clear: db.prepare('DELETE FROM bgm_relation'),
  clearStubs: db.prepare('DELETE FROM bgm_stub'),
  insertRelation: db.prepare(
    `INSERT OR IGNORE INTO bgm_relation (subject_id, relation_type, related_subject_id, ord)
     VALUES (?, ?, ?, ?)`,
  ),
  insertStub: db.prepare(
    `INSERT INTO bgm_stub (bgm_id, type, name, name_cn, date, source)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(bgm_id) DO UPDATE SET
       type    = COALESCE(excluded.type, bgm_stub.type),
       name    = COALESCE(excluded.name, bgm_stub.name),
       name_cn = COALESCE(excluded.name_cn, bgm_stub.name_cn),
       date    = COALESCE(excluded.date, bgm_stub.date)`,
  ),
  count: db.prepare('SELECT COUNT(*) AS n FROM bgm_relation'),
  countStubs: db.prepare('SELECT COUNT(*) AS n FROM bgm_stub'),
  stub: db.prepare('SELECT * FROM bgm_stub WHERE bgm_id = ?'),
  /** 正向：X 的关系（X 是起点） */
  outgoing: db.prepare(
    `SELECT r.related_subject_id AS other, r.relation_type AS type, s.type AS other_type,
            s.name AS name, s.name_cn AS name_cn
       FROM bgm_relation r
       LEFT JOIN bgm_stub s ON s.bgm_id = r.related_subject_id
      WHERE r.subject_id = ?`,
  ),
  /** 反向：别人把 X 当什么（X 是终点），关系名取逆 */
  incoming: db.prepare(
    `SELECT r.subject_id AS other, r.relation_type AS type, s.type AS other_type,
            s.name AS name, s.name_cn AS name_cn
       FROM bgm_relation r
       LEFT JOIN bgm_stub s ON s.bgm_id = r.subject_id
      WHERE r.related_subject_id = ?`,
  ),
}

/** 整表重灌前的清空（与 dump 导入同节奏：每周一次） */
export function clearRelations() {
  db.exec('BEGIN IMMEDIATE')
  try {
    stmt.clear.run()
    stmt.clearStubs.run()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** 批量写关系（rows: `[subjectId, relationType, relatedId, ord]`） */
export function insertRelations(rows) {
  if (!rows?.length) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows) stmt.insertRelation.run(...row)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** 批量写「链上条目」的轻量档案（名字 / 类型 / 日期） */
export function insertStubs(rows) {
  if (!rows?.length) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows) {
      stmt.insertStub.run(row.bgmId, row.type ?? null, row.name ?? null, row.nameCn ?? null, row.date ?? null, row.source || 'dump')
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export const countRelations = () => stmt.count.get()?.n ?? 0
export const countStubs = () => stmt.countStubs.get()?.n ?? 0
export const hasRelations = () => countRelations() > 0
export const stubOf = (bgmId) => stmt.stub.get(String(bgmId)) ?? null

/**
 * 取一个条目的 1 跳关系（`walkSeries` 的 `loadRelated` 实现）
 * @param {string|number} bgmId
 * @returns {Array<{id:string, name:string, nameCn:string, relation:string, type:number}>}
 */
export function relatedOf(bgmId) {
  const id = String(bgmId)
  const seen = new Set()
  const out = []
  const push = (row, relation) => {
    if (!relation) return
    if (Number(row.other_type) !== 2) return // 只要动画（音乐 / 书籍 / 游戏不进系列）
    const key = `${row.other}:${relation}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      id: String(row.other),
      name: row.name || '',
      nameCn: row.name_cn || '',
      relation,
      type: Number(row.other_type) || 0,
    })
  }
  for (const row of stmt.outgoing.all(id)) push(row, relationNameOf(row.type))
  for (const row of stmt.incoming.all(id)) push(row, inverseRelationNameOf(row.type))
  return out
}
