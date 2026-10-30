<template>
  <div class="control" :class="{ 'is-boolean': field.type === 'boolean' }">
    <!-- 布尔：滑动开关（无需弹层） -->
    <template v-if="field.type === 'boolean'">
      <button
        class="switch"
        :class="{ on: value === true }"
        type="button"
        role="switch"
        :aria-checked="value === true"
        :aria-label="field.label"
        @click="$emit('update', value !== true)"
      >
        <span class="switch-thumb" />
      </button>
      <span class="switch-text">{{ value === true ? '已开启' : '已关闭' }}</span>
    </template>

    <!-- 其余类型：统一外壳 = 输入区 + 后缀区（单位 / 可读文案 / 测试 / 眼睛 / 弹出） -->
    <div v-else class="shell input-surface" :class="{ 'is-open': panel !== 'none', dirty }">
      <!-- 数值 / 时长：**就是一行输入框 + 只读单位**。
           之前做成了「按钮 → 弹层 → 加减号 / 滚轮 / 拖拽 / 单位下拉」，一半代码是它，
           还因为"步长与单位推导各算各的"滚动时数字乱抖。这东西本该简单。
           输入可带单位（`10s` / `1.5m` / `500ms`），不带单位按当前显示单位算；
           单位由值推导、**只读**（能手选就会产生"显示单位 vs 存库单位"的歧义）。 -->
      <!-- 数值 / 时长：**输入框 + 只读单位**，点框就弹出可视化调整（[−] 输入 [＋]，
           可滚轮/拖动微调）。**不设左侧图标列** —— 只有一部分行能配图标，其余行就得
           留白占位，整列会出现多余缩进（URL / 文本行看着"被推右了"）；
           一列纯输入框，起点才是齐的。
           单位由值推导、**只读**：能手选就会产生"显示单位 vs 存库单位"的歧义。 -->
      <template v-if="isNumberLike">
        <!-- 只读：真正的编辑在弹层里（那里面有输入框 + 加减 + 滚轮/拖动）。
             点这一行（⚙ 或框）都弹出交互 —— 统一入口，也避免"框里能打字、
             弹层又能调，两边各改一半"。 -->
        <input
          :id="inputId"
          class="num"
          type="text"
          readonly
          data-popover-anchor
          spellcheck="false"
          :title="readable"
          :value="valueText"
          @click="togglePanel"
          @keydown.enter.prevent="togglePanel"
        />
        <span v-if="unitOf" class="unit pill pill-muted">{{ unitOf }}</span>
      </template>

      <!-- 其余类型走「直接输入」（数值类不在这里 —— 它们是前面的按钮 + 点开的交互界面） -->
      <template v-else>
        <!-- 多源地址（Mikan / BGM 的多个入口）：可拖拽排序 + 可增删 + 每条单独测。
             顺序是配置的一部分（排在前面的先用），所以不能用一个多行文本框糊过去。 -->
        <SourceListEditor
          v-if="field.type === 'list'"
          :items="listItems"
          :tests="rowTests"
          @update="onListUpdate"
          @test-row="$emit('test-row', $event)"
          @test-all="$emit('test')"
        />

        <!-- 时刻：原生 input[type=time]。图标已隐藏（所有行统一不带图标），
             入口是**点这个框**——直接调浏览器原生的 showPicker()。
             不支持 showPicker 的浏览器会退化成普通聚焦，输入框本身照样能键盘改。 -->
        <input
          v-else-if="field.type === 'time'"
          :id="inputId"
          type="time"
          :value="value || ''"
          @click="openTimePicker"
          @change="$emit('update', $event.target.value)"
        />

        <!-- 密钥：已配置时显示掩码，聚焦后变为可编辑 -->
        <template v-else-if="field.type === 'secret'">
          <input
            :id="inputId"
            :type="showPlain ? 'text' : 'password'"
            :class="{ masked }"
            :value="masked ? MASK : (value ?? '')"
            :readonly="masked"
            :placeholder="field.hasValue ? '' : '未配置'"
            autocomplete="new-password"
            @focus="editing = true"
            @blur="editing = false"
            @input="$emit('update', $event.target.value)"
          />
        </template>

        <!-- 文本 / 地址 / 模型：单行直接输入。前面留**等宽空占位** ——
             上面那些行有左侧图标（数值 ⚙ / 时刻 🕐），这里不占位的话
             一列输入框的起始位置就参差不齐。 -->
        <template v-else>
          <!-- 有可视化候选的行（模型 / 供应商）：点框就弹出来选；
               没有候选的（地址 / 文本）就是普通输入，点了不弹。 -->
          <input
            :id="inputId"
            type="text"
            :value="value ?? ''"
            :placeholder="placeholder"
            spellcheck="false"
            @input="$emit('update', $event.target.value)"
            @click="hasPanel && togglePanel()"
          />
        </template>
      </template>

      <!-- 后缀区 -->
      <button
        v-if="field.type === 'url' || field.type === 'list'"
        class="suffix-btn"
        :class="testState"
        type="button"
        :title="testTitle"
        :disabled="testState === 'testing'"
        @click="$emit('test')"
      >
        <IconPlugConnected v-if="!testState || testState === 'idle'" :size="15" />
        <span v-else-if="testState === 'testing'" class="mini-spinner" />
        <IconCircleCheck v-else-if="testState === 'success'" :size="15" />
        <IconCircleX v-else :size="15" />
      </button>

      <button
        v-else-if="field.type === 'secret'"
        class="suffix-btn"
        type="button"
        :title="showPlain ? '隐藏输入' : '显示输入'"
        :disabled="masked || !value"
        @click="showPlain = !showPlain"
      >
        <IconEye :size="15" />
      </button>

      <button
        v-if="hasPanel"
        class="suffix-btn"
        :class="{ active: panel !== 'none' }"
        type="button"
        data-popover-anchor
        :title="panelTitle"
        :aria-expanded="panel !== 'none'"
        @click="togglePanel"
      >
        <component :is="panelIcon" :size="15" />
      </button>
    </div>

    <!-- 时刻不再有弹层：改用原生 input[type=time]（滚轮/键盘/鼠标都是浏览器原生的） -->

    <!-- 弹层②：数值 / 时长的交互界面
         · **输入框和行外是同一套写法**：显示 `1m 30s` 就照着写 `1m 30s`
           （旧版是「数字 + 单位下拉」，等于让人自己换算，还容易出现"显示 7d、输入框里是 604800000"）
         · 支持鼠标滚轮与左右拖动微调（调超时不该"输入—回车"来回折腾） -->
    <PopoverPanel
      :open="panel === 'number'"
      width="anchor"
      align="right"
      :label="`${field.label} 调整`"
      @close="close"
    >
      <div
        class="stepper"
        @wheel.prevent="onWheel"
        @pointerdown="startDrag"
        @pointermove="onDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
      >
        <button class="step-btn" type="button" :disabled="!canStepDown" aria-label="减" @click="step(-1)">−</button>
        <input
          class="step-input"
          type="text"
          spellcheck="false"
          :placeholder="isDuration ? '7d / 1m 30s / 350ms' : ''"
          :value="editText"
          @input="onEdit"
          @blur="commitEdit"
          @keyup.enter="commitEdit"
        />
        <button class="step-btn" type="button" :disabled="!canStepUp" aria-label="加" @click="step(1)">＋</button>
      </div>
    </PopoverPanel>

    <!-- 弹层③：模型列表（从接口实时获取，取不到则回落手动输入） -->
    <PopoverPanel :open="panel === 'models'" align="right" label="选择模型" @close="close">
      <p class="pop-title">
        可用模型
        <button class="pop-link" type="button" @click="$emit('load-models')">刷新</button>
      </p>
      <p v-if="modelsLoading" class="pop-empty">正在读取模型列表…</p>
      <p v-else-if="!models.length" class="pop-empty">取不到模型列表，可直接手动输入</p>
      <template v-else>
        <button
          v-for="name in models"
          :key="name"
          class="opt wide"
          :class="{ on: name === value }"
          type="button"
          @click="pick(name)"
        >
          {{ name }}
        </button>
      </template>
    </PopoverPanel>

    <!-- 弹层④：供应商预设（选中即填接口地址） -->
    <PopoverPanel :open="panel === 'providers'" align="right" label="选择供应商" @close="close">
      <p class="pop-title">常见供应商</p>
      <button
        v-for="item in providers"
        :key="item.name"
        class="opt wide provider"
        :class="{ on: item.baseUrl === value }"
        type="button"
        @click="pick(item.baseUrl)"
      >
        <span class="provider-name">{{ item.name }}</span>
        <span class="provider-url">{{ item.baseUrl }}</span>
      </button>
    </PopoverPanel>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  IconAdjustmentsHorizontal,
  IconChevronDown,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconEye,
  IconPlugConnected,
} from '@tabler/icons-vue'
import PopoverPanel from '@/components/ui/PopoverPanel.vue'
import SourceListEditor from './SourceListEditor.vue'
import { formatDuration, parseDuration, unitForMs } from '@/utils/duration'

