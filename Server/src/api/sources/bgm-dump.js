/**
 * Bangumi 离线 dump 的「取数」层 —— 找最新版 / 选镜像 / 断点续传下载
 * ---------------------------------------------------------------------------
 * 上游：github.com/bangumi/Archive 的 releases（每周三 05:00 GMT+8 导一次全站）。
 * 三个真实约束决定了这里的所有设计：
 *
 *   1. `raw.githubusercontent.com` 和 release 资源在国内**不一定通** → 索引与下载都多源；
 *   2. 资源 450MB，慢代理上一次可能断 → **Range 断点续传**（跨镜像也能续，按字节偏移）；
 *   3. 档案错了比没更新更糟 → **sha256 校验通过才算数**，失败删文件、换镜像。
 *
 * 镜像用**模板**表示（`{url}` 占位），"直连"写成 `{url}` —— 这样列表里每一项都长一样，
 * 设置页可以直接复用多地址编辑器（可拖拽 + 单条测速）。
 */
import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './../../config.js'
import { fail } from './../../lib/errors.js'
import { logger } from './../../lib/logger.js'
import { probeMs } from './../../lib/multi-source.js'

/** 下载用的 UA（GitHub / 镜像都拒空 UA；与 http-client 保持一致） */
const UA = 'soraikahub/1.0 (+self-hosted)'

/** 探测镜像的超时：2 秒还没吐出首字节，基本就是"能连但很慢"，不该继续等 */
const PROBE_TIMEOUT_MS = 2000

/** 下载整包的超时：450MB 在慢速代理上可能要十几分钟，给足；卡死由连接层自己断 */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 按 `{url}` 模板展开一个镜像地址
 * @param {string} template
 * @param {string} url
 */
export const applyMirror = (template, url) => String(template || '{url}').replaceAll('{url}', url)

/**
 * 取最新版索引（多源：前一个失败就试下一个）
 * @param {{ log?: object }} [options]
 * @returns {Promise<{ name: string, size: number, digest: string, url: string, createdAt: string, indexUrl: string }>}
 */
export async function fetchDumpIndex({ log = logger } = {}) {
  const sources = (config.bgm?.dumpIndex || []).filter(Boolean)
  if (!sources.length) throw fail('INTERNAL', '没有配置索引地址（设置页「离线数据」里至少留一条）')

  let firstError
  for (const indexUrl of sources) {
    try {
      const res = await fetch(indexUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(config.bgm?.timeoutMs || 20000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const url = data?.browser_download_url
      const name = data?.name
      if (!url || !name) throw new Error('索引格式不对（缺 browser_download_url / name）')
      return {
        name,
        size: Number(data.size) || 0,
        digest: String(data.digest || '').replace(/^sha256:/, ''),
        url,
        createdAt: data.created_at || '',
        indexUrl,
      }
    } catch (err) {
      firstError ||= err
      log.warn({ indexUrl, err: err?.message || String(err) }, 'dump.index fail try-next')
    }
  }
  throw firstError || fail('UPSTREAM', '索引全部失败')
}

/**
 * 把镜像列表排成"先试谁"
 * ---------------------------------------------------------------------------
 * `sources.pickFastest` 开（默认）：对每条发一次 `Range: bytes=0-1`，按首字节延迟排序；
 * 探测失败的排最后（仍然会试，因为探测失败不等于下载失败）。
 * 关：严格按设置页里的顺序 —— 给"我就想用某个特定代理"的人留一条路。
 * @param {string} assetUrl
 * @param {{ log?: object }} [options]
 * @returns {Promise<Array<{ mirror: string, url: string, ms: number|null }>>}
 */
export async function rankMirrors(assetUrl, { log = logger } = {}) {
  const templates = (config.bgm?.dumpMirrors || []).filter(Boolean)
  const list = (templates.length ? templates : ['{url}']).map((mirror) => ({
    mirror,
    url: applyMirror(mirror, assetUrl),
  }))

  if (!config.sources?.pickFastest || list.length < 2) {
    return list.map((item) => ({ ...item, ms: null }))
  }

  const timed = await Promise.all(
    list.map(async (item) => ({
      ...item,
      ms: await probeMs(item.url, { timeoutMs: PROBE_TIMEOUT_MS, range: 'bytes=0-1' }),
    })),
  )
  const sorted = [...timed].sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity))
  log.info(
    {
      ranked: sorted.map(
        (item) => `${item.mirror || 'direct'}=${item.ms === null ? 'fail' : `${Math.round(item.ms)}ms`}`,
      ),
    },
    'dump.mirrors ranked',
  )
  return sorted
}

