/**
 * 零依赖 zip 读取 —— 只做一件很窄的事：**从 zip 里取指定条目，流式输出解压后的字节**
 * ---------------------------------------------------------------------------
 * 为什么自己写：和当初选 `node:sqlite` 而不是 `better-sqlite3` 同一个理由 ——
 * 不想为了"读两个 deflate 条目"引入原生依赖。Node 自带 `zlib` 就够了。
 *
 * 支持范围（刻意窄，遇到不认识的**明确报错**，不猜）：
 *   · 压缩方式：0（store）/ 8（deflate）
 *   · 非 zip64（450MB 用不到；真遇到说明上游改版了）
 *   · 加密 / 分卷：不支持
 *
 * 关键点：**按中央目录里的偏移和大小读**，不信任本地头 —— 带 data descriptor
 * （本地头里 size 写 0）的 zip 也能正确读。
 */
import { closeSync, createReadStream, openSync, readSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP64_MARK = 0xffffffff

/** EOCD 最多 22 + 65535 字节注释 */
const TAIL_BYTES = 22 + 0xffff

/**
 * 列出 zip 里的条目（只读中央目录，不解压）
 * @param {string} file
 * @returns {Array<{ name: string, method: number, compressedSize: number, size: number, offset: number }>}
 */
export function listZipEntries(file) {
  const total = statSync(file).size
  const fd = openSync(file, 'r')
  try {
    const tailLen = Math.min(total, TAIL_BYTES)
    const tail = Buffer.alloc(tailLen)
    readSync(fd, tail, 0, tailLen, total - tailLen)

    // 从尾部往前找 EOCD（注释里可能恰好出现签名字节，所以往回找最后一个）
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('不是 zip（找不到 EOCD）：文件可能没下完')

    const count = tail.readUInt16LE(eocd + 10)
    const centralSize = tail.readUInt32LE(eocd + 12)
    const centralOffset = tail.readUInt32LE(eocd + 16)
    if (centralOffset === ZIP64_MARK || centralSize === ZIP64_MARK) {
      throw new Error('这是 zip64 格式，本项目不支持 —— 请手动解压后用 --dir')
    }

    const central = Buffer.alloc(centralSize)
    readSync(fd, central, 0, centralSize, centralOffset)

    const entries = []
    let p = 0
    for (let i = 0; i < count; i++) {
      if (p + 46 > central.length || central.readUInt32LE(p) !== CENTRAL_SIG) {
        throw new Error('zip 中央目录损坏（条目签名不对）')
      }
      const method = central.readUInt16LE(p + 10)
      const compressedSize = central.readUInt32LE(p + 20)
      const size = central.readUInt32LE(p + 24)
      const nameLen = central.readUInt16LE(p + 28)
      const extraLen = central.readUInt16LE(p + 30)
      const commentLen = central.readUInt16LE(p + 32)
      const offset = central.readUInt32LE(p + 42)
      const name = central.toString('utf8', p + 46, p + 46 + nameLen)
      if (compressedSize === ZIP64_MARK || size === ZIP64_MARK || offset === ZIP64_MARK) {
        throw new Error(`条目 ${name} 用了 zip64，本项目不支持 —— 请手动解压后用 --dir`)
      }
      entries.push({ name, method, compressedSize, size, offset })
      p += 46 + nameLen + extraLen + commentLen
    }
    return entries
  } finally {
    closeSync(fd)
  }
}

/**
 * 打开 zip 里某个条目，返回**解压后**的可读流
 * @param {string} file
 * @param {string} name 条目名（zip 内路径，例如 `subject.jsonlines`）
 * @returns {import('node:stream').Readable}
 */
export function openZipEntry(file, name, entries = null) {
  const list = entries || listZipEntries(file)
  const entry = list.find((item) => item.name === name || item.name.endsWith(`/${name}`))
  if (!entry) {
    const names = list.map((item) => item.name).join(', ')
    throw new Error(`zip 里没有 ${name}（现有条目：${names.slice(0, 200)}）`)
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`条目 ${name} 的压缩方式 ${entry.method} 不支持（只认 store / deflate）`)
  }

  // 本地头的 name/extra 长度可能与中央目录不同（两边各自带一份），所以要从本地头读
  const fd = openSync(file, 'r')
  let local
  try {
    local = Buffer.alloc(30)
    readSync(fd, local, 0, 30, entry.offset)
  } finally {
    closeSync(fd)
  }
  if (local.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`条目 ${name} 的本地头损坏`)
  const nameLen = local.readUInt16LE(26)
  const extraLen = local.readUInt16LE(28)
  const dataStart = entry.offset + 30 + nameLen + extraLen

  if (entry.compressedSize === 0) return Readable.from([])

  const raw = createReadStream(file, { start: dataStart, end: dataStart + entry.compressedSize - 1 })
  // store：原样输出；deflate：inflateRaw（zip 里是 raw deflate，没有 zlib 头）
  if (entry.method === 0) return raw
  const inflate = createInflateRaw()
  raw.on('error', (err) => inflate.destroy(err))
  return raw.pipe(inflate)
}
