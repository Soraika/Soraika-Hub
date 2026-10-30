<template>
  <div ref="rootEl" class="season-picker" :class="{ open, disabled }" @keydown="onKeydown">
    <!-- 触发器：与搜索框、地铁图同栏，固定高度不换行 -->
    <button
      ref="triggerEl"
      class="trigger"
      type="button"
      :disabled="disabled"
      aria-haspopup="true"
      :aria-expanded="open"
      :aria-controls="panelId"
      @click="toggle"
    >
      <IconCalendarEvent :size="17" :stroke-width="2" />
      <span class="trigger-label">{{ label }}</span>
      <IconChevronDown class="caret" :class="{ rotated: open }" :size="15" :stroke-width="2.4" />
    </button>

    <!-- 下拉面板：交给统一的 PopoverPanel（**Teleport 到 body**）。
         它自己实现 absolute 面板时，会被吸顶栏/滚动容器的层叠与裁剪吃掉 —— 箭头转了却看不到内容。 -->
    <PopoverPanel :open="open" :anchor="triggerEl" align="left" label="选择季度" @close="close()">
      <div :id="panelId" ref="panelEl" class="season-panel">
        <p v-if="!years.length" class="panel-empty">暂无可选季度</p>

        <div v-for="item in years" :key="item.year" class="year-block">
          <button
            class="year-row"
            type="button"
            :data-year="item.year"
            :class="{ expanded: expandedYear === item.year }"
            :aria-expanded="expandedYear === item.year"
            :disabled="isYearDisabled(item)"
            @click="toggleYear(item.year)"
          >
            <span class="year-text">{{ item.year }}</span>
            <IconChevronDown
              class="caret"
              :class="{ rotated: expandedYear === item.year }"
              :size="14"
              :stroke-width="2.4"
            />
          </button>

          <!-- 折叠区：容器高度与胶囊「同一段动画」
               —— 用 grid-template-rows 0fr→1fr 直接拿到精确高度，
                  不再出现「面板先长高、胶囊后弹出」的两段感；
                  即便浏览器不支持 fr 插值，也只会退化成瞬间展开，不会错位 -->
          <div class="season-collapse" :class="{ open: expandedYear === item.year }">
            <div class="season-row">
              <button
                v-for="(season, si) in seasons"
                :key="season"
                class="season-chip"
                type="button"
                :style="{ '--i': si }"
                :class="{ active: isActive(item.year, season) }"
                :disabled="isDisabled(item, season)"
                :title="isDisabled(item, season) ? '该季度尚未到达' : ''"
                :aria-current="isActive(item.year, season) ? 'true' : undefined"
                @click="pick(item.year, season)"
              >
                <component :is="seasonIcons[season]" v-if="seasonIcons[season]" :size="14" :stroke-width="2.2" />
                <span>{{ season }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </PopoverPanel>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, onBeforeUnmount, useId } from 'vue'
import {
  IconCalendarEvent,
  IconChevronDown,
  IconFlower,
  IconSun,
  IconLeaf,
  IconSnowflake,
} from '@tabler/icons-vue'
import PopoverPanel from '@/components/ui/PopoverPanel.vue'

/**
 * 季度选择器（纯 UI，受控）
 * 只负责「展示 + 上抛选择」，不做任何日期推算：
 *   - 可选年份与禁用季度全部由使用方以数据形式给出（长列表如 2012~今年 也只是一次性数据）
 *   - 选择结果通过 select(year, season) 上抛
 * 交互约定：
 *   - 展开某年 = 容器高度与胶囊同一段动画（不存在「先撑开再弹出」的两段动作）
 *   - 打开时自动定位并聚焦「当前选中季」所在年份，年份再多也不用自己滚
 *   - 键盘：↑↓ 换年 / → 进入该年季列 / ← 退回年份 / Esc 关闭
 */