/**
 * 字段控件：输入 + 可视化选择
 * ---------------------------------------------------------------------------
 * 目标是「能用点就别让人打字」，同一套外壳承载几种交互：
 *   · text / url  直接输入；url 后缀带「测试连接」
 *   · list        多源地址：可拖拽排序 / 增删 / 每条单独测（SourceListEditor）
 *   · secret      已配置时显示掩码，聚焦后转为可编辑；后缀带「显示 / 隐藏」
 *   · number      行内显示完整写法（时长 `1m 30s`、其它 `350` + 单位）；
 *                 点开是 [−] 输入 [＋]，**输入框和行外同一套写法**（`7d` / `1m 30s` / `350ms`）
 *   · time        原生 input[type=time]（滚轮/键盘/鼠标/触屏都归浏览器）
 *   · models / providers  后缀按钮弹出候选列表（模型实时取自接口或供应商目录）
 *
 * 时长**显示什么样就能照着填什么样**：让人先换算成 90000 再填，是把机器该干的活推给人。
 */
const props = defineProps({
  /** 后端下发的字段定义 */
  field: { type: Object, required: true },
  /** 当前值（草稿优先，否则是后端生效值） */
  value: { type: [String, Number, Boolean], default: null },
  /** 是否已被改动（决定掩码与高亮） */
  dirty: { type: Boolean, default: false },
  /** 测试连接状态：idle | testing | success | error */
  testState: { type: String, default: 'idle' },
  /** 测试按钮的悬浮说明（含耗时或失败原因） */
  testTitle: { type: String, default: '' },
  /** 可选模型列表（来自 /api/ai/models 或供应商目录） */
  models: { type: Array, default: () => [] },
  modelsLoading: { type: Boolean, default: false },
  /** 供应商清单（来自 /api/ai/providers；取不到时是内置清单） */
  providers: { type: Array, default: () => [] },
  /** 多源列表里每一行的测试结果：url → { state, detail } */
  rowTests: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['update', 'test', 'test-row', 'load-models'])

/**
 * 多源地址：界面是数组、存库是换行文本（`mikan.bases` 的线上格式没变）
 * 空行保留在界面上（刚点「添加一行」时就是空的），提交时后端会滤掉空项。
 */
const listItems = computed(() => String(props.value ?? '').split('\n'))
const onListUpdate = (items) => emit('update', items.join('\n'))


const MASK = '••••••••••••'
const inputId = computed(() => `f-${props.field.path}`)
const placeholder = computed(() => {
  const field = props.field
  if (field.placeholder) return field.placeholder
  const fallback = field.default
  if (fallback === null || fallback === undefined || fallback === '') {
    return field.type === 'url' || field.type === 'list' ? 'https://…' : ''
  }
  return String(fallback)
})

/* ── 弹层开关 ─────────────────────────────────────────────────────────── */

const panel = ref('none')
const isDuration = computed(() => props.field.format === 'duration')
/** 数值型（含时长）——它们有常显的加减号，不需要弹层 */
const isNumberLike = computed(() => props.field.type === 'number')
const panelType = () =>
  props.field.type === 'time' ? 'time' : props.field.type === 'number' ? 'number' : props.field.models ? 'models' : 'providers'
/**
 * 后缀那个「弹出」按钮只给 模型 / 供应商 用。
 * 时刻与数值都有自己的行内按钮打开弹层（`time-btn` / `value-btn`），
 * 后缀再来一个就会出现**两个一样的图标**（时钟+时钟、调整+调整），纯重复。
 */
const hasPanel = computed(() => Boolean(props.field.models) || Boolean(props.field.providers))
const panelIcon = computed(() => {
  if (props.field.type === 'time') return IconClock
  if (props.field.type === 'number') return IconAdjustmentsHorizontal
  return IconChevronDown
})
const panelTitle = computed(() => {
  if (props.field.type === 'time') return '选择常用时刻'
  if (props.field.type === 'number') return isDuration.value ? '可视化选择时长' : '可视化选择数值'
  return props.field.models ? '从接口读取模型列表' : '从预设选择供应商'
})
function togglePanel() {
  panel.value = panel.value === 'none' ? panelType() : 'none'
}
const close = () => {
  panel.value = 'none'
}
function pick(next) {
  emit('update', next)
  close()
}

/* ── 密钥：掩码 ↔ 可编辑 ─────────────────────────────────────────────── */

const editing = ref(false)
const showPlain = ref(false)
/** 已配置 + 未改动 + 未聚焦 → 显示掩码（一眼可见「配过了」，又不暴露内容） */
const masked = computed(() => Boolean(props.field.hasValue) && !props.dirty && !editing.value)

/* ── 时刻：滚轮选择器 ──────────────────────────────────────────────────────
   像时钟那样上下滚动选时/分。用 CSS scroll-snap 做吸附（不需要 JS 动画），
   滚动停下后取离中线最近的那一格提交；中间高亮的就是选中的值。 */

const WHEEL_ITEM = 34 // 单格高度，与 .wheel-item 的 height 保持一致
const pad2 = (n) => String(n).padStart(2, '0')

const hourWheel = ref(null)
const minuteWheel = ref(null)
const timeH = computed(() => Number(String(props.value || '04:00').split(':')[0]) || 0)
const timeM = computed(() => Number(String(props.value || '04:00').split(':')[1]) || 0)
/** 滚轮停在哪一格（滚动中会变，松手后才提交） */
const rollingH = ref(0)
const rollingM = ref(0)

/** 打开时把两列滚到当前值上 */
function syncWheels() {
  rollingH.value = timeH.value
  rollingM.value = timeM.value
  nextTick(() => {
    if (hourWheel.value) hourWheel.value.scrollTop = timeH.value * WHEEL_ITEM
    if (minuteWheel.value) minuteWheel.value.scrollTop = timeM.value * WHEEL_ITEM
  })
}

let scrollTimer = null
function onWheelScroll() {
  const h = hourWheel.value ? Math.round(hourWheel.value.scrollTop / WHEEL_ITEM) : rollingH.value
  const m = minuteWheel.value ? Math.round(minuteWheel.value.scrollTop / WHEEL_ITEM) : rollingM.value
  rollingH.value = Math.min(Math.max(h, 0), 23)
  rollingM.value = Math.min(Math.max(m, 0), 59)
  // 等滚动停下来再提交：滚动过程中每帧都发会把值刷成中间那些格
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => emit('update', `${pad2(rollingH.value)}:${pad2(rollingM.value)}`), 140)
}

