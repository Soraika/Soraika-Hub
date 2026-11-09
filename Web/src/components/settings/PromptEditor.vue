<template>
  <section class="card-surface prompt-card">
    <header class="prompt-head">
      <h2 class="prompt-title">
        <IconMessageChatbot :size="19" />
        提示词
      </h2>
      <span class="pill" :class="source === 'override' ? 'pill-accent' : 'pill-muted'">{{ sourceText }}</span>
      <p class="prompt-hint">
        只写你的偏好，会接在系统提示词后面一起发给模型。系统段由程序维护，改它请编辑 prompts.json。
      </p>
    </header>

    <StateBlock v-if="loading" state="loading" text="正在读提示词…" />
    <StateBlock v-else-if="error && !data" state="error" :text="error.message" retry-text="重试" @retry="load" />

    <template v-else-if="data">
      <div class="prompt-tabs" role="tablist">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          class="prompt-tab"
          :class="{ on: tab.key === activeKey }"
          type="button"
          role="tab"
          :aria-selected="tab.key === activeKey"
          @click="activeKey = tab.key"
        >
          {{ tab.label }}
          <span v-if="isOverridden(tab.key)" class="tab-flag" title="这一段有你的补充（或系统段被换过）">改</span>
          <span v-if="isDirty(tab.key)" class="tab-dot" title="有未保存的修改" />
        </button>
      </div>

      <p class="prompt-meta">
        <span>{{ activeTab.hint }}</span>
        <span class="prompt-num">系统段 {{ systemLengthOf(activeKey) }} 字 · 程序维护</span>
      </p>

      <label class="prompt-label" :for="`p-custom-${activeKey}`">
        你的补充要求
        <span class="prompt-label-hint">留空 = 只用系统提示词</span>
      </label>
      <textarea
        :id="`p-custom-${activeKey}`"
        v-model="draft[activeKey]"
        class="prompt-text input-surface"
        spellcheck="false"
        rows="10"
        :placeholder="activeTab.example"
      />

      <div class="prompt-actions">
        <button
          class="prompt-link"
          type="button"
          :disabled="saving || !isOverridden(activeKey)"
          title="这一段恢复出厂默认（补充清空；会真的写入）"
          @click="askRestore(activeKey)"
        >
          <IconRestore :size="13" /> 恢复这一段默认
        </button>
        <button
          v-if="overriddenKeys.length"
          class="prompt-link"
          type="button"
          :disabled="saving"
          title="四段全部恢复出厂默认（删除 data/prompts.json）"
          @click="askRestore('*')"
        >
          <IconRestore :size="13" /> 全部恢复默认
        </button>
        <button class="prompt-link" type="button" :disabled="saving || !dirtyKeys.length" @click="revert">
          撤销改动
        </button>

        <span class="prompt-msg" :class="{ bad: /失败/.test(message) }">{{ message }}</span>

        <button class="prompt-save" type="button" :disabled="saving" @click="onSave">
          {{ saving ? '保存中…' : dirtyKeys.length ? `保存 ${dirtyKeys.length} 段` : '保存' }}
        </button>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { IconMessageChatbot, IconRestore } from '@tabler/icons-vue'
import StateBlock from '@/components/ui/StateBlock.vue'
import { usePrompts } from '@/composables/usePrompts'

/*
 * 提示词（只编辑「用户补充」那段）
 * ---------------------------------------------------------------------------
 * 系统段是输出契约（JSON 里必须有 tags / episodes 这些字段），改坏就会「标签突然全没了」。
 * 普通用户不需要它，所以界面不展示；会改文件的人直接改 JSON（那里有完整注释）。
 * 界面上只留补充段：写偏好、措辞都不会破坏结构，写偏了服务端也会回退默认。
 */
