<template>
  <div class="poster-image" :style="{ aspectRatio: ratio }">
    <!-- 有图源：先透明后淡入，避免「啪」地跳出 -->
    <img
      v-if="src && !failed"
      class="poster-img"
      :class="{ loaded }"
      :src="src"
      :alt="alt"
      loading="lazy"
      decoding="async"
      @load="loaded = true"
      @error="failed = true"
    />

    <!-- 无图源 / 加载失败：占位底纹（不撑破布局） -->
    <div v-else class="poster-placeholder">
      <slot name="placeholder">
        <IconPhotoOff :size="28" :stroke-width="1.4" />
        <span v-if="placeholderText" class="placeholder-text">{{ placeholderText }}</span>
      </slot>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { IconPhotoOff } from '@tabler/icons-vue'

/**
 * 海报图（纯展示 + 加载态）
 * 固定比例容器，图片 cover 裁切；未加载/失败时显示占位底纹，永不撑破卡片布局。
 *
 * TODO: 底层出图接口就绪后，这里改为「只传 mikanId / bgmId」→ 由统一出图入口取图，
 *       并加入同屏可见才请求的懒加载队列（当前 src 只接受最终图片地址）。
 */
const props = defineProps({
  /** 图片地址（当前阶段可由页面直接传外链） */
  src: { type: String, default: '' },
  /** 无障碍替代文本（一般传番名） */
  alt: { type: String, default: '' },
  /** 固定宽高比，默认 3:4 竖版海报 */
  ratio: { type: String, default: '3 / 4' },
  /** 占位区提示文字（留空则只显示图标） */
  placeholderText: { type: String, default: '' },
})

const loaded = ref(false)
const failed = ref(false)

// 复用组件实例换图时复位加载状态（列表筛选/翻页会复用同一实例）
watch(
  () => props.src,
  () => {
    loaded.value = false
    failed.value = false
  }
)
</script>

<style scoped>
.poster-image {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-poster);
  overflow: hidden;
}

.poster-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity var(--dur-slow) var(--ease-out), transform var(--dur-slow) var(--ease-out);
}
.poster-img.loaded {
  opacity: 1;
}

.poster-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 100%;
  color: var(--text-tertiary);
  background: linear-gradient(150deg, var(--bg-poster) 0%, var(--bg-hover) 100%);
}
.placeholder-text {
  font-size: 0.75rem;
  letter-spacing: 0.04em;
}
</style>