/** 点某一格：直接设值并滚到那格（刚拖过就不算点击，避免手一抖选到别的格） */
const pickHour = (h) => {
  if (suppressClick) return
  emit('update', `${pad2(h)}:${pad2(timeM.value)}`)
  nextTick(syncWheels)
}
const pickMinute = (m) => {
  if (suppressClick) return
  emit('update', `${pad2(timeH.value)}:${pad2(m)}`)
  nextTick(syncWheels)
}

/* 滚轮一格 = 一格、拖拽跟手
   ---------------------------------------------------------------------------
   为什么要自己接管滚轮：浏览器一次滚轮事件的 delta 约 100px ≈ 3 格，
   而 scroll-snap 只在滚动**停下后**才吸附 —— 结果就是"滚一下跳四个"，根本选不准。
   拖拽同理：原生滚动区鼠标是拖不动的，得自己按指针位移改 `scrollTop`。 */
function wheelBy(event, which) {
  const el = which === 'h' ? hourWheel.value : minuteWheel.value
  if (!el) return
  el.scrollTop += (event.deltaY < 0 ? -1 : 1) * WHEEL_ITEM
}

let wheelDrag = null
let suppressClick = false
function startWheelDrag(event, which) {
  const el = which === 'h' ? hourWheel.value : minuteWheel.value
  if (!el) return
  wheelDrag = { el, y: event.clientY, top: el.scrollTop }
  el.setPointerCapture?.(event.pointerId)
}
function moveWheelDrag(event) {
  if (!wheelDrag) return
  const delta = event.clientY - wheelDrag.y
  if (Math.abs(delta) > 4) suppressClick = true
  wheelDrag.el.scrollTop = wheelDrag.top - delta
}
function endWheelDrag() {
  if (!wheelDrag) return
  wheelDrag = null
  // 拖拽结束时浏览器还会补一个 click，先压住它（下一帧再放开）
  setTimeout(() => {
    suppressClick = false
  }, 0)
}

