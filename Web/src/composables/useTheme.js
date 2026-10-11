/**
 * 主题（浅色 / 深色 / 跟随系统）—— 全站唯一入口
 * ---------------------------------------------------------------------------
 * 设计要点：
 *   1. 主题类只写在 <html> 上（theme-light / theme-dark），颜色全在 tokens.css
 *      的两套变量里 —— 组件一律不写主题分支，也就不存在「某个组件忘了适配」；
 *   2. 「当前是什么主题」必须有唯一真相，所以状态放在模块级单例里：侧栏、以后的
 *      设置页共用同一份，不会各存一份互相打架；
 *   3. 持久化只在 load / save 两个小函数里，将来下沉到 pinia / 后端下发时只改这两处，
 *      调用方（useTheme() 的用法）不用动；
 *   4. 服务端渲染安全：没有 window 时只返回默认值，绝不碰 document / localStorage。
 *
 * 用法：
 *   const { mode, isDark, setMode, toggleLightDark } = useTheme()
 *   mode      —— 用户选择：'system' | 'light' | 'dark'（ref）
 *   isDark    —— 当前真正生效的是不是深色（ref，system 模式下由系统偏好决定）
 *   setMode   —— 显式设定并持久化（「跟随系统」按钮直接调 setMode('system')）
 *   toggleLightDark —— 浅色/深色 开关：切到没生效的那一边（点了就等于用户接管主题）
 *
 * 另外：index.html 里有一段内联脚本，在首屏渲染前就把同样的判断做一遍，
 * 否则深色用户会先看到一帧白底（FOUC）。改存储键要两处一起改。
 */

import { computed, ref } from 'vue'

/** 三种用户选择（首个为默认值：没存过就跟随系统；按钮顺序由调用方自己排） */
export const THEME_MODES = ['system', 'light', 'dark']

/** 存储键（index.html 的内联脚本里同名，改一处要改两处） */
export const THEME_STORAGE_KEY = 'soraikahub:theme'

/** 每个模式的中文名（侧栏开关 / 跟随系统按钮与以后的设置页共用，避免各处各写一套文案） */
export const THEME_LABELS = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}

/** 能碰 DOM / 存储吗（SSR 下为 false） */
function canUseDom() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

/** 用户选择；未初始化时按「跟随系统」 */
const mode = ref(THEME_MODES[0])
/** 系统当前是否深色（只在客户端有意义） */
const systemDark = ref(false)

let initialized = false
const media =
  canUseDom() && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

/** 真正生效的主题：选了「跟随系统」就由系统偏好决定，否则听用户的 */
const resolved = computed(() =>
  mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value,
)
const isDark = computed(() => resolved.value === 'dark')

/** 把当前主题写到 <html>（样式与原生控件配色都靠这一步） */
function apply() {
  if (!canUseDom()) return
  const dark = isDark.value
  const root = document.documentElement
  root.classList.toggle('theme-dark', dark)
  root.classList.toggle('theme-light', !dark)
  // color-scheme：让滚动条 / 下拉 / 自动填充这些「浏览器自己画的东西」也跟着变，
  // 否则深色页面里会突然弹出一个白底原生控件
  root.style.colorScheme = dark ? 'dark' : 'light'
}

/** 读持久化（失败就按默认，隐私模式 / 禁用存储都能正常用） */
function load() {
  if (!canUseDom()) return THEME_MODES[0]
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    return THEME_MODES.includes(saved) ? saved : THEME_MODES[0]
  } catch {
    return THEME_MODES[0]
  }
}

function save(value) {
  if (!canUseDom()) return
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, value)
  } catch {
    /* 存不了不影响本次会话 */
  }
}

/** 系统偏好变了：跟随系统时要立刻重画；已显式选了浅/深色则只更新记录 */
function onSystemChange(event) {
  systemDark.value = event.matches
  apply()
}

/** 另一个标签页改了主题：跟过来（不重复写存储，避免来回触发） */
function onStorage(event) {
  if (event.key !== THEME_STORAGE_KEY) return
  if (!THEME_MODES.includes(event.newValue)) return
  mode.value = event.newValue
  apply()
}

/** 首次调用时初始化：读存储、订阅系统偏好与跨标签页变更 */
function ensureReady() {
  if (initialized) return
  initialized = true
  if (!canUseDom()) return

  mode.value = load()
  if (media) {
    systemDark.value = media.matches
    media.addEventListener('change', onSystemChange)
  }
  window.addEventListener('storage', onStorage)
  apply()
}

export function useTheme() {
  ensureReady()

  function setMode(next, { persist = true } = {}) {
    if (!THEME_MODES.includes(next)) return
    ensureReady()
    mode.value = next
    if (persist) save(next)
    apply()
  }

  /**
   * 浅色 / 深色 开关：切到「当前没生效」的那一边。
   * 跟随系统时也照此 —— 点一下就把主题从系统手里接管过来（变成显式的浅 / 深）。
   */
  function toggleLightDark() {
    setMode(isDark.value ? 'light' : 'dark')
  }

  return { mode, resolved, isDark, setMode, toggleLightDark }
}
