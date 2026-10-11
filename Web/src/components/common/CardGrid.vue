<template>
  <!-- 外层是普通 div：栅格样式（.anime-grid）需要有真元素承载；
       TransitionGroup 不写 tag 时渲染成 Fragment，本来也接不到 class。
       ⚠️ 别给 TransitionGroup 挂 ref：模板 ref 挂在组件上拿到的是 null（踩过这个坑）。 -->
  <div class="anime-grid">
    <TransitionGroup name="cards" appear>
      <div
        v-for="(item, index) in items"
        :key="orderKeyOf(item)"
        class="card-cell"
        :style="{ '--stagger': `${Math.min(index * stagger, staggerMax)}ms` }"
      >
        <slot :item="item" :index="index" />
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import { orderKeyOf } from '@/utils/orderKey'

/**
 * 卡片网格（全站复用的列表外壳）
 * ---------------------------------------------------------------------------
 * 只管「怎么摆」，不管「摆什么、按什么顺序」：
 *   1. 画成自适应栅格（列宽 / 间距见 styles/base.css 的 .anime-grid）
 *   2. 每格包一层 .card-cell，并用**作品主键**做 :key（同名作品不会串 DOM）
 *   3. 入场错落按 index 自动算，使用方不用再写 transitionDelay
 *   4. 外面套 <TransitionGroup name="cards">：增删 / 换序自带过渡动画
 *
 * 以后要加搜索、按评分升序、只看未看……都**不用动这个组件** —— 在页面里把数组算好
 * （computed）再传给 items 即可：
 *   :items="keyword ? group.items.filter((i) => i.title.includes(keyword)) : group.items"
 * 将来真需要「拖拽排序 / 无限滚动」这类交互时，再在这里加一层能力：组件只上抛事件，
 * 状态留在页面（不要把它变成有状态的列表管理器）。
 *
 * 用法：
 *   <CardGrid :items="group.items">
 *     <template #default="{ item }">
 *       <PosterCard :title="item.title" :poster="item.poster" />
 *     </template>
 *   </CardGrid>
 */
defineProps({
  /** 当前要显示的那一批数据（顺序、筛选都由使用方算好） */
  items: { type: Array, default: () => [] },
  /** 入场错落单步时长（ms） */
  stagger: { type: Number, default: 25 },
  /** 入场错落上限（ms）—— 条目多时避免最后几张等太久 */
  staggerMax: { type: Number, default: 400 },
})
</script>

<style scoped>
/* 每格只是容器：卡片本体外观全在卡片组件里 */
.card-cell {
  min-width: 0;
}

/* 入场延迟走变量，避免内联 transition-delay 把「位置交换动画」也一起拖慢 */
.card-cell.cards-enter-active {
  transition-delay: var(--stagger, 0ms);
}
</style>
