<template>
  <section class="card-surface prompt-card">
    <header class="prompt-head">
      <h2 class="prompt-title">
        <IconMessageChatbot :size="19" />
        提示词
      </h2>
      <span class="pill" :class="source === 'override' ? 'pill-accent' : 'pill-muted'">{{ sourceText }}</span>
      <p class="prompt-hint">
        分两段：系统段是我们的输出要求（保存时会校验 JSON 结构与字段名，缺了不让存）；
        补充段是你自己的偏好，拼在系统段后面、优先级更低。保存后立即生效，不用重启。
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
          <span v-if="isOverridden(tab.key)" class="tab-flag" title="这一段有改动或补充（和出厂默认不同）">改</span>
          <span v-if="isDirty(tab.key)" class="tab-dot" title="有未保存的修改" />
        </button>
      </div>

      <p class="prompt-meta">
        <span>{{ activeTab.hint }}</span>
        <span class="prompt-num">
          hash {{ hashOf(activeKey) }} · 系统 {{ draftOf(activeKey, 'system').length }} 字 · 补充
          {{ draftOf(activeKey, 'custom').length }} 字
        </span>
      </p>

      <label class="prompt-label" :for="`p-system-${activeKey}`">
        系统提示词
        <span class="prompt-label-hint">输出契约在里面（JSON 结构、字段名），删掉就会存不进去</span>
      </label>
      <textarea
        :id="`p-system-${activeKey}`"
        v-model="draft[activeKey].system"
        class="prompt-text prompt-text-system input-surface"
        spellcheck="false"
        rows="12"
      />

      <label class="prompt-label" :for="`p-custom-${activeKey}`">
        用户补充
        <span class="prompt-label-hint">可以随便写；留空就是只用系统段</span>
      </label>
      <textarea
        :id="`p-custom-${activeKey}`"
        v-model="draft[activeKey].custom"
        class="prompt-text input-surface"
        spellcheck="false"
        rows="4"
        :placeholder="activeTab.example"
      />

      <div class="prompt-actions">
        <button
          class="prompt-link"
          type="button"
          :disabled="saving"
          title="系统段回到出厂正文、补充段清空（只改草稿，点保存才写入）"
          @click="restoreDraft(activeKey)"
        >
          <IconRestore :size="13" /> 恢复这一段默认
        </button>
        <button
          class="prompt-link"
          type="button"
          :disabled="saving"
          title="四段都改回出厂默认（只改草稿，点保存才写入）"
          @click="restoreAllDrafts"
        >
          <IconRestore :size="13" /> 全部恢复默认
        </button>
        <button class="prompt-link" type="button" :disabled="saving || !dirtyKeys.length" @click="revert">
          撤销改动
        </button>

        <span class="prompt-msg" :class="{ bad: /失败|不能为空/.test(message) }">{{ message }}</span>

        <button class="prompt-save" type="button" :disabled="saving" @click="onSave">
          {{ saving ? '保存中…' : dirtyKeys.length ? `保存 ${dirtyKeys.length} 段` : '保存提示词' }}
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
 * 提示词（系统段 + 用户补充）
 * ---------------------------------------------------------------------------
 * 为什么拆两段：系统段是输出契约（JSON 里必须有 tags / episodes 这些字段），
 * 改坏就会「标签突然全没了」；补充段是纯偏好，写错顶多解析得差一点。
 * 所以两段都能改，但系统段保存时由后端校验关键字段名，缺了直接 400。
 *
 * 模型跑偏（返回的不是约定结构）时，服务端会自动用出厂默认再跑一次，
 * 结果里带 promptFallback，界面上不额外打扰（面板的 AI 位本来就有状态提示）。
 */
const TABS = [
  {
    key: 'bundle',
    label: '标签 + 集数',
    hint: '一次调用同时产出筛选标签与每条资源的集数，最常改的就是这段。',
    example: '例如：优先保留 1080P；简繁内嵌优先；字幕组相关判断从严。',
  },
  {
    key: 'series',
    label: '系列归一',
    hint: '判断命名风格、系列总名、番外归类。链序由代码给出，这里只负责归类与命名。',
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
    hint: '把文件名开头的组标记对应到库里的组名。系统段里的 {{NAMES}} 占位符不能删。',
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
  hashOf,
  draftOf,
  isDirty,
  isOverridden,
  dirtyKeys,
  load,
  save,
  revert,
  restoreDraft,
  restoreAllDrafts,
} = usePrompts()

const activeKey = ref('bundle')
const activeTab = computed(() => TABS.find((tab) => tab.key === activeKey.value) || TABS[0])
const sourceText = computed(() => (source.value === 'override' ? '有改动（用着你的版本）' : source.value ? '出厂默认' : ''))

const onSave = () => save()

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
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.prompt-title {
  display: flex;
  align-items: center;
  gap: 8px;
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
  line-height: 1.6;
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

/* 两段的标题行：左边是段名，右边一句极小说明 */
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
  font-size: 0.74rem;
  line-height: 1.6;
  resize: vertical;
}
/* 系统段要比补充段更"重"：它是契约，一眼看出这段不能乱删 */
.prompt-text-system {
  background: color-mix(in srgb, var(--accent) 4%, var(--bg-input));
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
  margin-top: 12px;
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
