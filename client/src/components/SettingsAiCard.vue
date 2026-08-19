<template>
  <section class="card">
    <h2 class="card-title"><IconBrain :size="22" /> AI 分类</h2>
    <div class="sub-title">DeepSeek</div>
    <div class="field">
      <span class="label">API 地址</span>
      <input v-model="form.deepseek.baseUrl" placeholder="https://api.deepseek.com" />
      <button class="icon-btn" :class="testStates.deepseek" :title="testLabel(testStates.deepseek)" :disabled="testStates.deepseek === 'testing'" @click="$emit('test', 'deepseek', form.deepseek.baseUrl)">
        <IconPlugConnected v-if="testStates.deepseek === 'idle'" :size="16" />
        <span v-else-if="testStates.deepseek === 'testing'" class="mini-spinner" />
        <IconCircleCheck v-else-if="testStates.deepseek === 'success'" :size="16" />
        <IconCircleX v-else :size="16" />
      </button>
    </div>
    <div class="field">
      <span class="label">API Key</span>
      <div class="input-wrap">
        <input :type="showKey ? 'text' : 'password'" v-model="form.deepseek.apiKey" placeholder="点击输入 Key" />
      </div>
      <button v-if="form.deepseek.apiKey" class="icon-btn eye" :class="{ show: showKey }" @click="showKey = !showKey">
        <IconEye v-if="!showKey" :size="18" />
        <IconEyeOff v-else :size="18" />
      </button>
      <span v-else class="slot-placeholder"></span>
    </div>
    <div class="field">
      <span class="label">模型</span>
      <input v-model="form.deepseek.model" placeholder="deepseek-v4-flash" />
      <span class="slot-placeholder"></span>
    </div>

    <div class="card-save">
      <button class="save-btn" :class="{ saving: saving && saveKey === 'ai', ok: saveOk && saveKey === 'ai' }" :disabled="saving && saveKey === 'ai'" @click="$emit('save', 'ai')">
        <IconCircleCheck v-if="saveOk && saveKey === 'ai'" :size="16" class="save-check-icon" />
        <IconDeviceFloppy v-else :size="16" />
        <span>{{ saveBtnText('ai') }}</span>
      </button>
    </div>
  </section>
</template>

<script setup>
import { ref } from 'vue'
import { IconBrain, IconPlugConnected, IconCircleCheck, IconCircleX, IconEye, IconEyeOff, IconDeviceFloppy } from '@tabler/icons-vue'

const props = defineProps({
  form: Object,
  testStates: Object,
  saving: Boolean,
  saveKey: String,
  saveOk: Boolean,
})

defineEmits(['test', 'save'])

const showKey = ref(false)

function testLabel(state) {
  const map = { idle: '测试连接', testing: '测试中...', success: '测试成功 ✓', error: '测试失败 ✕' }
  return map[state] || '测试连接'
}

function saveBtnText(key) {
  if (props.saving && props.saveKey === key) return '保存中...'
  if (props.saveOk && props.saveKey === key) return '保存成功'
  return '保存 AI'
}
</script>

<style scoped>
@import './SettingsCard.css';
</style>