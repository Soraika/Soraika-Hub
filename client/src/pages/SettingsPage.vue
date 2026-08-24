<template>
  <div class="settings">
    <h1 class="page-title">设置</h1>

    <div v-if="loading" class="state">
      <div class="spinner"></div>
      <span>加载配置...</span>
    </div>

    <div v-else-if="error" class="state">
      <IconAlertCircle :size="48" />
      <p>加载失败，请检查网络连接</p>
      <button @click="loadConfig" class="retry-btn">重试</button>
    </div>

    <div v-else class="cards">
      <div v-if="saveError" class="save-error">
        <IconAlertCircle :size="16" /> {{ saveError }}
      </div>
      <SettingsDownloadCard
        :form="form"
        :testStates="testStates"
        :saving="saving"
        :saveKey="saveKey"
        :saveOk="saveOk"
        @test="testUrl"
        @save="save"
      />
      <SettingsAiCard
        :form="form"
        :testStates="testStates"
        :saving="saving"
        :saveKey="saveKey"
        :saveOk="saveOk"
        @test="testUrl"
        @save="save"
      />
      <SettingsSourceCard
        :form="form"
        :testStates="testStates"
        :bgmNoToken="bgmNoToken"
        :saving="saving"
        :saveKey="saveKey"
        :saveOk="saveOk"
        :mappingStatus="mappingStatus"
        :syncingMapping="syncingMapping"
        @test="testUrl"
        @toggleBgmNoToken="bgmNoToken = !bgmNoToken"
        @syncMapping="syncMapping"
        @save="save"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { IconAlertCircle } from '@tabler/icons-vue'
import { getConfig, updateConfig, getMikanMapping, syncMikanMapping } from '@/api'
import SettingsDownloadCard from '@/components/SettingsDownloadCard.vue'
import SettingsAiCard from '@/components/SettingsAiCard.vue'
import SettingsSourceCard from '@/components/SettingsSourceCard.vue'

const loading = ref(true)
const error = ref(false)
const saving = ref(false)
const saveOk = ref(false)
const saveKey = ref('')
const saveError = ref('')
const bgmNoToken = ref(false)
const mappingStatus = ref(null)
const syncingMapping = ref(false)

const testStates = reactive({
  qb: 'idle', xunlei: 'idle', deepseek: 'idle', mikan: 'idle', bgm: 'idle', mapping: 'idle',
})

const form = reactive({
  qbittorrent: { url: '', token: '', basePath: '' },
  xunlei: { url: '' },
  deepseek: { baseUrl: '', apiKey: '', model: '' },
  mikan: { baseUrl: '', mappingUrl: '' },
  bgm: { baseUrl: '', token: '' },
})

async function testUrl(key, url) {
  if (!url || testStates[key] === 'testing') return
  testStates[key] = 'testing'
  try {
    const controller = new AbortController()
    const to = setTimeout(() => controller.abort(), 5000)
    await fetch(url, { method: 'HEAD', signal: controller.signal, mode: 'no-cors' })
    clearTimeout(to)
    testStates[key] = 'success'
  } catch {
    testStates[key] = 'error'
  }
}

async function loadConfig() {
  loading.value = true
  error.value = false
  try {
    const { data } = await getConfig()
    const c = data.config || {}
    form.qbittorrent = {
      url: c.qbittorrent?.url || '',
      token: c.qbittorrent?.token || '',
      basePath: c.qbittorrent?.basePath || '',
    }
    form.xunlei = { url: c.xunlei?.url || '' }
    form.deepseek = {
      baseUrl: c.deepseek?.baseUrl || '',
      apiKey: c.deepseek?.apiKey || '',
      model: c.deepseek?.model || '',
    }
    form.mikan = {
      baseUrl: c.mikan?.baseUrl || '',
      mappingUrl: c.mikan?.mappingUrl || 'https://raw.githubusercontent.com/xiaoyvyv/bangumi-data/main/data/mikan/bangumi-mikan.json',
    }
    form.bgm = { baseUrl: c.bgm?.baseUrl || '', token: c.bgm?.token || '' }
    bgmNoToken.value = !c.bgm?.token
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

async function loadMappingStatus() {
  try {
    const { data } = await getMikanMapping()
    mappingStatus.value = data && data.ok ? data : null
  } catch {
    mappingStatus.value = null
  }
}

async function syncMapping() {
  if (syncingMapping.value) return
  syncingMapping.value = true
  try {
    const { data } = await syncMikanMapping()
    mappingStatus.value = data || null
    testStates.mapping = data?.ok ? 'success' : 'error'
  } catch {
    testStates.mapping = 'error'
  } finally {
    syncingMapping.value = false
  }
}

async function save(key) {
  saveOk.value = false
  saveError.value = ''
  saveKey.value = key
  saving.value = true
  try {
    const body = {
      qbittorrent: { ...form.qbittorrent },
      xunlei: { ...form.xunlei },
      deepseek: { ...form.deepseek },
      mikan: { ...form.mikan },
      bgm: { ...form.bgm },
    }
    if (bgmNoToken.value) body.bgm.token = ''

    await updateConfig(body)
    saveOk.value = true
  } catch (e) {
    saveOk.value = false
    saveError.value = e?.response?.data?.error || '保存失败：无法连接服务器或写入配置'
  } finally {
    saving.value = false
    setTimeout(() => { saveOk.value = false; saveKey.value = '' }, 2500)
  }
}

onMounted(() => {
  loadConfig()
  loadMappingStatus()
})
</script>

<style scoped>
.settings { padding: 32px 40px; }
.page-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 32px; color: var(--text-primary); }

.state { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 80px 0; color: var(--text-secondary); }
.spinner {
  width: 36px; height: 36px; border: 3px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.retry-btn { background: var(--accent); color: #fff; padding: 10px 24px; border-radius: var(--radius); font-size: 0.9rem; border: none; cursor: pointer; }

.cards { display: flex; flex-direction: column; gap: 24px; }

.save-error {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.35);
  color: #ef4444;
  font-size: 0.85rem;
  padding: 10px 14px;
  border-radius: 8px;
}
</style>