const props = defineProps({
  /** 触发器显示文案（成品字符串，如「2026 夏」） */
  label: { type: String, required: true },
  /** 可选年份：[{ year: 2026, disabled: ['秋'] }]，disabled 为可选 */
  years: { type: Array, default: () => [] },
  /** 季度顺序，按此顺序渲染胶囊 */
  seasons: { type: Array, default: () => ['冬', '春', '夏', '秋'] },
  /** 当前选中年份 */
  activeYear: { type: Number, default: null },
  /** 当前选中季度 */
  activeSeason: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['select'])

// 季度图标（装饰用；找不到对应季度的图标就不渲染图标）
const seasonIcons = {
  春: IconFlower,
  夏: IconSun,
  秋: IconLeaf,
  冬: IconSnowflake,
}

const panelId = useId()
const open = ref(false)
const expandedYear = ref(props.activeYear)
const rootEl = ref(null)
const panelEl = ref(null)
const triggerEl = ref(null)

function toggle() {
  if (open.value) close()
  else openPanel()
}

function openPanel() {
  // 每次打开都回到「当前选中季」的年份，长列表不会停在顶部
  expandedYear.value = props.activeYear ?? expandedYear.value
  open.value = true
  nextTick(() => {
    // 聚焦当前年份：顺带滚进可视区，键盘用户也能直接按方向键
    // （:focus-visible 保证鼠标用户看不到多余焦点框）
    yearRowEl(props.activeYear)?.focus()
  })
}

function close(refocus = false) {
  open.value = false
  if (refocus) triggerEl.value?.focus()
}

/**
 * 展开某一年的季度胶囊
 * ---------------------------------------------------------------------------
 * **点击只会展开、不会折叠**：之前再点一次同一年会收起来，看起来就像"点不开"
 * （用户的心智是"点一下就能选"）。要收起请点别的年份或点外部关闭。
 * 展开后把整块滚进可视区 —— 年份多的时候（2012~今年）胶囊可能落在面板折叠线以下，
 * 那样点下去"像是在空地上点"，什么都发生不了。
 */
function toggleYear(year) {
  expandedYear.value = year
  nextTick(() => {
    const block = panelEl.value?.querySelector(`.year-row[data-year="${year}"]`)?.closest('.year-block')
    block?.scrollIntoView({ block: 'nearest' })
  })
}

function isActive(year, season) {
  return props.activeYear === year && props.activeSeason === season
}

// 禁用项完全由数据驱动（哪些季度不可选由后端/上层决定）
function isDisabled(item, season) {
  return Array.isArray(item.disabled) && item.disabled.includes(season)
}

/**
 * 整年都不可选（四个季全是未来）→ 年份行也灰掉禁用（展开没有意义）
 * ---------------------------------------------------------------------------
 * 注意：`<script setup>` 里**没有**裸的 `seasons` 变量 —— 必须走 `props.seasons`。
 * 之前这里写成 `seasons.length`，而它在**面板渲染时**才被调用 →
 * 面板一渲染就抛 `ReferenceError`，表现就是"箭头转了但弹层永远不出现"
 * （触发器在面板关着时渲染，所以看不出问题；SSR 验收也测不到）。
 */
function isYearDisabled(item) {
  const list = Array.isArray(item?.disabled) ? item.disabled : []
  return list.length >= props.seasons.length
}

function pick(year, season) {
  open.value = false
  triggerEl.value?.focus()
  emit('select', year, season)
}

// ── 键盘导航用的 DOM 查询（不持有列表状态，顺序永远与渲染一致） ──────────
function yearRowEl(year) {
  if (year == null) return null
  return panelEl.value?.querySelector(`.year-row[data-year="${year}"]`) || null
}
function yearRows() {
  return Array.from(panelEl.value?.querySelectorAll('.year-row') || [])
}
function chipsOf(row) {
  return Array.from(row?.parentElement?.querySelectorAll('.season-chip:not(:disabled)') || [])
}

function onKeydown(e) {
  if (!open.value) return
  const rows = yearRows()
  const active = document.activeElement
  const rowIdx = rows.indexOf(active)

  if (e.key === 'Escape') {
    e.preventDefault()
    close(true)
    return
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const dir = e.key === 'ArrowDown' ? 1 : -1
    const next =
      rowIdx < 0 ? rows[dir > 0 ? 0 : rows.length - 1] : rows[(rowIdx + dir + rows.length) % rows.length]
    next?.focus()
    return
  }

  if (e.key === 'ArrowRight') {
    e.preventDefault()
    if (rowIdx >= 0) {
      // 年份行 → 展开并进入该年季列
      const row = rows[rowIdx]
      expandedYear.value = Number(row.dataset.year)
      nextTick(() => chipsOf(row)[0]?.focus())
      return
    }
    const chips = chipsOf(active.closest('.year-block')?.querySelector('.year-row'))
    const i = chips.indexOf(active)
    if (i >= 0) chips[(i + 1) % chips.length]?.focus()
    return
  }

  if (e.key === 'ArrowLeft') {
    if (rowIdx >= 0) return
    e.preventDefault()
    const row = active.closest('.year-block')?.querySelector('.year-row')
    const chips = chipsOf(row)
    const i = chips.indexOf(active)
    if (i > 0) chips[i - 1].focus()
    else row?.focus()
  }
}

/* 滚轮隔离交给面板自己：`overscroll-behavior: contain` 让滚到顶/底后不把滚动传给页面；
   鼠标滚轮也由浏览器原生滚动（弹层已经不在页面滚动条里了，不需要再手动 preventDefault）。 */

// 点击外部关闭：**交给 PopoverPanel**（它会同时判断"锚点"和"弹层"，
// 弹层已经 Teleport 到 body，本组件再也 contains 不到它 —— 自己再判一次会误关）。

/* 键盘：弹层挂在 body 上，焦点可能不在本组件里 —— 监听 document，
   只在打开时生效（↑↓ 换年 / → 进季度 / ← 退回 / Esc 关闭）。 */
onMounted(() => {
  document.addEventListener('keydown', onDocKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocKeydown)
})
function onDocKeydown(e) {
  if (open.value) onKeydown(e)
}
</script>

<style scoped>
.season-picker {
  position: relative;
  flex-shrink: 0;
}

/* ── 触发器 ───────────────────────────────────────────────────────────── */
.trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 0.9rem;
  font-weight: 500;
  white-space: nowrap;
  transition: border-color var(--dur), background var(--dur), box-shadow var(--dur);
}
.trigger:hover:not(:disabled) {
  border-color: var(--border-strong);
}
.season-picker.open .trigger {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.trigger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.trigger-label {
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
}
.caret {
  color: var(--text-tertiary);
  transition: transform var(--dur) var(--ease-out);
}
.caret.rotated {
  transform: rotate(180deg);
}

/* ── 下拉面板（外观/定位/滚动都由 PopoverPanel 负责，这里只管宽度与滚动链）── */
.season-panel {
  width: 232px;
  overscroll-behavior: contain;
}
.panel-empty {
  padding: 10px;
  color: var(--text-tertiary);
  font-size: 0.85rem;
  text-align: center;
}
.year-block + .year-block {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}

.year-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  /* 打开时会被程序聚焦（用于自动滚到当前年），留点边距免得贴边 */
  scroll-margin-block: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.86rem;
  font-weight: 700;
  transition: background var(--dur), color var(--dur);
}
.year-row:hover,
.year-row.expanded {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* ── 年份折叠区：容器高度与胶囊用同一段动画 ───────────────────────────────
 * grid-template-rows 0fr→1fr 会插值到「内容的精确高度」，
 * 所以不会出现「容器先长高、胶囊后弹出」的两段动作；
 * 不支持 fr 插值的浏览器只会退化成瞬间展开，不会错位或截断。 */
.season-collapse {
  display: grid;
  grid-template-rows: 0fr;
  visibility: hidden;
  transition: grid-template-rows var(--dur) var(--ease-out), visibility var(--dur) var(--ease-out);
}
.season-collapse.open {
  grid-template-rows: 1fr;
  visibility: visible;
}
.season-collapse > .season-row {
  min-height: 0;
  overflow: hidden;
}

.season-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  padding: 6px 2px 4px;
}

.season-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 7px 0;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.82rem;
  /* 出现动画：跟着容器一起（--i 由模板给出，做一点点错落）
     延迟只加给 opacity / transform，背景与文字的 hover 反馈不受影响 */
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity var(--dur) var(--ease-out) calc(var(--i, 0) * 23ms),
    transform var(--dur) var(--ease-out) calc(var(--i, 0) * 23ms), background var(--dur),
    color var(--dur);
}
.season-collapse.open .season-chip {
  opacity: 1;
  transform: none;
}
.season-chip:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.season-chip:active:not(:disabled) {
  transform: scale(0.96);
}
.season-chip.active {
  background: var(--accent);
  color: var(--text-invert);
}
.season-chip:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
/* 整年都没得选（四个季全是未来）→ 年份行也灰掉，展开没有意义 */
.year-row:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 打开/关闭的动效由 PopoverPanel 统一提供（淡入 + 轻微上移），这里不再重复定义 */
</style>
