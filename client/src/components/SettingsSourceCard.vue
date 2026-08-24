<template>
  <section class="card">
    <h2 class="card-title"><IconWorld :size="22" /> 数据源</h2>

    <div class="sub-title">Mikan</div>
    <div class="field">
      <span class="label">镜像地址</span>
      <input v-model="form.mikan.baseUrl" placeholder="https://mikanani.kas.pub" />
      <button class="icon-btn" :class="testStates.mikan" :title="testLabel(testStates.mikan)" :disabled="testStates.mikan === 'testing'" @click="$emit('test', 'mikan', form.mikan.baseUrl)">
        <IconPlugConnected v-if="testStates.mikan === 'idle'" :size="16" />
        <span v-else-if="testStates.mikan === 'testing'" class="mini-spinner" />
        <IconCircleCheck v-else-if="testStates.mikan === 'success'" :size="16" />
        <IconCircleX v-else :size="16" />
      </button>
    </div>

    <div class="sub-title">Bangumi</div>
    <div class="field">
      <span class="label">API 地址</span>
      <input v-model="form.bgm.baseUrl" placeholder="https://bgmapi.anibt.net" />
      <button class="icon-btn" :class="testStates.bgm" :title="testLabel(testStates.bgm)" :disabled="testStates.bgm === 'testing'" @click="$emit('test', 'bgm', form.bgm.baseUrl)">
        <IconPlugConnected v-if="testStates.bgm === 'idle'" :size="16" />
        <span v-else-if="testStates.bgm === 'testing'" class="mini-spinner" />
        <IconCircleCheck v-else-if="testStates.bgm === 'success'" :size="16" />
        <IconCircleX v-else :size="16" />
      </button>
    </div>
    <div class="field">
      <span class="label">无 Token</span>
      <button type="button" class="switch" :class="{ on: bgmNoToken }" @click="$emit('toggleBgmNoToken')">
        <span class="switch-thumb" />
      </button>
      <span class="slot-placeholder"></span>
    </div>
    <div class="field">
      <span class="label">Token</span>
      <div class="input-wrap">
        <input
          :type="showToken ? 'text' : 'password'"
          v-model="form.bgm.token"
          :disabled="bgmNoToken"
          :placeholder="bgmNoToken ? '无 Token 模式已开启' : ''"
        />
      </div>
      <button v-if="form.bgm.token && !bgmNoToken" class="icon-btn eye" :class="{ show: showToken }" @click="showToken = !showToken">
        <IconEye v-if="!showToken" :size="18" />
        <IconEyeOff v-else :size="18" />
      </button>
      <span v-else class="slot-placeholder"></span>
    </div>

    <div class="sub-title">Mikan TO BANGUMIID 转换表</div>
    <div class="field">
      <span class="label">镜像地址</span>
      <input v-model="form.mikan.mappingUrl" placeholder="https://raw.githubusercontent.com/xiaoyvyv/bangumi-data/main/data/mikan/bangumi-mikan.json" />
      <button class="icon-btn" :class="testStates.mapping" :title="testLabel(testStates.mapping)" :disabled="testStates.mapping === 'testing'" @click="$emit('test', 'mapping', form.mikan.mappingUrl)">
        <IconPlugConnected v-if="testStates.mapping === 'idle'" :size="16" />
        <span v-else-if="testStates.mapping === 'testing'" class="mini-spinner" />
        <IconCircleCheck v-else-if="testStates.mapping === 'success'" :size="16" />
        <IconCircleX v-else :size="16" />
      </button>
    </div>
    <div class="field">
      <span class="label">状态</span>
      <div class="input-wrap">
        <span class="mapping-status-text">
          {{ mappingStatus?.count != null ? `共 ${mappingStatus.count} 条 · ${fmtTime(mappingStatus.lastSyncAt)}` : '未同步 / 未知' }}
        </span>
      </div>
      <button class="icon-btn" :title="syncingMapping ? '更新中...' : '立即更新'" :disabled="syncingMapping" @click="$emit('syncMapping')">
        <span v-if="syncingMapping" class="mini-spinner" />
        <IconRefresh v-else :size="16" />
      </button>
    </div>
    <div class="card-save">
      <button class="save-btn" :class="{ saving: saving && saveKey === 'source', ok: saveOk && saveKey === 'source' }" :disabled="saving && saveKey === 'source'" @click="$emit('save', 'source')">
        <IconCircleCheck v-if="saveOk && saveKey === 'source'" :size="16" class="save-check-icon" />
        <IconDeviceFloppy v-else :size="16" />
        <span>{{ saveBtnText('source') }}</span>
      </button>
    </div>
  </section>
</template>

<script setup>
import { ref } from 'vue'
import { IconWorld, IconPlugConnected, IconCircleCheck, IconCircleX, IconEye, IconEyeOff, IconDeviceFloppy, IconRefresh } from '@tabler/icons-vue'

const props = defineProps({
  form: Object,
  testStates: Object,
  bgmNoToken: Boolean,
  saving: Boolean,
  saveKey: String,
  saveOk: Boolean,
  mappingStatus: Object,
  syncingMapping: Boolean,
})

defineEmits(['test', 'toggleBgmNoToken', 'save', 'syncMapping'])

const showToken = ref(false)

function testLabel(state) {
  const map = { idle: '测试连接', testing: '测试中...', success: '测试成功 ✓', error: '测试失败 ✕' }
  return map[state] || '测试连接'
}

function fmtTime(ts) {
  if (!ts) return '未同步'
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function saveBtnText(key) {
  if (props.saving && props.saveKey === key) return '保存中...'
  if (props.saveOk && props.saveKey === key) return '保存成功'
  return '保存数据源'
}
</script>

<style scoped>
@import './SettingsCard.css';

.mapping-status-text {
  font-size: 0.85rem;
  color: var(--text-secondary);
  padding: 0 14px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>