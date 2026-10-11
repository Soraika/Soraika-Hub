/**
 * 优雅停机验收用的小 harness —— 起服务后给自己发一个 SIGINT
 * ---------------------------------------------------------------------------
 * 为什么需要它：Node 在 Windows 上不支持「向别的进程投递信号」，
 * `child.kill('SIGINT')` 只会把进程硬杀掉、不会走 index.js 里的停机处理器，
 * 所以要在**同一个进程内**触发：process.emit('SIGINT') 走的正是真实那条路径。
 * 由 scripts/verify-home.mjs 拉起，也可单独跑：`node scripts/verify-shutdown.mjs`
 */
process.env.PORT ||= '3301'

await import('../src/index.js')

// 等它挂上处理器 + 起好 HTTP 服务，再触发停机
setTimeout(() => process.emit('SIGINT'), 800)