watch(
  () => panel.value,
  (next) => {
    if (next === 'time') syncWheels()
  },
)

/* ── 数值 / 时长：两段式（数值 + 单位）+ 滚轮/拖动微调 ────────────────────
   存储永远是毫秒；单位只影响"界面上那个数字"（1s ↔ 1000ms 是同一个值换写法），
   所以换单位不改变总量、只重算显示的数字。 */

const UNITS = [
  { value: 'ms', label: 'ms', factor: 1 },
  { value: 's', label: 's', factor: 1000 },
  { value: 'm', label: 'm', factor: 60000 },
  { value: 'h', label: 'h', factor: 3600000 },
  { value: 'd', label: 'd', factor: 86400000 },
]

const displayUnit = ref('ms')

/**
 * 显示单位**跟着值走**，值一变就重新挑一次
 * ---------------------------------------------------------------------------
 * 必须跟着**值**变，不能只在"切字段"时推导一次：字段先渲染、值后到（或中途被
 * 保存 / 重置 / 步进改掉）时，单位会停在旧值上 —— 于是出现「点进去是 1、外面却是
 * 60000 + m」这种里外不一致。挑单位的规则在 utils/duration.js 的 `unitForMs`，
 * 行外按钮、弹层输入框、步进提示三处**共用同一份**，不再各算各的。
 */
