<template>
  <div class="torrent-wrap">
    <div v-if="rankedItems.length === 0" class="panel-state" style="padding: 24px 0">
      <p>{{ totalCount > 0 ? '无匹配资源，试试调整筛选' : '暂无资源' }}</p>
    </div>

    <div v-else>
      <div class="torrent-list-header">
        资源列表 ({{ rankedItems.length }})
        <span v-if="checkedItems.size > 0" class="checked-count"> · 已选 {{ checkedItems.size }}</span>
      </div>
      <TransitionGroup name="list" tag="div" class="torrent-list">
        <div
          v-for="item in rankedItems"
          :key="item.magnetHash || item.title"
          class="torrent-row"
          :class="{ checked: checkedItems.has(item.magnetHash) }"
          @click="$emit('check', item)"
        >
          <div class="tr-ep-num">
            <template v-if="episodes?.[item.title] != null">
              <span class="ep-digit">{{ episodes[item.title] }}</span>
            </template>
            <template v-else>
              <span class="ep-spinner"></span>
            </template>
          </div>
          <div class="tr-content">
            <div class="tr-main">
              <label class="tr-check" @click.stop>
                <input
                  type="checkbox"
                  :checked="checkedItems.has(item.magnetHash)"
                  @change="$emit('check', item)"
                />
                <span class="check-mark"><IconCheck v-if="checkedItems.has(item.magnetHash)" :size="12" /></span>
              </label>
              <div class="tr-name" :title="item.title">{{ item.title }}</div>
            </div>
            <div class="tr-footer">
              <span class="tr-size">{{ formatSize(item.sizeBytes) }}</span>
              <button
                class="tr-dl-btn"
                :disabled="downloading"
                :class="{ added: addedHashes.has(item.magnetHash) }"
                @click.stop="$emit('downloadOne', item)"
              >
                <IconCircleCheck v-if="addedHashes.has(item.magnetHash)" :size="14" />
                <IconDownload v-else :size="14" />
                <span class="tr-dl-text">{{ addedHashes.has(item.magnetHash) ? '已添加' : '下载' }}</span>
              </button>
            </div>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<script setup>
import { IconCheck, IconCircleCheck, IconDownload } from '@tabler/icons-vue'

defineProps({
  rankedItems: { type: Array, default: () => [] },
  totalCount: { type: Number, default: 0 },
  checkedItems: { type: Set, default: () => new Set() },
  addedHashes: { type: Set, default: () => new Set() },
  torrentLoading: { type: Boolean, default: false },
  downloading: { type: Boolean, default: false },
  aiReady: { type: Boolean, default: true },
  episodes: { type: Object, default: () => ({}) },
})

defineEmits(['check', 'downloadOne'])

function formatSize(bytes) {
  if (!bytes) return ''
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB'
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return bytes + ' B'
}
</script>

<style scoped>
.panel-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 80px 0; color: var(--text-secondary); }

.torrent-list-header {
  font-size: 0.78rem; font-weight: 600; color: var(--text-secondary);
  margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--border);
}
.checked-count { color: #3b82f6; font-weight: 400; }

.torrent-list { display: flex; flex-direction: column; gap: 10px; }

/* ── 整行卡片 ── */
.torrent-row {
  display: flex; align-items: stretch; gap: 0;
  border-radius: 10px;
  background: var(--bg-input);
  border: 1px solid transparent;
  transition: border-color 0.25s, box-shadow 0.25s;
  min-height: 58px;
  overflow: hidden;
  cursor: pointer;
}
.torrent-row:hover {
  border-color: var(--border);
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
}

/* ── 选中状态 ── */
.torrent-row.checked {
  border-color: #3b82f6;
  box-shadow: 0 0 0 1px rgba(59,130,246,0.15);
}

/* ── 左侧集数区域 ── */
.tr-ep-num {
  flex-shrink: 0; width: 56px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(196, 147, 90, 0.14);
  border-right: 1px solid rgba(196, 147, 90, 0.22);
  transition: background 0.3s, border-color 0.3s;
}
.torrent-row.checked .tr-ep-num {
  background: rgba(59, 130, 246, 0.10);
  border-right-color: rgba(59, 130, 246, 0.25);
}

/* ── 集数数字 ── */
.ep-digit {
  font-family: 'Georgia', 'Times New Roman', 'Noto Serif SC', serif;
  font-style: italic;
  font-size: 1.55rem;
  font-weight: 700;
  color: #c4935a;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  user-select: none;
  transition: color 0.3s;
}
.torrent-row.checked .ep-digit {
  color: #3b82f6;
}

/* ── 加载 spinner ── */
.ep-spinner {
  width: 22px; height: 22px;
  border: 2px solid rgba(196, 147, 90, 0.18);
  border-top-color: #c4935a;
  border-radius: 50%;
  animation: epSpin 0.8s linear infinite;
}
.torrent-row.checked .ep-spinner {
  border-color: rgba(59, 130, 246, 0.18);
  border-top-color: #3b82f6;
}
@keyframes epSpin { to { transform: rotate(360deg); } }

/* ── 右侧内容区 ── */
.tr-content { flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 10px 14px; min-width: 0; }

.tr-main { display: flex; align-items: flex-start; gap: 6px; }
.tr-check {
  flex-shrink: 0; margin-top: 2px; position: relative;
  width: 16px; height: 16px; cursor: pointer;
}
.tr-check input { position: absolute; opacity: 0; width: 0; height: 0; }
.check-mark {
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 4px;
  border: 1.5px solid var(--border-button, var(--border));
  background: var(--bg-card); transition: all 0.15s;
}
.torrent-row.checked .check-mark { background: #3b82f6; border-color: #3b82f6; color: #fff; }
.tr-name { font-size: 0.8rem; color: var(--text-primary); line-height: 1.5; word-break: break-word; }
.tr-footer { display: flex; align-items: center; justify-content: space-between; }
.tr-size { font-size: 0.75rem; color: var(--text-tertiary); }
.tr-dl-btn {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg-card); color: var(--text-secondary);
  font-size: 0.78rem; cursor: pointer; white-space: nowrap;
  min-width: 56px; justify-content: center;
  transition: background 0.25s, color 0.25s, border-color 0.25s, transform 0.15s;
}
.tr-dl-btn:hover:not(:disabled):not(.added) { border-color: var(--accent); color: var(--accent); }
.tr-dl-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.tr-dl-btn.added {
  background: #22c55e; color: #fff; border-color: #22c55e;
  transform: scale(1.05);
}
.tr-dl-btn:not(.added):active { transform: scale(0.94); }
.tr-dl-text { display: inline-block; transition: opacity 0.2s, transform 0.2s; }

/* ── 列表过渡动画 ── */
.list-enter-active { transition: all 0.3s ease-out; }
.list-leave-active { transition: all 0.2s ease-in; }
.list-enter-from { opacity: 0; transform: translateY(-8px); }
.list-leave-to { opacity: 0; transform: translateX(20px); }
</style>