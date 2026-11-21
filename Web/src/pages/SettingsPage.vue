<template>
  <div class="settings scroll-area">
    <!-- ── 吸顶栏：与首页/发现页同一套（.topbar-surface 实色 + 底边线，sticky）── -->
    <header class="topbar topbar-surface">
      <div class="page-head">
        <h1 class="page-title">设置</h1>
        <div class="head-actions">
          <div class="mode-switch" role="group" aria-label="显示范围">
            <button
              class="mode-side"
              :class="{ on: !showAdvanced }"
              type="button"
              :aria-pressed="!showAdvanced"
              title="只显示必要配置（不填就用不了 / 必须按环境改的）"
              @click="showAdvanced = false"
            >
              基础
            </button>
            <button
              class="mode-side"
              :class="{ on: showAdvanced }"
              type="button"
              :aria-pressed="showAdvanced"
              :title="hiddenAdvancedCount ? `展开 ${hiddenAdvancedCount} 项调参项（超时 / 缓存 / 并发…）` : '显示全部可调参数'"
              @click="showAdvanced = true"
            >
              高级
              <!-- 基础模式下，改过的项也一起被收起来了 —— 给个角标交代，别让人找不到 -->
              <span v-if="changedInAdvanced" class="mode-badge">{{ changedInAdvanced }}</span>
            </button>
          </div>

          <span v-if="dirtyCount" class="pill pill-accent">{{ dirtyCount }} 项未保存</span>
          <!-- 导出只有一份：带上密钥才是「换个地方接着用」的完整备份（脱敏版导出去没法用） -->
          <button
            class="mini-btn"
            type="button"
            :disabled="saving"
            title="导出整份配置（含密钥）：换地方导入就能接着用 —— 这个文件别外传"
            @click="onExport(true)"
          >
            <IconDownload :size="13" /> 导出
          </button>
          <button class="mini-btn" type="button" :disabled="saving" @click="onResetAll">
            <IconRestore :size="13" /> 全部还原
          </button>
        </div>
      </div>
    </header>
    <p v-if="message" class="page-message">{{ message }}</p>

    <!-- ── 三态：用全站统一的 StateBlock（与首页/面板同一套占位）───────── -->
    <StateBlock v-if="loading" state="loading" text="加载配置..." />
    <StateBlock
      v-else-if="error && !data"
      state="error"
      :text="error.message"
      retry-text="重试"
      @retry="load"
    />
    <StateBlock v-else-if="!data" state="empty" text="没有读到配置" retry-text="重试" @retry="load" />

    <!-- ── 卡片 = 分组；卡片内按小节分块；块内字段是「标签在上、控件在下」的多列网格 ── -->
    <div v-else class="cards">
      <template v-for="group in groups" :key="group.key">
        <section class="card card-surface">
        <header class="card-head">
          <h2 class="card-title">
            <component :is="GROUP_ICONS[group.key]" :size="19" />
            {{ group.label }}
          </h2>
          <span v-if="dirtyPathsOf(group).length" class="pill pill-accent">{{ dirtyPathsOf(group).length }} 项</span>
          <p class="card-hint">{{ group.hint }}</p>
        </header>

        <div v-for="section in group.sections" :key="section.key" class="section">
          <h3 v-if="section.label" class="section-title">{{ section.label }}</h3>

          <div class="fields">
            <div
              v-for="field in section.fields"
              :key="field.path"
              class="field"
              :class="{ dirty: isDirty(field), wide: field.type === 'url' || field.type === 'text' || field.type === 'list' }"
            >
              <div class="field-head">
                <label class="field-label" :for="`f-${field.path}`" :title="field.hint || ''">{{ field.label }}</label>
                <span v-if="field.restart" class="field-flag" title="保存后需要重启服务才生效">
                  <IconRefresh :size="12" />
                </span>
                <span class="field-actions">
                  <button v-if="isDirty(field)" class="mini-link" type="button" @click="revert(field.path)">
                    撤销
                  </button>
                  <button
                    v-else-if="field.overridden"
                    class="mini-link"
                    type="button"
                    :disabled="saving"
                    @click="resetOne(field.path)"
                  >
                    还原
                  </button>
                </span>
              </div>

              <FieldControl
                :field="field"
                :value="valueOf(field)"
                :dirty="isDirty(field)"
                :test-state="testStates[field.path] || 'idle'"
                :test-title="testTitle(field)"
                :models="models"
                :models-loading="modelsLoading"
                :providers="providers"
                :base-url="aiBaseUrl"
                :has-key="aiKeyConfigured"
                :row-tests="rowTests[field.path] || {}"
                @update="setValue(field.path, $event)"
                @test="testField(field.path, valueOf(field))"
                @test-row="testRow(field.path, $event)"
                @pick-provider="pickProvider"
                @load-models="loadModels"
              />

              <p
                v-if="fieldFootText(field)"
                class="field-foot"
                :class="{ ok: testStates[field.path] === 'success', bad: testStates[field.path] === 'error' }"
              >
                {{ fieldFootText(field) }}
              </p>
            </div>
          </div>
        </div>

        <div class="card-save">
          <button
            class="save-btn"
            :class="{ saving: savingKey === group.key, ok: savedKey === group.key, idle: unchangedKey === group.key }"
            type="button"
            :disabled="saving"
            @click="saveGroup(group)"
          >
            <IconCheck v-if="savedKey === group.key" :size="15" class="save-check-icon" />
            {{ saveText(group) }}
          </button>
        </div>
      </section>

      <!-- 提示词放在 AI 卡片下面：它是 AI 的外置配置（只读查看 + 恢复默认），
           不参与上面那套「分组保存」——改动直接写 data/prompts.json，立即生效。 -->
      <PromptEditor v-if="group.key === 'ai'" />
      <!-- 离线数据：dump 的**手动更新**放在这一组最后（它属于这个分组的动作，不是一个配置项） -->
      <DumpPanel v-if="group.key === 'dump'" />
      <!-- 身份映射：与 dump 互补（dump 给档案内容，这张卡给 mikan↔bgm 身份） -->
      <MapScanPanel v-if="group.key === 'dump'" />
      <!-- MCP：开关是这一组的字段，端点/令牌/客户端片段是「拿到手就能用」的部分 -->
      <McpPanel v-if="group.key === 'mcp'" />
      </template>

      <!-- ── 导入 / 分享：导出在上面，导入这里 ─────────────────────────── -->
      <section class="card card-surface">
        <header class="card-head">
          <h2 class="card-title"><IconUpload :size="19" /> 导入 / 分享配置</h2>
          <p class="card-hint">粘贴别人导出的 JSON，或选文件；有不合法项会整包拒绝，不会改一半</p>
        </header>

        <textarea
          v-model="importText"
          class="import-text"
          rows="5"
          spellcheck="false"
          placeholder='{ "kind": "soraikahub-settings", "version": 1, "values": { ... } }'
        />

        <div class="import-actions">
          <input class="file" type="file" accept=".json,application/json" @change="onPickFile" />
          <label class="radio">
            <input v-model="importMode" type="radio" value="merge" />
            合并（只覆盖文件里的项）
          </label>
          <label class="radio">
            <input v-model="importMode" type="radio" value="replace" />
            覆盖（先清空已有设置）
          </label>
          <button class="mini-btn primary" type="button" :disabled="!importText.trim() || saving" @click="onImport">
            导入
          </button>
        </div>
        <p v-if="importError" class="error-text">{{ importError }}</p>
      </section>

      <!-- ── 只读的启动参数 ────────────────────────────────────────────── -->
      <section class="card card-surface">
        <header class="card-head">
          <h2 class="card-title"><IconTerminal2 :size="19" /> 启动参数（只读）</h2>
          <p class="card-hint">这两项由启动命令决定（PORT / DB_FILE），要改请改了启动参数再重启</p>
        </header>
        <div class="readonly-grid">
          <div v-for="item in data.readonly" :key="item.path" class="readonly-item">
            <span class="field-label">{{ item.label }}</span>
            <code class="readonly-value input-surface">{{ item.value ?? '—' }}</code>
            <span class="readonly-env">{{ item.env }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import {
  IconAlertTriangle,
  IconBrain,
  IconCheck,
  IconClockHour4,
  IconCloudDownload,
  IconDatabase,
  IconDownload,
  IconPlugConnected,
  IconRefresh,
  IconRestore,
  IconTerminal2,
  IconUpload,
  IconWorld,
} from '@tabler/icons-vue'
import FieldControl from '@/components/settings/FieldControl.vue'
import DumpPanel from '@/components/settings/DumpPanel.vue'
import MapScanPanel from '@/components/settings/MapScanPanel.vue'
import McpPanel from '@/components/settings/McpPanel.vue'
import PromptEditor from '@/components/settings/PromptEditor.vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import { useSettings } from '@/composables/useSettings'

/**
 * 设置页
 * ---------------------------------------------------------------------------
 * 结构：卡片（分组）→ 小节 → 字段块（标签行 + 控件 + 一行说明）。
 * 输入与可视化选择都在 FieldControl（输入框、单位、掩码、测试连接与各类型弹层），
 * 本文件只负责分组、模式切换、保存 / 导出 / 导入这些页面级动作。
 *
 * 几处取舍：
 *   · 顶栏与首页/发现页同款（.topbar-surface 吸顶）：长页面滚到哪都能保存
 *   · 基础 / 高级模式：高级项（超时、缓存、调度）默认隐藏；改动过、覆盖过的项始终显示
 *   · 「需重启」用图标而非常驻文字：它是字段属性，文字放在悬浮说明里
 *   · 页面不再写「配置存在哪里、什么时候生效」：那是实现细节，使用者只关心这一项填什么
 */
const GROUP_ICONS = {
  sources: IconWorld,
  dump: IconCloudDownload,
  ai: IconBrain,
  worker: IconClockHour4,
  cache: IconDatabase,
  qb: IconDownload,
  mcp: IconPlugConnected,
}

const {
  data,
  groups,
  showAdvanced,
  hiddenAdvancedCount,
  changedInAdvanced,
  models,
  modelsLoading,
  loadModels,
  providers,
  loading,
  saving,
  savingKey,
  savedKey,
  unchangedKey,
  markUnchanged,
  error,
  message,
  dirtyCount,
  valueOf,
  isDirty,
  testStates,
  testDetails,
  testField,
  rowTests,
  testRow,
  pickProvider,
  aiBaseUrl,
  aiKeyConfigured,
  setValue,
  revert,
  load,
  save,
  resetOne,
  resetAll,
  importPayload,
  exportFile,
} = useSettings()

const importText = ref('')
const importMode = ref('merge')
const importError = ref('')

/**
 * 行脚：**只显示测试结果**（那是"状态"，需要常驻看）。
 * 字段说明（hint）改成鼠标悬浮显示（挂在标签行上）—— 常驻一行说明会把表单变成"说明书"，
 * 真正该看见的测试结果反而被淹没。
 */
function fieldFootText(field) {
  return testDetails.value[field.path] || ''
}

/** 本卡片里改过的项（用来判断「有没有改动」） */
const dirtyPathsOf = (group) => group.fields.filter((field) => isDirty(field)).map((field) => field.path)

/**
 * 本卡片保存时要提交的项：**整组所有字段**（不只是改动过的）
 * ---------------------------------------------------------------------------
 * 只提交 diff 的话，点一次保存往往只落一两个键，打开数据库会以为「设置没存进去」。
 * 提交整组后，这张卡片点过保存，整组配置就在库里（导出/搬迁直接可带走）。
 * 用 data.fields 而不是 group.fields：后者只含当前模式可见的项，
 * 基础模式下保存会把高级项漏掉。
 */
const pathsOf = (group) =>
  (data.value?.fields ?? []).filter((field) => field.group === group.key).map((field) => field.path)

const saveGroup = (group) => {
  // 没有任何改动也别把按钮变灰（灰按钮等于「不告诉你为什么点不动」）：
  // 点一下回一句「无变化」，人就知道是「已经是最新」，不是「按钮坏了」
  if (!dirtyPathsOf(group).length) return markUnchanged(group.key)
  return save(pathsOf(group), group.key)
}

function saveText(group) {
  if (savingKey.value === group.key) return '保存中...'
  if (savedKey.value === group.key) return '保存成功'
  if (unchangedKey.value === group.key) return '无变化'
  return `保存${group.label}`
}

function testTitle(field) {
  const state = testStates.value[field.path]
  if (state === 'testing') return '正在测试…'
  if (state === 'success') return `连通（${testDetails.value[field.path]}）`
  if (state === 'error') return `不通：${testDetails.value[field.path]}`
  return '测试连接（用当前填写的地址）'
}

const onExport = (includeSecrets) => exportFile({ includeSecrets })

async function onResetAll() {
  if (!window.confirm('把所有设置还原为默认值？')) return
  await resetAll()
}

function onImport() {
  importError.value = ''
  let payload
  try {
    payload = JSON.parse(importText.value)
  } catch (err) {
    importError.value = `不是合法 JSON：${err.message}`
    return
  }
  if (importMode.value === 'replace' && !window.confirm('覆盖模式会先清空已保存的设置，继续？')) return
  importPayload(payload, importMode.value)
}

async function onPickFile(event) {
  const file = event.target.files?.[0]
  if (!file) return
  importText.value = await file.text()
  importError.value = ''
  event.target.value = ''
}

onMounted(load)
</script>

<style scoped>
/* ── 页面：**撑满**（不限宽），整页统一无衬线 ─────────────────────────── */
.settings {
  /* 工具页不要楷体：base.css 把 h1~h4 交给了 --font-ui（霞鹜文楷），这里压回正文体 */
  font-family: var(--font-body);
  /* 父级 `.main-content` 是 `height:100vh; overflow:hidden` —— 页面自己必须是滚动容器，
     否则超出一屏的部分**直接被裁掉、也滚不动**（"每日更新时刻 / 数据源被挡住"就是这个）。 */
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 72px;
  /* 滚动到锚点时给吸顶栏留位置（跳转 / 键盘聚焦不要被顶栏盖住） */
  scroll-padding-top: 72px;
}

/* 吸顶栏：底色与底线交给全局 .topbar-surface（与首页/发现页同一套），这里只管定位与留白 */
.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  padding: 14px var(--page-pad-x);
}

