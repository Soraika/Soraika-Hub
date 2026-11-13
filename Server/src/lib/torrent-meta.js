/**
 * 读 .torrent 的元数据（bencode 最小实现）
 * ---------------------------------------------------------------------------
 * 为什么要自己解：**用 .torrent 而不是磁力的全部意义就在这里** ——
 * 磁力只有一个 hash，qB 拿到种子前不知道里面是文件还是文件夹、叫什么名字，
 * 于是 `metaDL` 那一段什么都不敢做（改名更不可能）；`.torrent` 里 `info.name`
 * 和 `info.files` 是现成的，加种的那一刻就能算出「这条该叫什么」。
 *
 * 只解根上需要的两件事（name / files），不做全量 bencode 树：
 *   · 单文件种子：`info.length` + `info.name` → 文件就是 name
 *   · 多文件种子：`info.files[{length, path:[…]}]` → 相对路径 = path.join('/')
 * 解析失败一律返回 null（让调用方退回「不预改名」，不要因为种子怪就加不进去）。
 */

/** 读一个 bencode 值，返回 [值, 下一个位置] */
function decode(buf, pos = 0) {
  const ch = String.fromCharCode(buf[pos])
  if (ch === 'i') {
    const end = buf.indexOf(0x65, pos) // 'e'
    return [Number(buf.toString('ascii', pos + 1, end)), end + 1]
  }
  if (ch === 'l') {
    const out = []
    let i = pos + 1
    while (String.fromCharCode(buf[i]) !== 'e') {
      const [v, next] = decode(buf, i)
      out.push(v)
      i = next
    }
    return [out, i + 1]
  }
  if (ch === 'd') {
    const out = {}
    let i = pos + 1
    while (String.fromCharCode(buf[i]) !== 'e') {
      const [k, next] = decode(buf, i)
      const [v, after] = decode(buf, next)
      out[String(k)] = v
      i = after
    }
    return [out, i + 1]
  }
  if (ch >= '0' && ch <= '9') {
    const colon = buf.indexOf(0x3a, pos) // ':'
    const len = Number(buf.toString('ascii', pos, colon))
    const start = colon + 1
    return [buf.subarray(start, start + len), start + len]
  }
  throw new Error(`bencode 解析失败（偏移 ${pos}，字符 ${ch}）`)
}

/**
 * 从 .torrent 的字节里取根名与文件列表
 * @param {Buffer} buffer
 * @returns {{ name: string, files: Array<{name:string,size:number}>, single: boolean } | null}
 */
export function torrentMetaOf(buffer) {
  try {
    if (!buffer?.length) return null
    const [root] = decode(buffer, 0)
    const info = root?.info
    if (!info?.name) return null
    const name = Buffer.isBuffer(info.name) ? info.name.toString('utf8') : String(info.name)

    if (Array.isArray(info.files) && info.files.length) {
      const files = info.files.map((f) => {
        const parts = (f.path || []).map((p) => (Buffer.isBuffer(p) ? p.toString('utf8') : String(p)))
        /* 多文件种子的文件在 **根文件夹** 里，所以相对路径就是 path 拼起来
           （不要再拼 info.name —— 那是文件夹本身，qB 的 files 列表也不含它） */
        return { name: parts.join('/'), size: Number(f.length) || 0 }
      })
      return { name, files, single: false }
    }

    if (info.length !== undefined) {
      return { name, files: [{ name, size: Number(info.length) || 0 }], single: true }
    }
    return null
  } catch {
    return null
  }
}
