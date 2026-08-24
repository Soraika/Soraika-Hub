<template>
  <Transition name="slide">
    <aside v-if="group" class="panel">
      <div class="panel-inner">
        <button class="close-btn" @click="$emit('close')"><IconX :size="22" /></button>

        <!-- 上半部分：番剧信息 -->
        <div class="panel-header">
          <img v-if="group.poster" :src="group.poster" class="panel-poster" />
          <div v-else class="panel-poster placeholder"><IconPhotoOff :size="40" /></div>
          <div class="panel-head-info">
            <div class="panel-title">{{ group.animeName }}</div>
            <div class="panel-meta">
              <span class="season-badge">SE{{ pad(group.season) }}</span>
              <span v-if="group.subgroupName" class="sg-badge">{{ group.subgroupName }}</span>
            </div>
          </div>
        </div>

        <!-- BGM 评分 / 简介 -->
        <div v-if="bgmLoading" class="load-state"><div class="spinner-ring"></div></div>
        <div v-else-if="bgmInfo" class="bgm-card">
          <div class="bgm-rating">
            <span class="bgm-score">★ {{ bgmInfo.rating?.score || '—' }}</span>
            <span v-if="bgmInfo.rating?.total" class="bgm-total">{{ bgmInfo.rating.total }} 人评分</span>
            <span v-if="bgmInfo.rank" class="bgm-rank">#{{ bgmInfo.rank }}</span>
          </div>
          <div v-if="bgmInfo.tags?.length" class="bgm-tags">
            <span v-for="t in bgmInfo.tags.slice(0, 5)" :key="t.name" class="bgm-tag-chip">{{ t.name }}</span>
          </div>
          <p v-if="bgmInfo.summary" class="bgm-summary">{{ bgmInfo.summary }}</p>
        </div>

        <!-- 字幕组 -->
        <div v-if="detail?.subgroups?.length" class="subgroup-row">
          <span class="subgroup-label">字幕组</span>
          <span v-for="sg in detail.subgroups" :key="sg.id" class="sg-chip">{{ sg.name }}</span>
        </div>

        <!-- 下半部分：已下载集管理 -->
        <div class="episode-section">
          <div class="ep-head">
            <span>已下载 {{ group.episodes.length }} 集</span>
            <span class="ep-done">{{ group.doneCount }} 完成</span>
          </div>
          <div
            v-for="ep in group.episodes"
            :key="ep.hash"
            class="ep-row"
            :class="stateClass(ep.qbState)"
          >
            <span class="ep-label">{{ ep.label }}</span>
            <div class="ep-progress-wrap">
              <div class="ep-progress-bar">
                <div class="ep-progress-fill" :style="{ width: `${(ep.progress * 100).toFixed(1)}%` }"></div>
              </div>
              <span class="ep-percent">{{ ep.isDone ? '✓' : `${(ep.progress * 100).toFixed(0)}%` }}</span>
            </div>
            <span class="ep-size">{{ formatSize(ep.size) }}</span>
            <button class="ep-cancel" title="删除" @click="cancel(ep)">×</button>
            <button class="ep-rename-btn" title="重命名" @click="openRename(ep)">✎</button>
          </div>
        </div>
      </div>

      <!-- 重命名弹窗 -->
      <div v-if="renameTarget" class="modal-overlay" @click.self="renameTarget = null">
        <div class="modal-box">
          <h3>重命名</h3>
          <input v-model="renameValue" placeholder="输入新文件名" @keyup.enter="doRename" />
          <div class="modal-actions">
            <button class="cancel-btn" @click="renameTarget = null">取消</button>
            <button class="save-btn" :disabled="!renameValue" @click="doRename">确定</button>
          </div>
        </div>
      </div>
    </aside>
  </Transition>
</template>

<script setup>
import { ref, watch } from 'vue'
import { IconX, IconPhotoOff } from '@tabler/icons-vue'
import { getSubDetail, searchBgm, getBgmSubject, qbDelete, qbRename } from '@/api'
import { createLogger } from '@/utils/logger'

const log = createLogger('DownloadDetailPanel')

const props = defineProps({
  group: { type: Object, default: null },
})
const emit = defineEmits(['close', 'changed'])

