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
        <!-- 提供商：**选名字**，不是填 URL。点开是带搜索的目录（199 家 + 自定义） -->
        <button
          v-if="field.type === 'provider'"
          class="value-btn"
          :class="{ empty: !providerLabel }"
          type="button"
          data-popover-anchor
          @click="togglePanel"
        >
          <span class="value-text">{{ providerLabel }}</span>
          <IconChevronDown :size="14" />
        </button>

        <!-- 多源地址（Mikan / BGM 的多个入口）：可拖拽排序 + 可增删 + 每条单独测。
             顺序是配置的一部分（排在前面的先用），所以不能用一个多行文本框糊过去。 -->
        <SourceListEditor
          v-else-if="field.type === 'list'"
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
         · **时长 = 多列滚轮**（按量级自动选列）：`xx s xx ms` / `xx m xx s` / `xx h xx m` / `xx d xx h xx m`
           —— 滚动选数字，不让人心算毫秒，也不再有"输入框里是 604800000"这种事
         · 其它数值：`[−] 输入 [＋]`，可滚轮 / 拖动微调 -->
    <PopoverPanel
      :open="panel === 'number'"
      width="anchor"
      align="right"
      :label="`${field.label} 调整`"
      @close="close"
    >
      <!-- 时长：多列滚轮 -->
      <div v-if="isDuration" class="wheels dur">
        <template v-for="col in durCols" :key="col.unit">
          <div
            :ref="(el) => setWheel(col.unit, el)"
            class="wheel"
            @scroll="onDurScroll"
            @wheel.prevent="durStep($event, col)"
            @pointerdown="startDurDrag($event, col)"
            @pointermove="onDurDrag"
            @pointerup="endDurDrag"
            @pointercancel="endDurDrag"
          >
            <span class="wheel-pad" />
            <span
              v-for="n in col.values"
              :key="n"
              class="wheel-item"
              :class="{ on: durValue[col.unit] === n }"
            >
              {{ n }}
            </span>
            <span class="wheel-pad" />
          </div>
          <span class="wheel-unit">{{ col.unit }}</span>
        </template>
      </div>

      <!-- 其它数值：输入框 + 加减 -->
      <div
        v-else
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
          :value="editText"
          @input="onEdit"
          @blur="commitEdit"
          @keyup.enter="commitEdit"
        />
        <button class="step-btn" type="button" :disabled="!canStepUp" aria-label="加" @click="step(1)">＋</button>
      </div>
      <p v-if="isDuration" class="pop-hint">{{ readable }}</p>
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

    <!-- 弹层⑤：提供商目录（搜索 + 自定义） -->
    <PopoverPanel :open="panel === 'provider'" align="right" label="选择提供商" @close="close">
      <p class="pop-title">
        提供商
        <span class="pop-note">{{ providerList.length }} 个</span>
      </p>
      <input
        v-model="providerQuery"
        class="pop-search"
        type="text"
        spellcheck="false"
        placeholder="搜索名称或地址"
      />
      <div class="pop-list">
        <button
          v-for="item in providerMatches"
          :key="`${item.name}-${item.baseUrl}`"
          class="opt wide provider"
          :class="{ on: isCurrentProvider(item) }"
          type="button"
          @click="chooseProvider(item)"
        >
          <span class="provider-name">{{ item.name }}</span>
          <span class="provider-url">{{ item.baseUrl }}</span>
        </button>
        <p v-if="!providerMatches.length" class="pop-empty">没找到 —— 换个关键词，或直接添加自定义</p>

        <!-- **列表最后一行就是「添加」**：点它才出现名称输入（不再在底部常驻一个输入框 + 按钮） -->
        <div v-if="addingCustom" class="pop-add">
          <input
            ref="customInput"
            v-model="newProviderName"
            class="pop-input"
            type="text"
            spellcheck="false"
            placeholder="自定义名称（例如：我家网关）"
            @keyup.enter="createCustom"
            @keyup.esc="cancelCustom"
          />
          <button class="src-btn success" type="button" title="保存" @click="createCustom">
            <IconCheck :size="15" />
          </button>
          <button class="src-btn" type="button" title="取消" @click="cancelCustom">
            <IconX :size="15" />
          </button>
        </div>
        <button v-else class="opt wide provider add" type="button" @click="startCustom">
          <span class="provider-name"><IconPlus :size="14" /> 添加自定义</span>
          <span class="provider-url">给当前接口地址起个名字</span>
        </button>
      </div>
    </PopoverPanel>

    <!-- 弹层④：旧的「供应商预设」已并入上面的**提供商目录**（那个带搜索、还能自定义），
         这里不再保留第二份下拉 —— 同一件事只留一个入口。 -->
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  IconAdjustmentsHorizontal,
  IconCheck,
  IconChevronDown,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconEye,
  IconPlugConnected,
  IconPlus,
  IconX,
} from '@tabler/icons-vue'
import PopoverPanel from '@/components/ui/PopoverPanel.vue'
import SourceListEditor from './SourceListEditor.vue'
import { formatDuration, unitForMs } from '@/utils/duration'

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
  /** 自定义提供商：[{ name, baseUrl }]（来自 ai.customProviders） */
  customProviders: { type: Array, default: () => [] },
  /** 当前生效的接口地址（新建自定义时用它） */
  baseUrl: { type: String, default: '' },
  /** 多源列表里每一行的测试结果：url → { state, detail } */
  rowTests: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['update', 'test', 'test-row', 'pick-provider', 'save-custom-provider', 'load-models'])

