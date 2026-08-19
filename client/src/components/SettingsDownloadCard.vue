<template>
  <section class="card">
    <h2 class="card-title"><IconCloudDownload :size="22" /> 下载器</h2>

    <div class="sub-title">qBittorrent</div>
    <div class="field">
      <span class="label">WebUI 地址</span>
      <input v-model="form.qbittorrent.url" placeholder="http://192.168.1.1:8080" />
      <button class="icon-btn" :class="testStates.qb" :title="testLabel(testStates.qb)" :disabled="testStates.qb === 'testing'" @click="$emit('test', 'qb', form.qbittorrent.url)">
        <IconPlugConnected v-if="testStates.qb === 'idle'" :size="16" />
        <span v-else-if="testStates.qb === 'testing'" class="mini-spinner" />
        <IconCircleCheck v-else-if="testStates.qb === 'success'" :size="16" />
        <IconCircleX v-else :size="16" />
      </button>
    </div>
    <div class="field">
      <span class="label">登录令牌</span>
      <div class="input-wrap">
        <input :type="showToken ? 'text' : 'password'" v-model="form.qbittorrent.token" placeholder="留空则使用默认值" />
      </div>
      <button v-if="form.qbittorrent.token" class="icon-btn eye" :class="{ show: showToken }" @click="showToken = !showToken">
        <IconEye v-if="!showToken" :size="18" />
        <IconEyeOff v-else :size="18" />
      </button>
      <span v-else class="slot-placeholder"></span>
    </div>
    <div class="field">
      <span class="label">保存目录</span>
      <input v-model="form.qbittorrent.basePath" placeholder="/downloads/anime" />
      <span class="slot-placeholder"></span>
    </div>

    <div class="sub-title">迅雷远程</div>
    <div class="field">
      <span class="label">WebUI 地址</span>
      <input v-model="form.xunlei.url" placeholder="http://192.168.1.1:2345" />
      <button class="icon-btn" :class="testStates.xunlei" :title="testLabel(testStates.xunlei)" :disabled="testStates.xunlei === 'testing'" @click="$emit('test', 'xunlei', form.xunlei.url)">
        <IconPlugConnected v-if="testStates.xunlei === 'idle'" :size="16" />
        <span v-else-if="testStates.xunlei === 'testing'" class="mini-spinner" />
        <IconCircleCheck v-else-if="testStates.xunlei === 'success'" :size="16" />
        <IconCircleX v-else :size="16" />
      </button>
    </div>

    <div class="card-save">
      <button class="save-btn" :class="{ saving: saving && saveKey === 'download', ok: saveOk && saveKey === 'download' }" :disabled="saving && saveKey === 'download'" @click="$emit('save', 'download')">
        <IconCircleCheck v-if="saveOk && saveKey === 'download'" :size="16" class="save-check-icon" />
        <IconDeviceFloppy v-else :size="16" />
        <span>{{ saveBtnText('download') }}</span>
      </button>
    </div>
  </section>
</template>

<script setup>
import { ref } from 'vue'
import { IconCloudDownload, IconPlugConnected, IconCircleCheck, IconCircleX, IconEye, IconEyeOff, IconDeviceFloppy } from '@tabler/icons-vue'

const props = defineProps({
  form: Object,
  testStates: Object,
  saving: Boolean,
  saveKey: String,
  saveOk: Boolean,
})

defineEmits(['test', 'save'])

const showToken = ref(false)

function testLabel(state) {
  const map = { idle: '测试连接', testing: '测试中...', success: '测试成功 ✓', error: '测试失败 ✕' }
  return map[state] || '测试连接'
}

function saveBtnText(key) {
  if (props.saving && props.saveKey === key) return '保存中...'
  if (props.saveOk && props.saveKey === key) return '保存成功'
  return '保存下载器'
}
</script>

<style scoped>
@import './SettingsCard.css';
</style>