/**
 * 下载（可续传、可跨镜像续传）
 * ---------------------------------------------------------------------------
 * 语义：
 *   · `<dir>/<name>.part` 已存在 → 用 `Range: bytes=<已有>-` 接着下；
 *   · 某个镜像断了 → 换下一个镜像，**从同一偏移继续**（内容一致，只按字节算）；
 *   · 服务器不支持 Range（回 200）→ 清空重下，别拼出坏文件；
 *   · 下完对全文件算 sha256（续传时会重新算全量），与索引给的 digest 比对，
 *     不符就删 `.part` 并换镜像 —— **绝不把坏包交给导入**。
 * @param {object} options
 * @param {{ name: string, url: string, size: number, digest: string }} options.asset
 * @param {string} options.dir
 * @param {{ log?: object, onProgress?: (p: { downloaded: number, total: number }) => void }} [options]
 * @returns {Promise<{ file: string, bytes: number, url: string, ms: number }>}
 */
export async function downloadDump({ asset, dir, log = logger, onProgress } = {}) {
  if (!asset?.url) throw fail('BAD_REQUEST', '缺少下载地址')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, asset.name)
  const part = `${file}.part`
  const mirrors = await rankMirrors(asset.url, { log })
  const startedAt = Date.now()

  let lastError
  for (const candidate of mirrors) {
    try {
      const bytes = await downloadFrom(candidate.url, part, { asset, log, onProgress })
      const digest = await sha256Of(part)
      if (asset.digest && digest !== asset.digest) {
        rmSync(part, { force: true })
        throw new Error(`sha256 不符（期望 ${asset.digest.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`)
      }
      renameSync(part, file)
      return { file, bytes, url: candidate.url, ms: Date.now() - startedAt }
    } catch (err) {
      lastError = err
      log.warn(
        { mirror: candidate.mirror || 'direct', err: err?.message || String(err) },
        'dump.download fail try-next',
      )
    }
  }
  throw lastError || fail('UPSTREAM', '所有镜像都失败了')
}

/**
 * 「多久没收到数据就认为这个镜像挂了」
 * ---------------------------------------------------------------------------
 * 实测（2026-11-10）：gh-proxy 会在发了 500KB 后**再也不动**，而 fetch 的总超时是 30 分钟 ——
 * 结果整晚都在等一个已经死掉的连接。90 秒没有新字节 → 主动中断，换下一个镜像（.part 保留，接着续）。
 * 可用 `BGM_DUMP_STALL_MS` 覆盖（验收测试把它设成 300ms）。
 */
const stallMs = () => Number(process.env.BGM_DUMP_STALL_MS) || 90000

/**
 * 从一个地址下载到 `<part>`（续传），返回最终字节数
 * @param {string} url
 * @param {string} part
 * @param {{ asset: { size: number }, log: object, onProgress?: Function }} options
 */