/**
 * 多源地址：界面是数组、存库是换行文本（`mikan.bases` 的线上格式没变）
 * 空行保留在界面上（刚点「添加一行」时就是空的），提交时后端会滤掉空项。
 */
const listItems = computed(() => String(props.value ?? '').split('\n'))
const onListUpdate = (items) => emit('update', items.join('\n'))

/* ── 提供商：目录（models.dev）+ 自定义 ──────────────────────────────────
   下拉里是 **199 家 + 自定义**，所以必须有搜索框（滚一屏找一个供应商不现实）。
   选中 = 同时写「提供商名」与「接口地址」；「新建自定义」= 把**当前地址**起个名字。 */
const providerQuery = ref('')
const newProviderName = ref('')
const addingCustom = ref(false)
const customInput = ref(null)
const normBase = (url) => String(url || '').trim().toLowerCase().replace(/\/+$/, '')

/** 自定义排前面（自己配的通常就是最常用的那个）；目录项带上它自带的模型名 */
const providerList = computed(() => [
  ...props.customProviders.map((p) => ({ name: p.name, baseUrl: p.baseUrl, models: [] })),
  ...props.providers.map((p) => ({ name: p.name, baseUrl: p.baseUrl, models: p.models || [] })),
])

const providerMatches = computed(() => {
  const q = providerQuery.value.trim().toLowerCase()
  const list = q
    ? providerList.value.filter((p) => `${p.name} ${p.baseUrl}`.toLowerCase().includes(q))
    : providerList.value
  return list.slice(0, 80)
})

/** 行内显示的名字：优先用存下来的提供商名，其次按地址反查，最后「未选择」 */
const providerLabel = computed(() => {
  const name = String(props.value || '').trim()
  if (name) return name
  const matched = providerList.value.find((p) => normBase(p.baseUrl) === normBase(props.baseUrl))
  return matched?.name || ''
})

const isCurrentProvider = (item) =>
  normBase(item.baseUrl) === normBase(props.baseUrl) ||
  (Boolean(props.value) && item.name === String(props.value).trim())

function chooseProvider(item) {
  // 选提供商时把"这一家自己带的模型名"一起带过去，让下面的模型能自动补齐
  emit('pick-provider', { name: item.name, baseUrl: item.baseUrl, models: item.models || [] })
  providerQuery.value = ''
  close()
}

function startCustom() {
  addingCustom.value = true
  providerQuery.value = ''
  nextTick(() => customInput.value?.focus())
}

function cancelCustom() {
  addingCustom.value = false
  newProviderName.value = ''
}