watch(
  () => [props.field.path, props.value],
  () => {
    displayUnit.value = unitForMs(props.value, props.field.unit || 'ms')
  },
  { immediate: true },
)
const unitFactor = computed(() => UNITS.find((u) => u.value === displayUnit.value)?.factor || 1)

const editText = ref('')
const editingNum = ref(false)

/** 把当前值写进输入框（**和行外同一套写法**：`7d` / `1m 30s` / `350ms`） */
function syncEditText() {
  if (!isDuration.value) {
    editText.value = props.value === null || props.value === undefined ? '' : String(props.value)
    return
  }
  editText.value = formatDuration(props.value) || ''
}

/* 换单位 / 换字段 → **无条件**重算：点开弹层看到的第一眼必须和行外一致 */
watch(
  () => [displayUnit.value, props.field.path],
  () => {
    editingNum.value = false
    syncEditText()
  },
  { immediate: true },
)

/* 值被外部改（保存 / 重置 / 步进 / 换字幕组）→ 非编辑态才跟随，别冲掉用户正在敲的字 */
watch(
  () => props.value,
  () => {
    if (editingNum.value) return
    syncEditText()
  },
)

function onEdit(event) {
  editingNum.value = true
  editText.value = event.target.value
}

/**
 * 失焦/回车提交
 * ---------------------------------------------------------------------------
 * 时长：直接按**写出来的单位**解析（`7d` / `1m 30s` / `350ms`）；写不出单位的纯数字按
 * 当前显示单位理解（`90` 在显示为 `s` 时 = 90 秒）。解析不了就回滚 ——
 * 不把垃圾发给后端，也不静默改成别的数。
 */
function commitEdit() {
  editingNum.value = false
  if (!isDuration.value) {
    emit('update', editText.value)
    return
  }
  const parsed = parseDuration(editText.value, unitFactor.value)
  if (parsed === null) {
    syncEditText()
    return
  }
  emit('update', parsed)
}

/* 弹层里的滚轮 / 拖动微调：调一个超时不值得「点开—输入—回车」走一遍 */
let wheelLock = 0
function onWheel(event) {
  const now = Date.now()
  if (now - wheelLock < 90) return // 滚轮事件很密，节流一下
  wheelLock = now
  step(event.deltaY < 0 ? 1 : -1)
}

let drag = null
function startDrag(event) {
  // 输入框 / 下拉 / 按钮上的手势留给它们自己
  if (event.target.closest?.('input, select, button')) return
  drag = { x: event.clientX, value: Number(props.value) || 0 }
  event.currentTarget.setPointerCapture?.(event.pointerId)
}
function onDrag(event) {
  if (!drag) return
  const steps = Math.trunc((event.clientX - drag.x) / 4) // 4px 一档，手感接近音量条
  if (!steps) return
  emit('update', Math.max(drag.value + steps * stepSize.value, props.field.min ?? 0))
}
function endDrag() {
  drag = null
}

/* ── 数值 / 时长 ─────────────────────────────────────────────────────── */

const num = computed(() => Number(props.value))
/**
 * 框内换算结果：时长类显示成 `1s 500ms` 这种人话（其它类型不显示，避免与单位胶囊重复）。
 * 不加「≈」——它就是同一个值的另一种写法，不是估算。
 */
