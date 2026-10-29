<template>
  <div class="skeleton" aria-hidden="true">
    <!-- 头部：海报 + 标题（与真实详情同尺寸，数据到了不跳） -->
    <header class="sk-header">
      <div class="sk-poster sk-fill" />
      <div class="sk-head-text">
        <div class="sk-bar sk-fill w-80" />
        <div class="sk-bar sk-fill w-50" />
        <div class="sk-chips">
          <div class="sk-chip sk-fill" />
          <div class="sk-chip sk-fill" />
        </div>
      </div>
    </header>

    <!-- 信息卡：评分 + 放送/首播 + 标签 -->
    <section class="sk-card">
      <div class="sk-row">
        <div class="sk-bar sk-fill w-20" />
        <div class="sk-bar sk-fill w-30" />
      </div>
      <div class="sk-bar sk-fill w-45" />
      <div class="sk-bar sk-fill w-35" />
      <div class="sk-chips">
        <div class="sk-chip sk-fill" />
        <div class="sk-chip sk-fill" />
        <div class="sk-chip sk-fill" />
      </div>
    </section>

    <!-- 简介卡 -->
    <section class="sk-card">
      <div class="sk-bar sk-fill w-25" />
      <div class="sk-bar sk-fill w-100" />
      <div class="sk-bar sk-fill w-95" />
      <div class="sk-bar sk-fill w-60" />
    </section>

    <!-- 资源区占位：先占住高度，数据到了不会突然长出一大块 -->
    <section class="sk-card">
      <div class="sk-row">
        <div class="sk-chip sk-fill" />
        <div class="sk-chip sk-fill" />
        <div class="sk-chip sk-fill" />
        <div class="sk-chip sk-fill" />
      </div>
      <div class="sk-bar sk-fill w-100" />
      <div class="sk-bar sk-fill w-90" />
    </section>
  </div>
</template>

<script setup>
/**
 * 详情面板的骨架屏（纯展示）
 * ---------------------------------------------------------------------------
 * 为什么不用整块转圈：换作品时整块 spinner 会把面板"抽空"再长回来（看着像整页在进）。
 * 骨架屏**照着详情的位置铺占位块**（海报 / 标题 / 标签 / 简介 / 资源区），
 * 数据到了就地替换 —— 动的只有"那些位置"，版面不跳。
 *
 * 尺寸与真实详情对齐（海报 96px 3:4、卡片圆角与内边距一致），所以替换时不会抖动。
 * 动效是一条扫光（`sk-sweep`），比转圈安静，也更符合"局部在刷新"的语义。
 */
</script>

<style scoped>
.skeleton {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sk-header {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding-right: 34px; /* 与真实头部一致：给右上角关闭按钮让位 */
}
.sk-poster {
  width: 96px;
  aspect-ratio: 3 / 4;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
}
.sk-head-text {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding-top: 4px;
}

.sk-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px; /* 与 .card 一致 */
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-input);
}

.sk-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sk-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 占位块本体：底色 + 一条从左到右的扫光 */
.sk-fill {
  position: relative;
  overflow: hidden;
  background: var(--bg-hover);
}
.sk-bar {
  height: 12px;
  border-radius: var(--radius-pill);
}
.sk-chip {
  width: 54px;
  height: 18px;
  border-radius: var(--radius-pill);
}
.w-20 {
  width: 20%;
}
.w-25 {
  width: 25%;
}
.w-30 {
  width: 30%;
}
.w-35 {
  width: 35%;
}
.w-45 {
  width: 45%;
}
.w-50 {
  width: 50%;
}
.w-60 {
  width: 60%;
}
.w-80 {
  width: 80%;
}
.w-90 {
  width: 90%;
}
.w-95 {
  width: 95%;
}
.w-100 {
  width: 100%;
}

.sk-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, var(--border) 50%, transparent);
  animation: sk-sweep 1.3s var(--ease-out) infinite;
}
@keyframes sk-sweep {
  to {
    transform: translateX(100%);
  }
}
</style>