function createCustom() {
  const name = newProviderName.value.trim()
  if (!name) return
  emit('save-custom-provider', { name, baseUrl: props.baseUrl })
  newProviderName.value = ''
  addingCustom.value = false
  close()
}


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
const panelType = () => {
  if (props.field.type === 'provider') return 'provider'
  if (props.field.type === 'time') return 'time'
  if (props.field.type === 'number') return 'number'
  return props.field.models ? 'models' : 'none'
}
/**
 * 后缀那个「弹出」按钮只给 模型 / 供应商 用。
 * 时刻与数值都有自己的行内按钮打开弹层（`time-btn` / `value-btn`），
 * 后缀再来一个就会出现**两个一样的图标**（时钟+时钟、调整+调整），纯重复。
 */
const hasPanel = computed(() => Boolean(props.field.models) || props.field.type === 'provider')
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

/* ── 时长：多列滚轮 ─────────────────────────────────────────────────────────
   为什么是滚轮：时长跨度从 350ms 到 7 天，让人"心算毫秒"或者"输入 1m 30s"都是在跟机器较劲；
   滚轮是**可滚动的数字列**，一眼看到 `7 d 0 h 0 m`，手指一动就改。
   列按量级自动选（用户要的就是这个形状）：
     < 1 分钟   → `s ms`
     < 1 小时   → `m s`
     < 1 天     → `h m`
     ≥ 1 天     → `d h m`
   高位优先：`durValue` 按列从大到小扣减，保证 7 天不会显示成 `168 h`。 */
const DUR_FACTOR = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 }
const DUR_TIERS = [
  { limit: 60_000, cols: [['s', 59, 1], ['ms', 990, 10]] },
  { limit: 3_600_000, cols: [['m', 59, 1], ['s', 59, 1]] },
  { limit: 86_400_000, cols: [['h', 23, 1], ['m', 59, 1]] },
  { limit: Infinity, cols: [['d', 90, 1], ['h', 23, 1], ['m', 59, 1]] },
]

const durCols = computed(() => {
  const ms = Number(props.value) || 0
  const tier = DUR_TIERS.find((t) => ms < t.limit) || DUR_TIERS[DUR_TIERS.length - 1]
  return tier.cols.map(([unit, max, step]) => ({
    unit,
    step,
    max,
    values: Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step),
  }))
})

/** 当前值拆到各列（高位优先扣减） */
const durValue = computed(() => {
  let rest = Math.max(0, Number(props.value) || 0)
  const out = {}
  for (const col of durCols.value) {
    const factor = DUR_FACTOR[col.unit]
    const n = Math.min(Math.floor(rest / factor), col.max)
    out[col.unit] = Math.floor(n / col.step) * col.step
    rest -= out[col.unit] * factor
  }
  return out
})

const wheelEls = new Map()
function setWheel(unit, el) {
  if (el) wheelEls.set(unit, el)
  else wheelEls.delete(unit)
}

/** 打开弹层 / 值被外部改 → 把每列滚到当前值（不要在滚动中调用，否则会跟手指打架） */
function syncDurWheels() {
  nextTick(() => {
    for (const col of durCols.value) {
      const el = wheelEls.get(col.unit)
      if (!el) continue
      el.scrollTop = ((durValue.value[col.unit] || 0) / col.step) * WHEEL_ITEM
    }
  })
}
watch(
  () => panel.value,
  (next) => {
    if (next === 'number' && isDuration.value) syncDurWheels()
  },
)
watch(
  () => [props.field.path, props.value],
  () => {
    if (panel.value === 'number' && isDuration.value) syncDurWheels()
  },
)

/** 滚动停下（140ms 内不再滚）再提交，避免每帧都发 */
let durTimer = null
function onDurScroll() {
  clearTimeout(durTimer)
  durTimer = setTimeout(() => {
    let total = 0
    for (const col of durCols.value) {
      const el = wheelEls.get(col.unit)
      const index = el ? Math.round(el.scrollTop / WHEEL_ITEM) : 0
      const n = Math.min(Math.max(index * col.step, 0), col.max)
      total += n * DUR_FACTOR[col.unit]
    }
    emit('update', total)
  }, 140)
}