.page-head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}
.page-titles {
  min-width: 0;
}
.page-title {
  font-family: var(--font-body);
  color: var(--text-primary);
  font-size: 1.45rem;
  font-weight: 700;
  line-height: 1.25;
}
.page-desc {
  margin-top: 4px;
  color: var(--text-tertiary);
  font-size: 0.8rem;
}
.head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.page-message {
  margin: 0 var(--page-pad-x) 14px;
  color: var(--accent-strong);
  font-size: 0.78rem;
}

/* 三态用全站统一的 StateBlock，这里只剩它要用的转圈关键帧（.mini-spinner 也用） */
@keyframes spin {
  to {
    transform: rotate(1turn);
  }
}

/* ── 卡片 = 分组（底/描边/圆角来自全局 .card-surface，这里只管内边距）──── */
.cards {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 0 var(--page-pad-x);
}
.card {
  padding: 20px 24px 18px;
}
.card-head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 4px 10px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-body);
  color: var(--text-primary);
  font-size: 0.98rem;
  font-weight: 700;
}
.card-title svg {
  color: var(--accent);
}
.card-hint {
  grid-column: 1 / -1;
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

/* ── 小节 + 字段网格：每格一个字段（标签在上、控件在下），多列铺满整页 ── */
.section + .section {
  margin-top: 20px;
}
.section-title {
  margin-bottom: 10px;
  font-family: var(--font-body);
  color: var(--accent-strong);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.14em;
}
/* ── 基础 / 高级切换：与侧栏主题开关同一套两段式 ──────────────────────── */
.mode-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-input);
}
.mode-side {
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  color: var(--text-tertiary);
  font-size: 0.72rem;
  line-height: 1.2;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.mode-side:hover {
  color: var(--text-secondary);
}
.mode-side.on {
  background: var(--bg-card);
  color: var(--text-primary);
  font-weight: 600;
}
.fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px 20px;
  /* 用**容器查询**决定"能不能占两格"：按栅格自己的宽度判断，而不是按窗口宽度。
     之前用 `span 2` + 窗口断点，侧栏一展开、卡片一窄，格子只有 1 列却仍要 span 2 →
     多出来的隐式列直接把内容顶出卡片（就是"被挡住"）。 */
  container-type: inline-size;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
/* 地址 / 多源列表这类内容长的项：**只有在真有第二列时才占两格**（≥ 520px） */
@container (min-width: 520px) {
  .field.wide {
    grid-column: span 2;
  }
}
.field-label {
  color: var(--text-secondary);
  font-size: 0.8rem;
}
/* 改过的字段：标签与输入框一起变强调色 —— 一眼看出动过哪几处 */
.field.dirty .field-label {
  color: var(--accent-strong);
  font-weight: 600;
}
.control {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* ── 字段块：标签行（名称 + 属性图标 + 行操作）────────────────────────── */
.field-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 18px;
}
.field-flag {
  display: inline-flex;
  align-items: center;
  color: var(--status-warning);
  cursor: help;
}
.field-actions {
  margin-left: auto;
  display: inline-flex;
  gap: 8px;
}
/* 行操作默认淡出，悬停整块时才显形：静态时页面更干净 */
.field-actions .mini-link {
  opacity: 0;
  transition: opacity var(--dur-fast);
}
.field:hover .field-actions .mini-link,
.field:focus-within .field-actions .mini-link {
  opacity: 1;
}
.mini-link {
  color: var(--accent);
  font-size: 0.72rem;
}
.mini-link:hover:not(:disabled) {
  color: var(--accent-strong);
}
.mini-link:disabled {
  opacity: 0.5;
}
.field-foot {
  color: var(--text-tertiary);
  font-size: 0.72rem;
  line-height: 1.5;
}
.field-foot.ok {
  color: var(--status-success);
}
.field-foot.bad {
  color: var(--status-danger);
}

/* ── 卡片底部：自己的保存按钮（保存中… → 保存成功）─────────────────────── */
.card-save {
  display: flex;
  justify-content: flex-end;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.save-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 116px;
  padding: 9px 20px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--text-invert);
  font-size: 0.86rem;
  font-weight: 600;
  transition: background 0.4s ease, transform 0.3s ease;
}
.save-btn:hover:not(:disabled) {
  filter: brightness(1.08);
}
.save-btn.saving {
  opacity: 0.7;
}
/* 点了保存但没有改动：蓝色 + 一句「无变化 · 已是最新」——灰字看不见，等于没反馈 */
.save-btn.idle {
  border-color: var(--status-info);
  background: color-mix(in srgb, var(--status-info) 12%, var(--bg-card));
  color: var(--status-info);
}
/* 「高级」按钮上的角标：基础模式下有几个改过的项被收在里面 */
.mode-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  margin-left: 5px;
  padding: 0 4px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--text-invert);
  font-size: 0.62rem;
  font-weight: 700;
  line-height: 1;
}
.save-btn.ok {
  background: var(--status-success);
  animation: save-pop 0.5s ease;
}
.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
@keyframes save-pop {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.05);
  }
  100% {
    transform: scale(1);
  }
}