/**
 * 从一个地址下载到 `<part>`（续传），返回最终字节数
 * ---------------------------------------------------------------------------
 * **为什么不用 `fetch`（undici），而用 node:http(s)**：
 * 实测踩到 undici 的内部断言 —— 边写盘边暂停响应流（`if (!out.write(chunk)) await drain`）
 * 时如果连接正好结束，socket 事件里会同步抛
 *   `AssertionError [ERR_ASSERTION]: assert(!this.paused)`（undici lib/dispatcher/client-h1.js）
 * 这个抛错发生在事件回调里，**try/catch 包不住** → 整个进程直接退出。
 * 也就是说：网络抖一下就能把服务搞挂，而且日志里只有一行 assert，看不出是下载引起的。
 * `req`/`res` 的 stream 没有这种内部状态机，暂停/恢复是标准 backpressure 语义。
 * 索引、镜像探测那些小请求仍然用 fetch（几十 KB，量级完全不同）。
 * @param {string} url
 * @param {string} part
 * @param {{ asset: { size: number }, log: object, onProgress?: Function }} options
 */
function downloadFrom(url, part, { asset, log, onProgress }) {
  return new Promise((resolve, reject) => {
    let offset = existsSync(part) ? statSync(part).size : 0
    if (asset.size && offset > asset.size) {
      rmSync(part, { force: true }) // 比目标还大 → 一定是坏文件，重来
      offset = 0
    }

    const client = url.startsWith('https:') ? https : http
    let settled = false
    let written = offset
    let gotResponse = false

    /* 两道闸：总时长（30 分钟）+ 无进度（默认 90 秒）。后者是「代理挂起」的解药 */
    let stallTimer = null
    const armStall = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        req.destroy(new Error(`${Math.round(stallMs() / 1000)} 秒没有收到数据`))
      }, stallMs())
    }
    const totalTimer = setTimeout(() => req.destroy(new Error('下载总时长超限')), DOWNLOAD_TIMEOUT_MS)

    const cleanup = () => {
      clearTimeout(stallTimer)
      clearTimeout(totalTimer)
    }
    const fail = (err) => {
      if (settled) return
      settled = true
      cleanup()
      req.destroy()
      reject(err)
    }

    const req = client.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
        },
      },
      (res) => {
        gotResponse = true
        armStall()

        /* 已经下完（上一次恰好停在末尾）：服务器会回 416 */
        if (res.statusCode === 416) {
          res.resume()
          settled = true
          cleanup()
          resolve(offset)
          return
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume()
          fail(new Error(`HTTP ${res.statusCode}`))
          return
        }
        /* 服务器忽略 Range（回 200）：只能从头来，否则会拼出坏文件 */
        if (offset > 0 && res.statusCode === 200) {
          rmSync(part, { force: true })
          offset = 0
          written = 0
        }

        const total = asset.size || Number(res.headers['content-length']) + offset || 0
        const out = createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' })
        const step = Math.max(1024 * 1024, Math.floor((total || 0) / 20))
        let nextReport = written + step

        out.on('error', fail)
        res.on('error', fail)
        res.on('aborted', () => fail(new Error('连接被中断')))

        res.on('data', (chunk) => {
          armStall() // 每收到一块就重置「无进度」计时
          written += chunk.length
          /* 交给 write() 自己排队：它返回 false 时**不主动暂停** res ——
             暂停/恢复的时机由流内部管，历史 bug 正是手工 await drain 引起的 */
          out.write(chunk)
          if (written >= nextReport) {
            nextReport = written + step
            onProgress?.({ downloaded: written, total })
            log.info(
              { downloaded: written, total, pct: total ? Math.round((written / total) * 100) : null },
              'dump.download progress',
            )
          }
        })

        res.on('end', () => {
          out.end(() => {
            if (settled) return
            settled = true
            cleanup()
            resolve(written)
          })
        })
      },
    )

    req.on('error', (err) => {
      const reason = err?.message || String(err)
      fail(new Error(gotResponse ? `下载中断：${reason}（已下 ${written} 字节，下次从断点续传）` : reason))
    })
    armStall()
  })
}

/** 整个文件的 sha256（续传后要按全量算，所以单独走一遍；450MB ≈ 1 秒） */
function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

