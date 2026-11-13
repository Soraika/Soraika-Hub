#!/usr/bin/env node
/**
 * 下载并解出 BaiduPCS-Go 二进制 —— 纯 Node，不依赖 curl/unzip
 * ---------------------------------------------------------------------------
 * 为什么要自己解 zip：基础镜像（node:*-slim）里没有 curl 也没有 unzip，
 * 而 apt-get 在不少 NAS 网络下会 500/超时。既然 Node 一定在，就用它自己干：
 *   · 下载用内置 fetch（跟着 302 跳转）
 *   · 解压只处理 ZIP 的「central directory + stored/deflate」两种方法，
 *     够对付 GitHub release 的 zip（实测 method=8 单文件）
 *
 * 用法：
 *   node scripts/fetch-baidupcs.mjs                       # 默认装到 tools/baidupcs
 *   node scripts/fetch-baidupcs.mjs --dest=/app/tools/baidupcs --version=4.0.2
 *   node scripts/fetch-baidupcs.mjs --platform=linux-arm64
 * 失败时**退出码为 0**（构建不该因为下不到二进制就挂掉），只打印警告。
 */
import { createWriteStream } from 'node:fs'
import { mkdir, chmod, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)

const VERSION = args.version || '4.0.2'
const DEST = path.resolve(args.dest || 'tools/baidupcs')
const PLATFORM = args.platform || (process.arch === 'arm64' ? 'linux-arm64' : 'linux-amd64')

/* 顺序即优先级：GitHub 直连在国内基本拉不动，所以镜像放前面 */
const MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  '',
]
const ASSET = `BaiduPCS-Go-v${VERSION}-${PLATFORM}.zip`
const REPO = 'https://github.com/qjfoidnh/BaiduPCS-Go/releases/download'
const URL = `${REPO}/v${VERSION}/${ASSET}`

/** 解析 ZIP：只认 central directory（本地头里的 size 可能是 0，因为用了 data descriptor） */
function unzip(buf) {
  /* EOCD 签名 0x06054b50，从尾部往前找（后面可能跟着最多 64KB 注释） */
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）')

  const total = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = []

  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('central directory 损坏')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)

    /* 本地头的长度字段不可信（data descriptor 场景为 0），按名字后的偏移取数据 */
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const comp = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? comp : method === 8 ? zlib.inflateRawSync(comp) : null
    if (data) out.push({ name, data })

    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

async function tryDownload(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1000) throw new Error(`文件太小（${buf.length}B），大概率是错误页`)
  return buf
}

async function main() {
  console.log(`[baidupcs] 目标 ${ASSET} → ${DEST}`)
  let zip = null
  for (const m of MIRRORS) {
    const url = m + URL
    try {
      console.log(`[baidupcs] 尝试 ${m || 'GitHub 直连'}`)
      zip = await tryDownload(url)
      console.log(`[baidupcs] 下载成功 ${(zip.length / 1e6).toFixed(1)} MB`)
      break
    } catch (err) {
      console.warn(`[baidupcs]   失败：${err.message}`)
    }
  }
  if (!zip) {
    console.warn('[baidupcs] ⚠️  全部源都失败，跳过（百度相关功能不可用，可事后手动放入 DEST）')
    return
  }

  const entries = unzip(zip)
  const bin = entries.find((e) => /(^|\/)BaiduPCS-Go$/.test(e.name))
  if (!bin) {
    console.warn(`[baidupcs] ⚠️  zip 里没有 BaiduPCS-Go，条目：${entries.map((e) => e.name).join(', ')}`)
    return
  }
  await mkdir(DEST, { recursive: true })
  const target = path.join(DEST, 'BaiduPCS-Go')
  await writeFile(target, bin.data)
  if (process.platform !== 'win32') await chmod(target, 0o755)
  console.log(`[baidupcs] 已写入 ${target}（${(bin.data.length / 1e6).toFixed(1)} MB）`)
}

main().catch((err) => {
  console.warn(`[baidupcs] ⚠️  未预期的错误：${err.message}（跳过，不影响构建）`)
})