/* ── 小按钮（页头与导入区）────────────────────────────────────────────── */
.mini-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.75rem;
  transition: color var(--dur-fast), border-color var(--dur-fast);
}
.mini-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.mini-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.mini-btn.primary {
  justify-content: center;
  background: var(--accent);
  border-color: var(--accent);
  color: var(--text-invert);
}

/* ── 导入区 ───────────────────────────────────────────────────────────── */
.import-text {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.76rem;
  line-height: 1.5;
  resize: vertical;
}
.import-text:focus {
  outline: none;
  border-color: var(--accent);
}
.import-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}
.file {
  max-width: 240px;
  color: var(--text-secondary);
  font-size: 0.75rem;
}
.radio {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary);
  font-size: 0.76rem;
  cursor: pointer;
}
.radio input {
  accent-color: var(--accent);
}
.error-text {
  margin-top: 8px;
  color: var(--status-danger);
  font-size: 0.75rem;
}

/* ── 只读启动参数 ─────────────────────────────────────────────────────── */
.readonly-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px 20px;
}
.readonly-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
/* 只读值：表面来自 .input-surface，只给尺寸与等宽字体 */
.readonly-value {
  display: flex;
  align-items: center;
  height: 40px;
  padding: 0 12px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.84rem;
}
.readonly-env {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 0.68rem;
}

/* ── 窄屏：页头竖排、字段退成单列 ─────────────────────────────────────── */
@media (max-width: 720px) {
  .settings {
    padding: 20px 16px 64px;
  }
  .card {
    padding: 16px;
  }
  .page-head {
    flex-direction: column;
    gap: 10px;
  }
  .head-actions {
    margin-left: 0;
  }
}
</style>