const TABS = [
  {
    key: 'bundle',
    label: '标签 + 集数',
    hint: '一次调用同时产出筛选标签与每条资源的集数，最常需要补充的就是这段。',
    example: '例如：优先保留 1080P；简繁内嵌优先；字幕组相关判断从严。',
  },
  {
    key: 'series',
    label: '系列归一',
    hint: '判断命名风格、系列总名、番外归类。链序由代码给出，这里只补充命名偏好。',
    example: '例如：系列名统一用中文原名；剧场版一律算番外。',
  },
  {
    key: 'format',
    label: '格式特征',
    hint: '从某个字幕组的样本里抽共有格式，用于在全量 feed 里认出该组资源。',
    example: '例如：优先用【】里出现的组名当特征；番名固定写法也保留。',
  },
  {
    key: 'groupTags',
    label: '组标记 → 组名',
    hint: '把文件名开头的组标记对应到库里的组名；系统段里的 {{NAMES}} 是字典占位符。',
    example: '例如：库里没有的组一律给 null，不要新造名字。',
  },
]

const {
  data,
  draft,
  loading,
  saving,
  error,
  message,
  source,
  systemLengthOf,
  isDirty,
  isOverridden,
  dirtyKeys,
  overriddenKeys,
  load,
  save,
  revert,
  restoreOne,
  restoreAll,
} = usePrompts()

const activeKey = ref('bundle')
const activeTab = computed(() => TABS.find((tab) => tab.key === activeKey.value) || TABS[0])
const sourceText = computed(() => (source.value === 'override' ? '有改动（用着你的版本）' : source.value ? '出厂默认' : ''))

const onSave = () => save()

/** 恢复默认会真的写盘，所以确认一次 */
function askRestore(which) {
  const label = which === '*' ? '四段提示词' : `「${TABS.find((t) => t.key === which)?.label}」这段的补充要求`
  if (!window.confirm(`把${label}恢复成出厂默认？\n你写的补充会被删除。`)) return
  if (which === '*') restoreAll()
  else restoreOne(which)
}

onMounted(load)
</script>

<style scoped>
.prompt-card {
  padding: 20px 24px 18px;
}
.prompt-head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 4px 10px;
  margin-bottom: 16px; /* 与页面里其它卡片的 .card-head 一致 */
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.prompt-title {
  display: flex;
  align-items: center;
  gap: 8px;
  /* base.css 把 h1~h4 交给了 --font-ui（霞鹜文楷），设置页统一压回正文体 ——
     这里必须显式写一遍，否则这一张卡的标题会比别的卡片"变体"。 */
  font-family: var(--font-body);
  color: var(--text-primary);
  font-size: 0.98rem;
  font-weight: 700;
}
.prompt-title svg {
  color: var(--accent);
}
.prompt-hint {
  grid-column: 1 / -1;
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

/* 页签 */
.prompt-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.prompt-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 0.75rem;
  cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
}
.prompt-tab:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.prompt-tab.on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--text-invert);
  font-weight: 600;
}
.tab-flag {
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 0.62rem;
  font-weight: 700;
  line-height: 1.6;
}
.prompt-tab.on .tab-flag {
  background: var(--text-invert);
  color: var(--accent);
}
.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--mod-hot-strong);
}
.prompt-tab.on .tab-dot {
  background: var(--text-invert);
}

.prompt-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  color: var(--text-tertiary);
  font-size: 0.72rem;
}
.prompt-num {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 0.7rem;
}

.prompt-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 6px 0 5px;
  color: var(--text-secondary);
  font-size: 0.74rem;
  font-weight: 600;
}
.prompt-label-hint {
  color: var(--text-tertiary);
  font-size: 0.7rem;
  font-weight: 400;
}

.prompt-text {
  width: 100%;
  padding: 10px 12px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.76rem;
  line-height: 1.65;
  resize: vertical;
}
.prompt-text:focus {
  outline: none;
  border-color: var(--accent);
}

.prompt-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}
.prompt-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent);
  font-size: 0.74rem;
  cursor: pointer;
}
.prompt-link:disabled {
  color: var(--text-tertiary);
  cursor: default;
}
.prompt-link:hover:not(:disabled) {
  color: var(--accent-strong);
}
.prompt-msg {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 0.74rem;
}
.prompt-msg.bad {
  color: var(--danger);
}
.prompt-save {
  padding: 7px 16px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--text-invert);
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity var(--dur-fast);
}
.prompt-save:hover:not(:disabled) {
  opacity: 0.9;
}
.prompt-save:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