const readable = computed(() =>
  isDuration.value && Number.isFinite(num.value) ? formatDuration(props.value, props.field.unit) : '',
)

/**
 * 行内显示的**值**（时长字段就显示成完整的时长文案）
 * ---------------------------------------------------------------------------
 * 时长统一走 `formatDuration`：`350ms` / `30s` / `1m 30s` / `7d` / `1d 12h`
 * （最多两级单位）。不再拆成「数字 + 单位胶囊」——
 * 那套在 `1d 12h` 这种跨档值上根本摆不下，而且和输入框里的写法对不上。
 * 其它数值仍是原值 + 字段声明的单位。
 */
const valueText = computed(() => {
  const v = props.value
  if (v === null || v === undefined || v === '') return '未设置'
  if (!isDuration.value) return String(v)
  return formatDuration(v) || String(v)
})

/** 单位胶囊：时长已经写在值里（`7d`），再挂个胶囊就是重复，所以只有非时长才有 */
const unitOf = computed(() => (isDuration.value ? '' : props.field.unit || ''))

/**
 * 打开浏览器的时刻选择面板
 * ---------------------------------------------------------------------------
 * 原生 `input[type=time]` 默认只把时钟图标当入口，而我们已经把图标隐藏了
 * （**所有行统一不带图标** —— 只给一行配图标、其余行就得留白占位，整列就不齐了）。
 * 所以入口改成"点输入框就弹"：`showPicker()` 需要在用户手势里调用，click 正好满足。
 * 浏览器不支持时抛错，这里吞掉即可 —— 退化成普通聚焦，键盘依然能改时间。
 */
function openTimePicker(event) {
  try {
    event.target.showPicker?.()
  } catch {
    /* 不支持 / 手势不符：不影响输入 */
  }
}

/**
 * 数值输入框提交
 * ---------------------------------------------------------------------------
 * 写 `31` → 按当前显示单位算（显示 `m` 就是 31 分钟）；写 `2m` / `500ms` / `1.5h`
 * → 按写出来的单位算。两种写法都认（`parseDuration` 就是干这个的），
 * 解析不了就**保留原值**，不把垃圾发给后端。
 */
function commitNum(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return props.value
  const parsed = parseDuration(raw, unitFactor.value)
  return parsed === null ? props.value : parsed
}
/**
 * 加减的步长
 * ---------------------------------------------------------------------------
 * 时长：**一档 = 一个当前显示单位**（显示 `m` 就 ±1 分钟、显示 `h` 就 ±1 小时）。
 * 为什么必须这样（踩过）：步长若不是当前单位的整数倍，滚一下就会得到"除不尽"的值，
 * 而显示单位是**按能不能整除推导**的 —— 于是 30 m 滚一下变成 1830 s（数字暴涨），
 * 再滚一下又凑巧整除跳回 31 m，数字和单位一起抖，看着就像坏了。
 * 步长按单位给，值永远是整数个单位，单位自然就稳住了。
 * 毫秒档太细（1ms），用 100ms 一档（350 → 450 仍是有意义的一步）。
 * 其它数字按数量级（1 / 10 / 100）—— 让「点一下」每次都是有意义的一步。
 */
const stepSize = computed(() => {
  if (isDuration.value) {
    const factor = UNITS.find((u) => u.value === displayUnit.value)?.factor || 1
    return Math.max(factor, 100)
  }
  const abs = Math.abs(num.value || 0)
  if (abs >= 1000) return 100
  if (abs >= 100) return 10
  return 1
})
const stepHint = computed(() =>
  isDuration.value ? formatDuration(stepSize.value) : `${stepSize.value}${props.field.unit ? ` ${props.field.unit}` : ''}`,
)
const canStepUp = computed(
  () => props.field.max === undefined || !Number.isFinite(num.value) || num.value + stepSize.value <= props.field.max,
)
const canStepDown = computed(() => {
  const floor = props.field.min ?? 0
  return !Number.isFinite(num.value) || num.value - stepSize.value >= floor
})
function step(dir) {
  const base = Number.isFinite(num.value) ? num.value : (props.field.min ?? 0)
  emit('update', Math.max(base + dir * stepSize.value, props.field.min ?? 0))
}
</script>

