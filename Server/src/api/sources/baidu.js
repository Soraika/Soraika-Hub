/**
 * 百度网盘（BaiduPCS-Go）—— 离线下载 / 转存 / 列目录
 * ---------------------------------------------------------------------------
 * 为什么是它：**Linux/NAS 上没有官方"能离线下载"的客户端**。
 *   · 百度官方的 Linux 客户端只是同步盘，没有离线和转存；
 *   · 迅雷的 Linux 版只上架了统信/麒麟，仅基础下载；迅雷 NAS 版（fnOS 应用）
 *     连云盘空间都没有（实测 `/drive/v1/tasks` 只有 `device_id#` 一个 space）。
 * BaiduPCS-Go 是唯一在 Linux/Windows 上都能跑的：`offlinedl` 直接吃磁力/电驴/http，
 * `transfer` 吃分享链接（可带提取码）。
 *
 * 调用方式是**子进程**，不用库：这个程序自己管登录态（存它自己的配置文件），
 * 我们只负责喂参数、读输出。所以一切「登录」都归结为一次 `login -cookies=...`。
 *
 * 命令（v4.0.2 实测的 help 输出为准）：
 *   login -cookies="..."                      登录
 *   who                                       当前账号
 *   offlinedl add -path=<保存路径> <地址...>    加离线任务（磁力/电驴/http）
 *   offlinedl list                            任务列表
 *   offlinedl cancel <id...> / delete         取消 / 删记录
 *   transfer <分享链接> <提取码>                转存
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { config } from '../../config.js'
import { fail } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

const NOT_CONFIGURED = '还没配置百度网盘（设置 → 百度网盘：二进制路径 + Cookie）'

export const baiduConfigured = () => Boolean(config.baidu?.bin)

/**
 * 跑一条 BaiduPCS-Go 命令
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(args, { timeoutMs = 60000 } = {}) {
  const bin = config.baidu?.bin
  if (!bin) return Promise.reject(fail('BAD_REQUEST', NOT_CONFIGURED))

  /* 配置目录用环境变量指过去（`BaiduPCS-Go env` 里就叫 BAIDUPCS_GO_CONFIG_DIR）——
     它没有 -config 参数，只能这么改。好处是登录态落在项目数据目录里，
     卸载/迁移项目时跟着走，也不会和用户自己装的 BaiduPCS-Go 抢同一份配置。 */
  const cfgDir = path.resolve(config.baidu.configDir || 'data/baidu')
  const env = { ...process.env, BAIDUPCS_GO_CONFIG_DIR: cfgDir }
  const full = args

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(bin, full, { windowsHide: true, env })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: `启动失败：${err.message}` })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
    }, timeoutMs)

    child.stdout?.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `无法执行 ${bin}：${err.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: Number(code) || 0, stdout, stderr })
    })
  })
}

/** 输出里带这些就算失败（BaiduPCS-Go 的失败文案不统一，只能扫关键词） */
const ERROR_MARKS = ['失败', '错误', 'error', 'Error', '未登录', '取消', '不存在', '无权限', 'ftp server']

function pickError({ stdout, stderr }) {
  const text = `${stderr}\n${stdout}`
  const hit = ERROR_MARKS.find((m) => text.includes(m))
  if (!hit) return ''
  return text
    .split('\n')
    .filter((l) => ERROR_MARKS.some((m) => l.includes(m)))
    .join(' ')
    .slice(0, 200)
}

/**
 * 保证已登录：cookie 变了就重新 login 一次
 * 幂等 —— 每次都 login 也没问题（只是多一次写配置），但没必要，所以按 cookie 指纹缓存
 */
let loggedWith = ''
async function ensureLogin() {
  const cookies = String(config.baidu?.cookies || '').trim()
  if (!cookies) throw fail('BAD_REQUEST', '没有百度 Cookie（设置 → 百度网盘）')
  if (loggedWith === cookies) return
  const res = await run(['login', `-cookies=${cookies}`], { timeoutMs: 45000 }).catch(() => null)
  if (!res) throw fail('UPSTREAM', '登录百度失败：命令没跑起来')
  const bad = pickError(res)
  if (bad) throw fail('UPSTREAM', `登录百度失败：${bad}`)
  loggedWith = cookies
  logger.info('baidu.login ok')
}

/** 当前账号（顺带验证登录态是否有效） */
export async function baiduWho() {
  await ensureLogin()
  const res = await run(['who'], { timeoutMs: 30000 })
  const bad = pickError(res)
  if (bad) throw fail('UPSTREAM', `读取百度账号失败：${bad}`)
  return { raw: res.stdout.trim().slice(0, 500) }
}

/**
 * 加离线下载任务（磁力 / 电驴 / http 直链）
 * @param {{ urls: string[], path?: string }} params
 */
export async function baiduOfflineAdd({ urls = [], path: savePath } = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).map((u) => String(u || '').trim()).filter(Boolean)
  if (!list.length) throw fail('BAD_REQUEST', '没有要离线的地址')
  const dir = savePath || config.baidu?.offlineDir || ''
  if (!dir) throw fail('BAD_REQUEST', '没有配置离线保存路径')

  await ensureLogin()
  const args = ['offlinedl', 'add', `-path=${dir}`, ...list]
  const res = await run(args, { timeoutMs: 120000 })
  const bad = pickError(res)
  if (bad) throw fail('UPSTREAM', `百度离线失败：${bad}`)
  /* 成功时会打印任务 id，形如「任务ID: 1234567890」或直接一串数字 */
  const ids = [...res.stdout.matchAll(/(?:^|\D)(\d{6,})/g)].map((m) => m[1])
  logger.info({ count: list.length, dir, ids: ids.slice(0, 5) }, 'baidu.offline add ok')
  return { ok: true, dir, ids: [...new Set(ids)], raw: res.stdout.trim().slice(0, 800) }
}

/**
 * 离线任务列表
 * 输出是文本表格，这里只做「按行切 + 抓 id」，把原样一起带回去给界面兜底。
 */
export async function baiduOfflineList() {
  await ensureLogin()
  const res = await run(['offlinedl', 'list'], { timeoutMs: 60000 })
  const text = `${res.stdout}`
  if (pickError(res) && !/任务ID|任务id|status/i.test(text)) {
    throw fail('UPSTREAM', `读百度离线列表失败：${pickError(res)}`)
  }
  return { raw: text.trim().slice(0, 4000), lines: text.split('\n').map((l) => l.trimEnd()).filter(Boolean) }
}

/** 转存分享链接（可带提取码） */
export async function baiduTransfer({ shareUrl, pwd = '', path: toPath = '' } = {}) {
  if (!shareUrl) throw fail('BAD_REQUEST', '缺少分享链接')
  await ensureLogin()
  /* transfer 没有 --path：它转存到**当前网盘工作目录**，所以先 cd 过去 */
  if (toPath) {
    const cd = await run(['cd', String(toPath)], { timeoutMs: 30000 })
    const cdBad = pickError(cd)
    if (cdBad) throw fail('UPSTREAM', `切换到 ${toPath} 失败：${cdBad}`)
  }
  const args = ['transfer', String(shareUrl).trim()]
  if (pwd) args.push(String(pwd).trim())
  const res = await run(args, { timeoutMs: 120000 })
  const bad = pickError(res)
  if (bad) throw fail('UPSTREAM', `百度转存失败：${bad}`)
  return { ok: true, raw: res.stdout.trim().slice(0, 800) }
}