const detail = ref(null)
const bgmInfo = ref(null)
const bgmLoading = ref(false)
const renameTarget = ref(null)
const renameValue = ref('')

// 番剧信息：详情（海报/字幕组）→ BGM 评分/简介
watch(() => props.group, async (g) => {
  detail.value = null
  bgmInfo.value = null
  if (!g?.bgmid) return
  bgmLoading.value = true
  try {
    const { data } = await getSubDetail(g.bgmid)
    detail.value = data.detail || null
    const title = data.detail?.title
    if (title) {
      const { data: d } = await searchBgm(title)
      const subjectId = d.items?.[0]?.id
      if (subjectId) {
        const { data: b } = await getBgmSubject(subjectId)
        if (b?.detail) bgmInfo.value = b.detail
      }
    }
  } catch (e) { log.error('加载番剧信息失败:', e) }
  finally { bgmLoading.value = false }
})

function pad(n) { return String(n).padStart(2, '0') }

function stateClass(s) {
  const m = { downloading: 's-dl', forcedDL: 's-dl', stalledDL: 's-stall', pausedDL: 's-pause',
    uploading: 's-up', forcedUP: 's-up', stalledUP: 's-up',
    queuedDL: 's-queue', queuedUP: 's-queue', error: 's-err', missingFiles: 's-err' }
  return m[s] || ''
}
function formatSize(b) {
  return b > 1073741824 ? (b / 1073741824).toFixed(1) + ' GB'
    : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB'
    : b > 1024 ? (b / 1024).toFixed(0) + ' KB'
    : b + ' B'
}

async function cancel(ep) {
  try { await qbDelete(ep.hash); emit('changed') } catch (e) { log.error('删除任务失败:', e) }
}
function openRename(ep) { renameTarget.value = ep; renameValue.value = ep.name || '' }
async function doRename() {
  if (!renameTarget.value || !renameValue.value) return
  try {
    await qbRename(renameTarget.value.hash, renameValue.value)
    renameTarget.value.name = renameValue.value
  } catch (e) { log.error('重命名失败:', e) }
  renameTarget.value = null
}
</script>

<style scoped>
/* 右侧滑出面板 */
.panel {
  position: fixed; top: 0; right: 0; height: 100vh; width: 320px;
  background: var(--bg-card); border-left: 1px solid var(--border);
  z-index: 120; box-shadow: -8px 0 24px rgba(0, 0, 0, 0.15);
}
.panel-inner {
  height: 100%; overflow-y: auto; padding: 28px 24px 40px;
  position: relative;
}
.close-btn {
  position: absolute; top: 16px; right: 16px; z-index: 5;
  display: flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 8px;
  background: var(--bg-input); border: 1px solid var(--border);
  color: var(--text-secondary); cursor: pointer; transition: 0.2s;
}
.close-btn:hover { color: var(--accent); border-color: var(--accent); }

.slide-enter-active { transition: transform 0.32s cubic-bezier(0.33, 1, 0.68, 1); }
.slide-leave-active { transition: transform 0.25s ease-in; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); }