<style scoped>
/* 控件容器：relative 供弹层定位；布尔与其它类型共用同一行高 */
.control {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.control.is-boolean {
  gap: 10px;
}

/* ── 外壳：输入区 + 后缀区（表面样式来自全局 .input-surface）──────────── */
.shell {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 40px;
  padding: 0 6px 0 0;
}
.shell.dirty {
  border-color: var(--accent);
}
.shell.is-open {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.shell input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 12px;
  border: none;
  background: none;
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 0.88rem;
}
.shell input:focus {
  outline: none;
}
.shell input::placeholder {
  color: var(--text-tertiary);
}
.shell input.num {
  font-family: var(--font-mono);
  font-size: 0.84rem;
  text-align: right;
}
/* 密钥掩码：等距点号，一眼看出「已配置」而不是空白 */
/* 行首图标列已**取消**：只有一部分行配得起图标，其余行就得留白占位，
   整列会出现多余缩进（URL / 文本行看着"被推右了"）。
   现在一列纯输入框 —— 起点天然对齐。
   时刻行用原生控件自带的时钟图标（那就是弹出入口），数值/时长行点输入框弹层。 */
/* 时刻：隐藏 input[type=time] 自带的时钟图标 —— **所有行都不带图标**（要么全有要么全无，
   只给一行配图标、其余行就得留白占位，整列立刻不齐）。入口改成"点输入框就弹面板"，
   见 FieldControl 的 openTimePicker（showPicker）。 */
.shell input[type='time']::-webkit-calendar-picker-indicator {
  display: none;
}

/* 输入区：**所有** input 都要撑满外壳、撑满高度。
   ---------------------------------------------------------------------------
   原生控件的默认宽度是"按内容算"的（input[type=time] 尤其明显），放进 flex 外壳里会
   塌成很细的一条 —— 看着就是"交互不见了"。以前是哪个类型的控件不见了就给哪个补一条，
   结果按下葫芦浮起瓢（补了时刻、又漏了数值）。现在统一在这里兜住。 */
.shell input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 12px;
  color: var(--text-primary);
  color-scheme: inherit;
  font-family: var(--font-mono);
  font-size: 0.84rem;
}
.shell input.masked {
  color: var(--text-secondary);
  letter-spacing: 0.14em;
  cursor: text;
}

/* ── 数值 / 时长：行内是一个按钮，点了才展开交互界面 ───────────────────── */
.value-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  height: 100%;
  padding: 0 12px;
  color: var(--text-primary);
  font-size: 0.88rem;
  text-align: left;
}
.value-btn svg {
  flex-shrink: 0;
  color: var(--text-tertiary);
}
.value-text {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.84rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 交互界面（弹层里）：[−] 输入 [＋] */
.stepper {
  display: flex;
  align-items: center;
  gap: 6px;
}
.step-btn {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 1rem;
  line-height: 1;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.step-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.step-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.step-input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.step-input:focus {
  border-color: var(--accent);
  outline: none;
}
/* 单位下拉：两段式的那一段（数值 + 单位） */
.step-unit {
  flex-shrink: 0;
  height: 34px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.8rem;
}
.step-unit:focus {
  border-color: var(--accent);
  outline: none;
}
/* 单位气泡在行内按钮里靠右对齐（一列字段的单位能对齐着读） */
.value-btn .unit {
  margin-left: auto;
}
/* 弹层底部的说明（人话写法 + 单位） */
.pop-hint {
  margin-top: 8px;
  color: var(--text-tertiary);
  font-size: 0.72rem;
  line-height: 1.5;
}

/* 时刻：点开的按钮（显示当前值），不是原生控件 */
.time-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  height: 100%;
  padding: 0 12px;
  color: var(--text-primary);
  font-size: 0.88rem;
  text-align: left;
}
.time-btn svg {
  color: var(--text-tertiary);
}
.time-text {
  font-family: var(--font-mono);
  font-size: 0.84rem;
  font-variant-numeric: tabular-nums;
}
/* 时长输入：等宽字体，`1.5m` 这种写法对齐着看得清 */
.shell input.dur {
  font-family: var(--font-mono);
  font-size: 0.84rem;
}

/* 框内可读文案（时长换算结果）与单位胶囊 */
.readable {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-size: 0.72rem;
  white-space: nowrap;
}
.unit {
  flex-shrink: 0;
  margin-right: 2px;
}

/* 后缀按钮：测试连接 / 显示隐藏 / 可视化选择 */
.suffix-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border-radius: var(--radius-pill);
  color: var(--text-tertiary);
  transition: color var(--dur-fast), background var(--dur-fast);
}
.suffix-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--accent);
}
.suffix-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.suffix-btn.active {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
/* 测试三态（颜色走令牌） */
.suffix-btn.testing {
  color: var(--status-warning);
  animation: field-glow 1.2s ease-in-out infinite;
}
.suffix-btn.success {
  color: var(--status-success);
}
.suffix-btn.error {
  color: var(--status-danger);
  animation: field-shake 0.4s ease;
}
@keyframes field-glow {
  0%,
  100% {
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  50% {
    box-shadow: 0 0 0 5px var(--accent-soft);
  }
}
@keyframes field-shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-3px);
  }
  50% {
    transform: translateX(3px);
  }
  75% {
    transform: translateX(-2px);
  }
}
.mini-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--border);
  border-top-color: var(--status-warning);
  border-radius: 50%;
  animation: field-spin 0.6s linear infinite;
}
@keyframes field-spin {
  to {
    transform: rotate(1turn);
  }
}

