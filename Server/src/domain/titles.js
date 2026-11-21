/**
 * 番名的「比较用」归一化与目录名匹配 —— 纯函数，不碰库不碰网络
 * ---------------------------------------------------------------------------
 * 为什么单独一个模块：三处都要用同一套规则（db/relation 写索引、下载页认目录、
 * 归档导入建骨架），放在任何一个业务模块里都会造成反向依赖。
 *
 * 核心问题：**名字是给人看的，比较需要另一把尺子**。
 *   · 全角/半角、波浪号 ～ ~ 〜 混用（BGM 用 ～，Mikan 有时用 ~）
 *   · 分卷后缀时有时无（库里「…第2部分」，磁盘目录「…」）
 *   · 归档目录可能是**系列根名**（老版本按系列建目录）
 * 但**错认比认不出更糟**：认错会把两部的集数混在一起，所以这里只在「候选唯一」时才认。
 */

/** 分卷/分季后缀：从尾部剥掉再比（顺序无关，剥到剥不动为止） */
const VOLUME_SUFFIX =
  /(?:第\s*[0-9一二三四五六七八九十]+\s*(?:部分|クール|季|期|章)|\bseason\s*\d+|\bpart\s*\d+|\b(?:2nd|3rd|4th)\s*season\b|\bcour\s*\d+)\s*$/u

/** 归一化：NFKC（全角→半角）、去所有空白、统一波浪号、小写。只用于比较，不用于显示 */
export function foldTitle(title) {
  if (!title) return ''
  return String(title)
    .normalize('NFKC')
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[～~〜]/gu, '~')
    .toLowerCase()
}

/** 剥掉分卷后缀（可能叠两层，例如「第三季 第2部分」） */
export function stripVolumeSuffix(title) {
  let out = String(title || '')
  for (let i = 0; i < 3; i++) {
    const next = out.replace(VOLUME_SUFFIX, '')
    if (next === out) break
    out = next
  }
  return out
}

/**
 * 给一批目录名找作品。只返回**唯一确定**的匹配。
 * @param {string[]} folders 归档目录名
 * @param {Array<object>} rows 候选行（至少含 id、以及 title_bgm/title_mikan/title_bgm_origin 或 name）
 * @returns {Map<string, object>} 目录名 → 候选行（没匹配上就不在 Map 里）
 */
export function matchFolders(folders, rows) {
  const exact = new Map()
  const loose = new Map()
  const seriesMembers = new Map()
  const push = (map, key, row) => {
    if (!key) return
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(row)
  }
  for (const row of rows || []) {
    const titles = [row.title_bgm, row.title_mikan, row.title_bgm_origin, row.name, row.name_cn].filter(Boolean)
    const seen = new Set()
    for (const t of titles) {
      const f = foldTitle(t)
      if (!f || seen.has(f)) continue
      seen.add(f)
      push(exact, f, row)
      push(loose, foldTitle(stripVolumeSuffix(t)), row)
    }
    if (row.series_id != null) {
      if (!seriesMembers.has(row.series_id)) seriesMembers.set(row.series_id, [])
      seriesMembers.get(row.series_id).push(row)
    }
  }

  /** 一个 key 命中多行 = 模棱两可 → 只有这些行其实是同一部作品时才算数 */
  const onlyOne = (list) => {
    if (!list || !list.length) return null
    const ids = new Set(list.map((r) => String(r.id ?? r.bgm_id)))
    return ids.size === 1 ? list[0] : null
  }

  const out = new Map()
  for (const folder of new Set(folders || [])) {
    const f = foldTitle(folder)
    if (!f) continue
    const hit = onlyOne(exact.get(f)) || onlyOne(loose.get(foldTitle(stripVolumeSuffix(folder))))
    if (hit) {
      out.set(folder, hit)
      continue
    }
    /* 系列根名：目录按系列建的 —— 只有单成员系列才敢认（多成员指代不明） */
    const byRoot = (rows || []).filter(
      (row) => row.series_root_title && foldTitle(row.series_root_title) === f && row.series_id != null,
    )
    const rootIds = new Set(byRoot.map((r) => r.series_id))
    if (rootIds.size === 1) {
      const members = seriesMembers.get([...rootIds][0]) || []
      if (members.length === 1) out.set(folder, members[0])
    }
  }
  return out
}