/* 头部 */
.panel-header { display: flex; gap: 14px; margin-bottom: 20px; align-items: flex-start; }
.panel-poster {
  width: 96px; height: 134px; border-radius: 8px; object-fit: cover;
  flex-shrink: 0; background: var(--bg-input);
}
.panel-poster.placeholder { display: flex; align-items: center; justify-content: center; color: var(--text-tertiary); }
.panel-head-info { flex: 1; min-width: 0; }
.panel-title { font-size: 1.05rem; font-weight: 600; color: var(--text-primary); line-height: 1.5; padding-top: 2px; word-break: break-word; }
.panel-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.season-badge { background: var(--accent); color: #fff; padding: 1px 8px; border-radius: 10px; font-size: 0.72rem; font-weight: 600; }
.sg-badge { background: var(--bg-input); color: var(--accent); padding: 1px 8px; border-radius: 10px; border: 1px solid var(--accent); font-size: 0.72rem; font-weight: 500; }

/* BGM 卡片 */
.load-state { display: flex; align-items: center; justify-content: center; padding: 20px 0; }
.spinner-ring {
  width: 28px; height: 28px; border: 3px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%; animation: spin 1.2s ease-in-out infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.bgm-card {
  padding: 14px; border-radius: 10px;
  background: var(--bg-input); border: 1px solid var(--border);
  margin-bottom: 16px; font-size: 0.8rem;
}
.bgm-rating { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.bgm-score { font-size: 1.1rem; font-weight: 700; color: var(--accent-gold); }
.bgm-total { font-size: 0.75rem; color: var(--text-secondary); }
.bgm-rank { font-size: 0.75rem; color: var(--accent); font-weight: 600; }
.bgm-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.bgm-tag-chip {
  padding: 2px 8px; border-radius: 10px;
  background: rgba(196, 147, 90, 0.12); color: var(--accent-gold);
  font-size: 0.7rem; font-weight: 500;
}
.bgm-summary { font-size: 0.78rem; color: var(--text-secondary); line-height: 1.6; max-height: 4.8em; overflow: hidden; margin: 0; }

/* 字幕组 */
.subgroup-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 16px; }
.subgroup-label { font-size: 0.78rem; color: var(--text-secondary); }
.sg-chip { padding: 2px 8px; border-radius: 10px; background: var(--bg-input); border: 1px solid var(--border); color: var(--accent); font-size: 0.72rem; font-weight: 500; }

/* 已下载集 */
.episode-section { border-top: 1px solid var(--border); padding-top: 14px; }
.ep-head { display: flex; align-items: center; justify-content: space-between; font-size: 0.85rem; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
.ep-done { font-size: 0.75rem; color: #22c55e; font-weight: 500; }
.ep-row { display: flex; align-items: center; gap: 10px; padding: 10px 4px; border-bottom: 1px solid var(--border-light, rgba(128, 128, 128, 0.06)); font-size: 0.84rem; transition: background 0.15s; }
.ep-row:last-child { border-bottom: none; }
.ep-row:hover { background: var(--bg-hover); }
.ep-label { font-weight: 600; color: var(--accent); min-width: 68px; font-variant-numeric: tabular-nums; }
.ep-progress-wrap { flex: 1; display: flex; align-items: center; gap: 8px; }
.ep-progress-bar { flex: 1; height: 5px; background: var(--bg-input); border-radius: 3px; overflow: hidden; }
.ep-progress-fill { height: 100%; border-radius: 3px; background: var(--accent); transition: width 0.5s ease; }
.ep-row.s-dl .ep-progress-fill { background: #3b82f6; }
.ep-row.s-stall .ep-progress-fill { background: #f59e0b; }
.ep-row.s-up .ep-progress-fill { background: #22c55e; }
.ep-row.s-pause .ep-progress-fill { background: #9ca3af; }
.ep-row.s-err .ep-progress-fill { background: #ef4444; }
.ep-percent { font-size: 0.78rem; color: var(--text-secondary); min-width: 34px; text-align: right; }
.ep-size { font-size: 0.78rem; color: var(--text-tertiary); min-width: 60px; text-align: right; }
.ep-cancel, .ep-rename-btn { background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 1rem; padding: 2px 4px; border-radius: 4px; opacity: 0; transition: opacity 0.15s; }
.ep-row:hover .ep-cancel, .ep-row:hover .ep-rename-btn { opacity: 1; }
.ep-cancel:hover { color: #ef4444; }
.ep-rename-btn:hover { color: var(--accent); }

/* 重命名弹窗 */
.modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); z-index: 300; display: flex; align-items: center; justify-content: center; }
.modal-box { background: var(--bg-card); border-radius: 12px; padding: 28px; max-width: 420px; width: 90%; }
.modal-box h3 { margin: 0 0 4px; color: var(--text-primary); }
.modal-box input { width: 100%; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; font-size: 0.9rem; color: var(--text-primary); margin-bottom: 16px; }
.modal-box input:focus { outline: none; border-color: var(--accent); }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
.cancel-btn { background: var(--bg-hover); color: var(--text-secondary); padding: 8px 20px; border-radius: 8px; font-size: 0.9rem; border: none; cursor: pointer; }
.save-btn { background: var(--accent); color: #fff; padding: 8px 20px; border-radius: 8px; font-size: 0.9rem; border: none; cursor: pointer; }
.save-btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>

