/**
 * 季选组件冒烟 —— **真挂 DOM 点一次**（SSR 测不出这一层）
 * ---------------------------------------------------------------------------
 * 为什么必须有它：季选的弹层是 `.season-picker` 内部状态控制的，
 * `verify-e2e` 用 SSR 渲染时面板是关着的 —— 面板渲染路径（年份循环、禁用判定…）
 * 从来不会被执行。曾因此漏掉一个 `ReferenceError: seasons is not defined`：
 * 面板一渲染就抛异常，表现是"箭头转了但弹层永远不出现"，SSR 验收全绿却毫无察觉。
 *
 * 做法：用 vite 打一个小 harness（只挂 SeasonPicker）→ 在 happy-dom 里 import →
 * 点触发器 → 断言 `.popover` 进 DOM 且渲染出年份/季度。
 */
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import fs from 'node:fs'
import { Window } from 'happy-dom'

const root = process.cwd()
const outDir = path.resolve(root, 'scripts/.picker-harness-dist')
const failures = []
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(label)
}

await build({
  root: path.resolve(root, 'scripts/picker-harness'),
  logLevel: 'error',
  plugins: [vue()],
  resolve: { alias: { '@': path.resolve(root, 'src') } },
  build: { outDir, emptyOutDir: true },
})
const jsFile = fs.readdirSync(path.join(outDir, 'assets')).find((f) => f.endsWith('.js'))

const win = new Window({ url: 'http://localhost/' })
globalThis.window = win
globalThis.document = win.document
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
globalThis.HTMLElement = win.HTMLElement
globalThis.Element = win.Element
globalThis.Node = win.Node
globalThis.SVGElement = win.SVGElement
globalThis.getComputedStyle = win.getComputedStyle.bind(win)
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

document.body.innerHTML = '<div id="app"></div>'
const errors = []
process.on('uncaughtException', (err) => errors.push(err.message))
await import(new URL(`file://${path.join(outDir, 'assets', jsFile).replace(/\\/g, '/')}`).href)
await new Promise((r) => setTimeout(r, 60))

const trigger = document.querySelector('.trigger')
check(Boolean(trigger), `触发器渲染出来了 → ${trigger?.textContent?.trim() ?? '（空）'}`)

trigger?.dispatchEvent(new win.Event('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 150))

const pop = document.querySelector('.popover')
check(Boolean(pop), `.popover 进了 DOM（渲染期没抛异常）${pop ? '' : `｜错误：${errors[0] ?? '（无异常但没渲染）'}`}`)
check(pop ? pop.textContent.includes('2026') && pop.textContent.includes('春') : false, '面板里渲染出年份与季度')
check(document.querySelectorAll('.year-row').length > 0, `年份行数量 → ${document.querySelectorAll('.year-row').length}`)
check(/position:\s*fixed/.test(pop?.getAttribute('style') || ''), '弹层用 fixed 定位（坐标由锚点算）')

fs.rmSync(outDir, { recursive: true, force: true })
console.log(failures.length ? `\n✗ 失败 ${failures.length} 项` : '\n✓ 全部通过')
process.exit(failures.length ? 1 : 0)