/** 滚轮一格 = 一格（浏览器一次 wheel ≈ 3 格，自己接管才选得准） */
function durStep(event, col) {
  const el = wheelEls.get(col.unit)
  if (!el) return
  el.scrollTop += (event.deltaY < 0 ? -1 : 1) * WHEEL_ITEM
}

/* 拖拽跟手：原生滚动区鼠标拖不动，得自己按位移改 scrollTop */
let durDrag = null
function startDurDrag(event, col) {
  const el = wheelEls.get(col.unit)
  if (!el) return
  durDrag = { el, y: event.clientY, top: el.scrollTop }
  el.setPointerCapture?.(event.pointerId)
}
function onDurDrag(event) {
  if (!durDrag) return
  durDrag.el.scrollTop = durDrag.top - (event.clientY - durDrag.y)
}
function endDurDrag() {
  durDrag = null
}

const editText = ref('')
const editingNum = ref(false)

/** 数值类（到这里的只剩非时长）写进输入框 */
function syncEditText() {
  editText.value = props.value === null || props.value === undefined ? '' : String(props.value)
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
 * 数值输入框提交（时长走滚轮，不再经过这里）
 * 解析不了就回滚 —— 不把垃圾发给后端，也不静默改成别的数。
 */
function commitEdit() {
  editingNum.value = false
  emit('update', editText.value)
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
 * 加减的步长
 * ---------------------------------------------------------------------------
 * 时长走滚轮，不经过这里；这里只服务普通数值：
 * 按数量级给步长（1 / 10 / 100），让「点一下」每次都是有意义的一步。
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
/* 多源地址那一格：里面是**多行列表**，不能再钉死 40px 高（否则行会溢出、被裁掉/压住） */
.shell.is-list {
  height: auto;
  min-height: 40px;
  align-items: stretch;
  padding: 4px 6px;
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
  /* 拖动时不能把数字当文字选走（选中一片数字非常难看） */
  user-select: none;
  -webkit-user-select: none;
  scroll-behavior: smooth;
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
  user-select: none;
  -webkit-user-select: none;
  /* 选中项放大一点点 + 变色：滚到时能"看出来它在动"，不是硬跳 */
  transition:
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out),
    opacity var(--dur-fast) var(--ease-out);
}
.wheel-item.on {
  color: var(--accent-strong);
  font-weight: 600;
  transform: scale(1.12);
}
/* 相邻两格淡一点：中间那格更"聚焦" */
.wheel-item:not(.on) {
  opacity: 0.75;
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

/* 提供商：整行是一个按钮（显示选中的名字 + 下拉箭头） */
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
.value-btn .value-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.value-btn svg {
  color: var(--text-tertiary);
}

/* ── 提供商目录弹层：搜索 + 列表 + 新建自定义 ──────────────────────────── */
.pop-note {
  margin-left: 6px;
  color: var(--text-tertiary);
  font-size: 0.7rem;
}
.pop-search {
  width: 100%;
  height: 30px;
  margin-bottom: 6px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 0.78rem;
}
.pop-search:focus {
  border-color: var(--accent);
  outline: none;
}
.pop-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* 列表里最后一行「添加自定义」：虚线框 + 图标，一眼看出是"新增"而不是某个供应商 */
.opt.add {
  margin-top: 2px;
  border: 1px dashed var(--border);
  color: var(--text-secondary);
}
.opt.add:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.opt.add .provider-name {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
/* 展开后的"填名称"一行（贴着列表底部，不再单独占一块） */
.pop-add {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  padding: 4px;
  border: 1px dashed var(--accent);
  border-radius: var(--radius-sm);
}
.pop-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 0.76rem;
}
.pop-input:focus {
  border-color: var(--accent);
  outline: none;
}
.pop-link:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
/* 提供商未选时给个灰字，别让它看着像已配置 */
.value-btn.empty .value-text {
  color: var(--text-tertiary);
}

/* ── 时长滚轮：多列数字（`7 d 0 h 0 m`），列按量级自动增减 ─────────────── */
.wheels.dur {
  gap: 2px;
}
/* 列与单位标签成组：数字在左、单位在右，多列时像 `7 d 0 h 0 m` 那样读 */
.wheel-unit {
  display: flex;
  align-items: center;
  padding-right: 6px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  user-select: none;
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
