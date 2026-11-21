/**
 * 海报的**多源候选链** —— 一张图不行就换下一个源，而不是死盯一个
 * ---------------------------------------------------------------------------
 * 踩过的问题：Mikan 的封面地址形如
 *
 *   https://mikanani.me/images/bangumi/202112/18ca807f.jpg     ← 404
 *
 * 站点换了域名（mikanime.tv）、老图被清、图床抽风，都会让某一条地址直接 404。
 * 以前只认库里存的那一条，404 之后前端就只剩占位底纹 —— 明明 Bangumi 上有封面。
 *
 * 所以「图源」不是一个地址，是**一条有序的候选链**，按代价从低到高：
 *
 *   ① 库里存的那条（`poster_src`）—— 零成本，命中率最高
 *   ② 同一条路径换到其它 Mikan 镜像域名 —— 只是换个 host，不花额外请求（失败也算便宜）
 *   ③ Bangumi 封面 —— 要打一次 API 才拿到真实地址（`lain.bgm.tv` 的路径带 hash，
 *      没法从 id 拼出来），所以放在最后，只在前面全挂时才花这一次
 *
 * 两条设计约束：
 *   · **静态候选（①②）不发任何请求**：首页每次请求都要算一遍，必须是纯字符串运算。
 *   · **候选项去重 + 保留顺序**：顺序就是「先试哪个」，不能因为去重把它打乱。
 */
import { config } from '../config.js'

/**
 * 内置 Mikan 镜像（**只在设置里没配的时候兜底**）
 * 同一个图床的老域名与新域名互为主备，实测两边都活着的时候内容一致。
 */
export const DEFAULT_MIKAN_MIRRORS = ['https://mikanime.tv', 'https://mikanani.me', 'https://mikanani.kas.pub']

/** 归一化域名：去协议差异（http/https 都算同一个镜像）、去结尾斜杠、小写 */
const normalizeHost = (base) => {
  try {
    return new URL(String(base)).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 当前生效的镜像列表：设置里的 `image.mirrors` → 排期源地址（它们也是 Mikan 站，图床一样）
 * → 内置兜底。去重按 host（`http://x` 与 `https://x` 算同一个）。
 */
export function mikanMirrors() {
  const raw = [
    ...(Array.isArray(config.image?.mirrors) ? config.image.mirrors : []),
    ...(Array.isArray(config.mikan?.bases) ? config.mikan.bases : []),
    ...DEFAULT_MIKAN_MIRRORS,
  ]
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const host = normalizeHost(item)
    if (!host || seen.has(host)) continue
    seen.add(host)
    out.push(String(item).replace(/\/+$/, ''))
  }
  return out
}

/**
 * 这条地址是不是「Mikan 图床上的图」（只有它才谈得上换镜像）
 * ---------------------------------------------------------------------------
 * 两个条件都要满足：
 *   · 路径在 `/images/` 下（页面地址、API 地址都不是图）
 *   · 域名是 Mikan 系的**或**已在镜像表里 —— 后者很重要：
 *     用户自己配了反代/镜像（比如 `img.example.com`），也算"同一份图床"，
 *     不然给它换个域名重试的逻辑就永远走不到。
 * Bangumi 的 `lain.bgm.tv` 不满足任何一条 —— 它没有 mikan 镜像，换过去只会 404。
 */
export function isMikanImage(url) {
  try {
    /* 比较时用 `host`（带端口）而不是 `hostname`：自建/反代镜像常跑在非 443 端口上，
       只比 hostname 会把 `127.0.0.1:8080` 与 `127.0.0.1:9090` 当成同一个站点 */
    const { host, hostname, pathname } = new URL(String(url))
    if (!/\/images\//i.test(pathname)) return false
    if (/(^|\.)mikan(ani|ime)[a-z0-9.-]*$/i.test(hostname)) return true
    return mikanMirrors().some((base) => normalizeHost(base) === host.toLowerCase())
  } catch {
    return false
  }
}

/**
 * 把一条 Mikan 图床地址换到某个镜像域
 * 只换 origin 的 host（**保留协议与路径原样**）：路径里带日期目录与文件名哈希，
 * 换不得。镜像站如果只支持 https，直接用它自己的协议。
 */
export function rewriteToMirror(url, mirrorBase) {
  try {
    const src = new URL(String(url))
    const mirror = new URL(String(mirrorBase))
    src.protocol = mirror.protocol
    src.host = mirror.host
    return src.href
  } catch {
    return null
  }
}

/**
 * 静态候选（**不发请求**）：库里那条 + 各镜像上的同一条路径
 * @param {{poster_src?: string|null}} row
 * @returns {string[]}
 */
export function staticCandidates(row) {
  const primary = row?.poster_src ? String(row.poster_src) : ''
  const list = primary ? [primary] : []
  if (primary && isMikanImage(primary)) {
    /* 换域名时跳过**它自己**（同一 host 换过去还是同一条地址，纯浪费一次请求） */
    const selfHost = normalizeHost(primary)
    for (const mirror of mikanMirrors()) {
      if (normalizeHost(mirror) === selfHost) continue
      const url = rewriteToMirror(primary, mirror)
      if (url && !list.includes(url)) list.push(url)
    }
  }
  return list
}

/**
 * 完整候选链（静态在前，Bangumi 在最后）
 * @param {{poster_src?: string|null, bgm_id?: string|number|null}} row
 * @param {{ resolveBgm?: (row) => Promise<string|null> }} [options]
 *   `resolveBgm` 由调用方注入（要打上游、要写库，属于 cache/poster.js 的职责）；
 *   传不传决定「要不要花那一次 API」——列表页的静态候选就不需要它。
 */
export async function candidateSources(row, { resolveBgm } = {}) {
  const list = staticCandidates(row)
  if (typeof resolveBgm === 'function' && row?.bgm_id) {
    try {
      const bgmSrc = await resolveBgm(row)
      if (bgmSrc && !list.includes(bgmSrc)) list.push(bgmSrc)
    } catch {
      /* 拿不到就少一个源，不影响前面那些 */
    }
  }
  return list
}