/* ── 滑动开关 ─────────────────────────────────────────────────────────── */
.switch {
  display: flex;
  align-items: center;
  width: 44px;
  height: 24px;
  padding: 2px;
  flex-shrink: 0;
  border: none;
  border-radius: 12px;
  background: var(--border-strong);
  cursor: pointer;
  transition: background var(--dur);
}
.switch.on {
  background: var(--accent);
}
.switch-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--text-invert);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur) var(--ease-out);
}
.switch.on .switch-thumb {
  transform: translateX(20px);
}
.switch-text {
  color: var(--text-tertiary);
  font-size: 0.78rem;
}

/* ── 弹层内容：小标题 / 选项 / 网格 / 步进 ────────────────────────────── */
.pop-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 6px 4px 6px;
  color: var(--text-tertiary);
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.08em;
}
.pop-link {
  color: var(--accent);
  font-size: 0.68rem;
}
.pop-link:hover {
  color: var(--accent-strong);
}
.pop-empty {
  padding: 10px 6px;
  color: var(--text-tertiary);
  font-size: 0.76rem;
  line-height: 1.5;
}
.opt {
  width: 34px;
  height: 30px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.opt:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.opt.on {
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}
.opt.wide {
  display: flex;
  width: 100%;
  height: auto;
  padding: 7px 10px;
  justify-content: flex-start;
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
  font-size: 0.8rem;
  text-align: left;
}
/* ── 时刻滚轮：一屏 5 格，中间那格是选中项（scroll-snap 吸附）─────────── */
.wheels {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
/* 中间高亮带：告诉人「停在这一格算选中」 */
.wheels::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 34px;
  transform: translateY(-50%);
  border-radius: var(--radius-sm);
  background: var(--accent-mist);
  pointer-events: none;
}
.wheel {
  position: relative;
  height: 170px; /* 34 × 5 格 */
  overflow-y: auto;
  scroll-snap-type: y mandatory;
  overscroll-behavior: contain; /* 滚到头上别把整页带着滚 */
  touch-action: none; /* 拖拽由 JS 接管，别让浏览器抢去当滚动 */
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.wheel::-webkit-scrollbar {
  display: none;
}
/* 上下留白 = (170 − 34) / 2，让首尾项也能滚到正中 */
.wheel-pad {
  display: block;
  height: 68px;
}
.wheel-item {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 34px;
  scroll-snap-align: center;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 0.95rem;
  transition: color var(--dur-fast);
}
.wheel-item.on {
  color: var(--accent-strong);
  font-weight: 600;
}
.wheel-colon {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

/* 数值 / 时长的常用值网格（number 面板用） */
.grid-presets {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px;
}

.stepper {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
}
.step-btn {
  width: 30px;
  height: 26px;
  border-radius: var(--radius-sm);
  background: var(--bg-dropdown);
  color: var(--text-secondary);
  font-size: 1rem;
  line-height: 1;
}
.step-btn:hover:not(:disabled) {
  color: var(--accent);
}
.step-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.step-value {
  color: var(--text-primary);
  font-size: 0.82rem;
}
/* 多值地址输入框（Mikan / BGM 多源）：等宽、可换行、行高紧凑 —— 「一行一个」要看得出行 */
.list-input {
  width: 100%;
  min-height: 66px;
  padding: 7px 9px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.55;
  resize: vertical;
}
.list-input::placeholder {
  color: var(--text-tertiary);
}
.list-input:focus-visible {
  outline: none;
}

/* 供应商选项：名字 + 地址两行 */
.provider {
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
.provider-name {
  color: inherit;
  font-size: 0.8rem;
}
.provider-url {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 0.68rem;
}
</style>
