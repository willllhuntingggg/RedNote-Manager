/*
 * RedNote Manager · 页面交互与勾选样式
 * ---------------------------------------------------------------
 * 作用于小红书页面本身：卡片勾选框 + 底部已选条数浮动反馈栏 + 提示浮层
 */
globalThis.RNStyle = `
  /* 卡片勾选框 */
  .rn-pick {
    position: absolute !important;
    top: 6px !important;
    left: 6px !important;
    width: 24px !important;
    height: 24px !important;
    border-radius: 8px !important;
    background: rgba(15, 15, 20, 0.6) !important;
    border: 1.5px solid rgba(255, 255, 255, 0.95) !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4) !important;
    z-index: 9999 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    cursor: pointer !important;
    box-sizing: border-box !important;
    transition: transform 0.14s ease, background 0.14s ease, border-color 0.14s ease !important;
    backdrop-filter: blur(4px) !important;
  }
  .rn-pick::after {
    content: "";
    width: 5px;
    height: 9px;
    border: solid #fff;
    border-width: 0 2.2px 2.2px 0;
    transform: rotate(45deg) translateY(-1px);
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .rn-pick:hover {
    transform: scale(1.12) !important;
    background: rgba(15, 15, 20, 0.88) !important;
  }
  .rn-pick.rn-on {
    background: #ff2e4d !important;
    border-color: #fff !important;
  }
  .rn-pick.rn-on::after {
    opacity: 1 !important;
  }
  .rn-pick.rn-done {
    background: rgba(74, 222, 128, 0.9) !important;
    border-color: #4ade80 !important;
    cursor: default !important;
  }
  .rn-pick.rn-done::after {
    opacity: 1 !important;
  }
  .rn-card-sel {
    outline: 3px solid #ff2e4d !important;
    outline-offset: -3px !important;
    border-radius: 8px !important;
  }
  .rn-card-dim {
    opacity: 0.62 !important;
    transition: opacity 0.18s ease !important;
  }
  .rn-card-done {
    opacity: 0.42 !important;
    filter: grayscale(0.75) !important;
    pointer-events: none !important;
    transition: opacity 0.25s ease, filter 0.25s ease !important;
  }
  html[data-rn-tab="0"] .rn-pick {
    display: none !important;
  }

  /* 底部已选条数浮动反馈栏 */
  .rn-bar-wrap {
    position: fixed !important;
    bottom: 24px !important;
    left: 50% !important;
    transform: translateX(-50%) !important;
    z-index: 2147483600 !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important;
    pointer-events: auto !important;
    display: flex !important;
    align-items: center !important;
    gap: 10px !important;
    padding: 8px 16px !important;
    background: rgba(22, 22, 28, 0.94) !important;
    border: 1px solid rgba(255, 255, 255, 0.18) !important;
    border-radius: 36px !important;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 46, 77, 0.25) !important;
    color: #fff !important;
    backdrop-filter: blur(16px) !important;
    -webkit-backdrop-filter: blur(16px) !important;
    transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease !important;
    box-sizing: border-box !important;
  }
  .rn-bar-wrap.rn-hidden {
    display: none !important;
    opacity: 0 !important;
    transform: translateX(-50%) translateY(28px) scale(0.92) !important;
    pointer-events: none !important;
  }

  /* 页面端筛选状态指示胶囊 */
  .rn-filter-pill {
    position: fixed !important;
    bottom: 24px !important;
    left: 50% !important;
    transform: translateX(-50%) !important;
    z-index: 2147483602 !important;
    display: none !important;
    align-items: center !important;
    gap: 8px !important;
    padding: 6px 14px 6px 12px !important;
    background: rgba(22, 22, 28, 0.94) !important;
    border: 1px solid rgba(255, 255, 255, 0.2) !important;
    border-radius: 30px !important;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 46, 77, 0.22) !important;
    color: #fff !important;
    font-size: 12px !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important;
    backdrop-filter: blur(12px) !important;
    -webkit-backdrop-filter: blur(12px) !important;
    pointer-events: auto !important;
    user-select: none !important;
    transition: bottom 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease !important;
  }
  .rn-filter-pill.rn-show {
    display: flex !important;
  }
  .rn-filter-pill.rn-pill-stacked {
    bottom: 76px !important;
  }
  .rn-filter-pill-icon {
    font-size: 13px !important;
    line-height: 1 !important;
  }
  .rn-filter-pill-text {
    font-weight: 500 !important;
    color: #f1f1f5 !important;
    white-space: nowrap !important;
  }
  .rn-filter-pill-text b {
    color: #ff4d6a !important;
    font-weight: 700 !important;
    margin: 0 2px !important;
  }
  .rn-filter-pill-clear {
    all: unset !important;
    cursor: pointer !important;
    background: rgba(255, 255, 255, 0.12) !important;
    color: #fff !important;
    border: 1px solid rgba(255, 255, 255, 0.18) !important;
    border-radius: 12px !important;
    padding: 2px 8px !important;
    font-size: 11px !important;
    font-weight: 500 !important;
    margin-left: 4px !important;
    transition: all 0.15s ease !important;
    white-space: nowrap !important;
  }
  .rn-filter-pill-clear:hover {
    background: rgba(255, 46, 77, 0.85) !important;
    border-color: #ff2e4d !important;
    color: #fff !important;
  }
  .rn-bar-badge {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 24px !important;
    height: 24px !important;
    border-radius: 50% !important;
    background: linear-gradient(135deg, #ff2e4d, #ff5c78) !important;
    box-shadow: 0 2px 8px rgba(255, 46, 77, 0.45) !important;
    flex: 0 0 auto !important;
  }
  .rn-bar-badge svg {
    width: 13px !important;
    height: 13px !important;
    fill: #fff !important;
  }
  .rn-bar-info {
    display: flex !important;
    align-items: center !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    color: #ededf2 !important;
    white-space: nowrap !important;
    user-select: none !important;
  }
  .rn-bar-count {
    font-weight: 700 !important;
    color: #ff4d6a !important;
    margin: 0 4px !important;
    font-size: 15px !important;
    display: inline-block !important;
    transition: transform 0.16s ease !important;
  }
  .rn-bar-count.rn-bump {
    transform: scale(1.35) !important;
  }
  .rn-bar-sep {
    width: 1px !important;
    height: 14px !important;
    background: rgba(255, 255, 255, 0.2) !important;
    margin: 0 2px !important;
  }
  .rn-bar-btn {
    all: unset !important;
    cursor: pointer !important;
    padding: 4px 10px !important;
    border-radius: 20px !important;
    font-size: 12px !important;
    font-weight: 500 !important;
    color: #cfcfe0 !important;
    background: rgba(255, 255, 255, 0.08) !important;
    border: 1px solid rgba(255, 255, 255, 0.12) !important;
    transition: all 0.15s ease !important;
    white-space: nowrap !important;
    user-select: none !important;
  }
  .rn-bar-btn:hover {
    background: rgba(255, 255, 255, 0.18) !important;
    color: #fff !important;
  }
  .rn-bar-btn.rn-bar-open {
    background: linear-gradient(135deg, #ff2e4d, #ff5c78) !important;
    color: #fff !important;
    border-color: #ff2e4d !important;
    font-weight: 600 !important;
    box-shadow: 0 2px 8px rgba(255, 46, 77, 0.35) !important;
  }
  .rn-bar-btn.rn-bar-open:hover {
    background: linear-gradient(135deg, #ff4664, #ff718a) !important;
  }

  /* 提示浮层 */
  .rn-bar-toast {
    position: absolute !important;
    bottom: calc(100% + 10px) !important;
    left: 50% !important;
    transform: translateX(-50%) translateY(6px) !important;
    background: rgba(18, 18, 24, 0.94) !important;
    border: 1px solid rgba(255, 255, 255, 0.18) !important;
    border-radius: 8px !important;
    padding: 6px 12px !important;
    font-size: 12px !important;
    color: #fff !important;
    white-space: nowrap !important;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.38) !important;
    backdrop-filter: blur(8px) !important;
    pointer-events: none !important;
    opacity: 0 !important;
    transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
    user-select: none !important;
  }
  .rn-bar-toast.rn-show {
    opacity: 1 !important;
    transform: translateX(-50%) translateY(0) !important;
  }

  /* 全局悬浮提示（置于顶部中央，避免遮挡底部操作栏与叠卡操作按钮） */
  .rn-global-toast {
    position: fixed !important;
    top: 30px !important;
    bottom: auto !important;
    left: 50% !important;
    transform: translateX(-50%) translateY(-10px) !important;
    background: rgba(18, 18, 24, 0.94) !important;
    border: 1px solid rgba(255, 255, 255, 0.18) !important;
    border-radius: 20px !important;
    padding: 7px 16px !important;
    font-size: 12.5px !important;
    font-weight: 500 !important;
    color: #fff !important;
    white-space: nowrap !important;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45) !important;
    backdrop-filter: blur(10px) !important;
    -webkit-backdrop-filter: blur(10px) !important;
    pointer-events: none !important;
    opacity: 0 !important;
    z-index: 2147483647 !important;
    transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.16, 1, 0.3, 1) !important;
    user-select: none !important;
  }
  .rn-global-toast.rn-show {
    opacity: 1 !important;
    transform: translateX(-50%) translateY(0) !important;
  }

  /* ================= 叠卡速览模式 (Stack Deck Modal) ================= */
  .rn-stack-overlay {
    position: fixed !important;
    inset: 0 !important;
    z-index: 2147483640 !important;
    background: rgba(10, 10, 14, 0.78) !important;
    display: none !important;
    align-items: center !important;
    justify-content: center !important;
    opacity: 0 !important;
    pointer-events: none !important;
    transition: opacity 0.25s ease !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important;
    user-select: none !important;
  }
  .rn-stack-overlay.rn-open {
    display: flex !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    backdrop-filter: blur(14px) !important;
    -webkit-backdrop-filter: blur(14px) !important;
  }

  .rn-stack-box {
    position: relative !important;
    width: 380px !important;
    max-width: calc(100vw - 32px) !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    gap: 14px !important;
  }

  /* 顶部导航与开关栏 */
  .rn-stack-header {
    width: 100% !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    padding: 0 4px !important;
    color: #fff !important;
  }
  .rn-stack-title-area {
    display: flex !important;
    align-items: center !important;
    gap: 10px !important;
  }
  .rn-stack-order-group {
    display: inline-flex !important;
    background: rgba(255, 255, 255, 0.08) !important;
    border: 1px solid rgba(255, 255, 255, 0.14) !important;
    border-radius: 8px !important;
    padding: 2px !important;
    gap: 2px !important;
  }
  .rn-stack-order-btn {
    all: unset !important;
    cursor: pointer !important;
    padding: 3px 9px !important;
    border-radius: 6px !important;
    font-size: 11.5px !important;
    font-weight: 500 !important;
    color: #a0a0b2 !important;
    transition: all 0.15s ease !important;
    line-height: 1.3 !important;
    user-select: none !important;
  }
  .rn-stack-order-btn:hover {
    color: #ffffff !important;
    background: rgba(255, 255, 255, 0.1) !important;
  }
  .rn-stack-order-btn.rn-active {
    background: #ff2e4d !important;
    color: #ffffff !important;
    font-weight: 600 !important;
    box-shadow: 0 1px 4px rgba(255, 46, 77, 0.4) !important;
  }
  .rn-stack-badge {
    display: none !important;
  }
  .rn-stack-counter {
    font-size: 13px !important;
    color: #b0b0c0 !important;
    font-weight: 500 !important;
  }
  .rn-stack-header-actions {
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
  }
  .rn-stack-header-undo {
    all: unset !important;
    cursor: pointer !important;
    padding: 3px 10px !important;
    border-radius: 12px !important;
    font-size: 11.5px !important;
    font-weight: 600 !important;
    color: #ff8597 !important;
    background: rgba(255, 46, 77, 0.14) !important;
    border: 1px solid rgba(255, 46, 77, 0.35) !important;
    transition: all 0.18s ease !important;
    user-select: none !important;
  }
  .rn-stack-header-undo:hover:not(:disabled) {
    background: rgba(255, 46, 77, 0.28) !important;
    color: #ffffff !important;
    border-color: #ff2e4d !important;
    box-shadow: 0 0 10px rgba(255, 46, 77, 0.35) !important;
  }
  .rn-stack-header-undo:disabled {
    opacity: 0.35 !important;
    cursor: not-allowed !important;
    border-color: rgba(255, 255, 255, 0.1) !important;
    background: rgba(255, 255, 255, 0.05) !important;
    color: #8c8c9e !important;
  }
  .rn-stack-close {
    all: unset !important;
    cursor: pointer !important;
    width: 28px !important;
    height: 28px !important;
    border-radius: 50% !important;
    background: rgba(255, 255, 255, 0.12) !important;
    color: #fff !important;
    font-size: 18px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    transition: background 0.15s ease !important;
  }
  .rn-stack-close:hover {
    background: rgba(255, 255, 255, 0.25) !important;
  }

  /* 自动下一个开关栏 */
  .rn-stack-auto-row {
    width: 100% !important;
    display: flex !important;
    align-items: center !important;
    justify-content: flex-end !important;
    gap: 10px !important;
    font-size: 12px !important;
    color: #cfcfe0 !important;
    padding: 0 4px 6px 4px !important;
  }
  .rn-stack-opt {
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
  }
  .rn-stack-toggle {
    position: relative !important;
    display: inline-block !important;
    width: 34px !important;
    height: 18px !important;
    cursor: pointer !important;
  }
  .rn-stack-toggle input {
    opacity: 0 !important;
    width: 0 !important;
    height: 0 !important;
    position: absolute !important;
  }
  .rn-stack-slider {
    position: absolute !important;
    cursor: pointer !important;
    inset: 0 !important;
    background: #333342 !important;
    border-radius: 18px !important;
    transition: background 0.2s ease !important;
  }
  .rn-stack-slider::before {
    position: absolute !important;
    content: "" !important;
    height: 14px !important;
    width: 14px !important;
    left: 2px !important;
    bottom: 2px !important;
    background: white !important;
    border-radius: 50% !important;
    transition: transform 0.2s ease !important;
  }
  .rn-stack-toggle input:checked + .rn-stack-slider {
    background: #ff2e4d !important;
  }
  .rn-stack-toggle input:checked + .rn-stack-slider::before {
    transform: translateX(16px) !important;
  }

  /* 卡片堆叠区域 */
  .rn-stack-deck {
    position: relative !important;
    width: 100% !important;
    height: 480px !important;
    perspective: 1200px !important;
  }

  /* 底层叠卡通用属性（模拟实体卡片边框、微倾错落与暗调阴影） */
  .rn-card-layer {
    position: absolute !important;
    inset: 0 !important;
    border-radius: 20px !important;
    border: 1px solid rgba(255, 255, 255, 0.14) !important;
    background-size: cover !important;
    background-position: center !important;
    background-repeat: no-repeat !important;
    overflow: hidden !important;
    pointer-events: none !important;
    transition: transform 0.28s cubic-bezier(0.2, 0.85, 0.3, 1), opacity 0.28s ease, box-shadow 0.28s ease !important;
  }

  /* 底层第 2 张（再下一篇）：向右下倾斜微偏，露出右侧边角 */
  .rn-layer-2 {
    transform: translate3d(12px, 16px, -20px) rotate(4.2deg) scale(0.93) !important;
    opacity: 0.55 !important;
    background-color: #14141c !important;
    box-shadow: 0 16px 36px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.08) !important;
    z-index: 2 !important;
  }

  /* 底层第 1 张（下一篇）：向左下轻微倾斜，与第 2 张形成左右交错的自然参差感 */
  .rn-layer-1 {
    transform: translate3d(-10px, 9px, -10px) rotate(-3.2deg) scale(0.965) !important;
    opacity: 0.85 !important;
    background-color: #1a1a24 !important;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.12) !important;
    z-index: 5 !important;
  }

  /* 当顶层卡片飞走时，下一层卡片平滑归正就位，无需突兀的入场动画 */
  .rn-layer-1.rn-layer-promoting {
    transform: translate3d(0, 0, 0) rotate(0deg) scale(1) !important;
    opacity: 1 !important;
    box-shadow: 0 22px 55px rgba(0, 0, 0, 0.68), 0 0 0 1px rgba(255, 255, 255, 0.16) !important;
  }

  /* 当前正面的主卡片 */
  .rn-card-main {
    position: absolute !important;
    inset: 0 !important;
    border-radius: 20px !important;
    background: #1f1f2a !important;
    border: 1px solid rgba(255, 255, 255, 0.18) !important;
    box-shadow: 0 22px 55px rgba(0, 0, 0, 0.68), 0 0 0 1px rgba(255, 255, 255, 0.14) !important;
    display: flex !important;
    flex-direction: column !important;
    overflow: hidden !important;
    z-index: 10 !important;
    transform: translate3d(0, 0, 0) rotate(0deg) scale(1) !important;
  }

  /* 替身卡片：旧卡片飞走时盖在顶层向左甩出并淡出，底层新卡片原地不动直接出现 */
  .rn-card-ghost {
    position: absolute !important;
    inset: 0 !important;
    z-index: 20 !important;
    pointer-events: none !important;
    transform: translate3d(0, 0, 0) rotate(0deg) scale(1) !important;
    transition: transform 0.28s cubic-bezier(0.2, 0.85, 0.3, 1), opacity 0.24s ease !important;
  }
  .rn-card-ghost.rn-ghost-fly-out {
    transform: translate3d(-140%, 15px, 0) rotate(-16deg) scale(0.9) !important;
    opacity: 0 !important;
  }

  /* 点击上一个时：从左侧平滑滑入中央归位 */
  .rn-card-main.rn-entering-from-left {
    transform: translate3d(-135%, 15px, 0) rotate(-15deg) scale(0.92) !important;
    opacity: 0 !important;
    transition: none !important;
  }
  .rn-card-main.rn-enter-active {
    transform: translate3d(0, 0, 0) rotate(0deg) scale(1) !important;
    opacity: 1 !important;
    transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.24s ease !important;
  }

  /* 卡片内部元素 */
  .rn-card-cover-box {
    position: relative !important;
    width: 100% !important;
    height: 330px !important;
    background: #15151c !important;
    overflow: hidden !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
  }
  .rn-card-cover-img {
    width: 100% !important;
    height: 100% !important;
    object-fit: cover !important;
    transition: transform 0.3s ease !important;
  }
  .rn-card-cover-empty {
    color: #666677 !important;
    font-size: 48px !important;
  }

  /* 状态标签（左上角） */
  .rn-card-status-pill {
    position: absolute !important;
    top: 12px !important;
    left: 12px !important;
    padding: 4px 10px !important;
    border-radius: 12px !important;
    font-size: 11px !important;
    font-weight: 600 !important;
    color: #fff !important;
    background: rgba(22, 22, 28, 0.85) !important;
    backdrop-filter: blur(8px) !important;
    -webkit-backdrop-filter: blur(8px) !important;
    border: 1px solid rgba(255, 255, 255, 0.2) !important;
    z-index: 3 !important;
  }
  .rn-card-status-pill.rn-pill-done {
    background: rgba(74, 222, 128, 0.9) !important;
    border-color: #4ade80 !important;
    color: #0d2e14 !important;
  }

  /* 查看原文按钮（右上角） */
  .rn-card-open-btn {
    position: absolute !important;
    top: 12px !important;
    right: 12px !important;
    padding: 4px 11px !important;
    border-radius: 12px !important;
    font-size: 11px !important;
    font-weight: 600 !important;
    color: #ffffff !important;
    background: rgba(22, 22, 28, 0.85) !important;
    backdrop-filter: blur(8px) !important;
    -webkit-backdrop-filter: blur(8px) !important;
    border: 1px solid rgba(255, 255, 255, 0.22) !important;
    text-decoration: none !important;
    cursor: pointer !important;
    display: inline-flex !important;
    align-items: center !important;
    gap: 4px !important;
    z-index: 3 !important;
    transition: all 0.18s ease !important;
    user-select: none !important;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25) !important;
  }
  .rn-card-open-btn:hover {
    background: rgba(255, 46, 77, 0.9) !important;
    border-color: #ff2e4d !important;
    color: #ffffff !important;
    transform: translateY(-1px) !important;
    box-shadow: 0 4px 14px rgba(255, 46, 77, 0.4) !important;
  }

  /* 卡片信息区 */
  .rn-card-info-box {
    flex: 1 !important;
    padding: 14px 16px !important;
    display: flex !important;
    flex-direction: column !important;
    justify-content: space-between !important;
    background: #1f1f2a !important;
  }
  .rn-card-title {
    font-size: 15px !important;
    font-weight: 650 !important;
    color: #fff !important;
    line-height: 1.4 !important;
    max-height: 44px !important;
    overflow: hidden !important;
    display: -webkit-box !important;
    -webkit-line-clamp: 2 !important;
    -webkit-box-orient: vertical !important;
    cursor: pointer !important;
    transition: color 0.15s ease !important;
  }
  .rn-card-title:hover {
    color: #ff2e4d !important;
    text-decoration: underline !important;
  }
  .rn-card-meta {
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    font-size: 11.5px !important;
    color: #8c8c9e !important;
    margin-top: 6px !important;
  }
  .rn-card-author {
    color: #ff8597 !important;
    font-weight: 500 !important;
  }

  /* 底部操作控制区 */
  .rn-stack-actions {
    width: 100% !important;
    box-sizing: border-box !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    gap: 8px !important;
    flex-wrap: nowrap !important;
  }
  .rn-action-nav-btn {
    all: unset !important;
    cursor: pointer !important;
    box-sizing: border-box !important;
    height: 38px !important;
    padding: 0 13px !important;
    border-radius: 19px !important;
    font-size: 12px !important;
    font-weight: 500 !important;
    color: #d1d1e0 !important;
    background: rgba(255, 255, 255, 0.08) !important;
    border: 1px solid rgba(255, 255, 255, 0.15) !important;
    transition: all 0.15s ease !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 4px !important;
    white-space: nowrap !important;
    flex-shrink: 0 !important;
    user-select: none !important;
  }
  .rn-action-nav-btn:hover {
    background: rgba(255, 255, 255, 0.18) !important;
    color: #fff !important;
  }
  .rn-action-nav-btn:disabled {
    opacity: 0.3 !important;
    cursor: not-allowed !important;
  }

  .rn-action-exec-btns {
    flex: 1 !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    min-width: 0 !important;
  }
  .rn-stack-action-btn {
    all: unset !important;
    cursor: pointer !important;
    box-sizing: border-box !important;
    height: 40px !important;
    padding: 0 16px !important;
    border-radius: 20px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 6px !important;
    font-size: 13px !important;
    font-weight: 600 !important;
    letter-spacing: 0.3px !important;
    white-space: nowrap !important;
    transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35) !important;
    user-select: none !important;
  }
  .rn-stack-action-btn svg {
    display: block !important;
    flex-shrink: 0 !important;
    width: 20px !important;
    height: 20px !important;
    transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
  }
  .rn-stack-action-btn:hover:not(:disabled) {
    transform: translateY(-2px) scale(1.03) !important;
  }
  .rn-stack-action-btn:hover:not(:disabled) svg {
    transform: scale(1.15) !important;
  }
  .rn-stack-action-btn:active:not(:disabled) {
    transform: scale(0.96) !important;
  }
  .rn-stack-action-btn:disabled {
    opacity: 0.35 !important;
    cursor: not-allowed !important;
    transform: none !important;
  }

  /* 收藏模式专属按钮高光色彩 */
  .rn-stack-action-btn.rn-btn-uncollect {
    background: linear-gradient(135deg, rgba(255, 184, 0, 0.22), rgba(255, 184, 0, 0.12)) !important;
    border: 1px solid rgba(255, 184, 0, 0.55) !important;
    color: #ffcf4d !important;
    box-shadow: 0 4px 16px rgba(255, 184, 0, 0.25) !important;
  }
  .rn-stack-action-btn.rn-btn-uncollect:hover:not(:disabled) {
    background: linear-gradient(135deg, rgba(255, 184, 0, 0.34), rgba(255, 184, 0, 0.18)) !important;
    border-color: #ffb800 !important;
    color: #ffffff !important;
    box-shadow: 0 6px 20px rgba(255, 184, 0, 0.4) !important;
  }

  /* 点赞模式专属按钮高光色彩 */
  .rn-stack-action-btn.rn-btn-unlike {
    background: linear-gradient(135deg, rgba(255, 46, 77, 0.22), rgba(255, 46, 77, 0.12)) !important;
    border: 1px solid rgba(255, 46, 77, 0.55) !important;
    color: #ff8597 !important;
    box-shadow: 0 4px 16px rgba(255, 46, 77, 0.25) !important;
  }
  .rn-stack-action-btn.rn-btn-unlike:hover:not(:disabled) {
    background: linear-gradient(135deg, rgba(255, 46, 77, 0.34), rgba(255, 46, 77, 0.18)) !important;
    border-color: #ff2e4d !important;
    color: #ffffff !important;
    box-shadow: 0 6px 20px rgba(255, 46, 77, 0.4) !important;
  }

  /* 叠卡模式内按键提示小徽章 */
  .rn-stack-kbd {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace !important;
    font-size: 10px !important;
    font-weight: 600 !important;
    line-height: 1 !important;
    padding: 2px 6px !important;
    border-radius: 4px !important;
    background: rgba(255, 255, 255, 0.18) !important;
    border: 1px solid rgba(255, 255, 255, 0.28) !important;
    color: inherit !important;
    margin-left: 5px !important;
    letter-spacing: 0.3px !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2) !important;
  }
  .rn-stack-nav-kbd {
    display: inline-block !important;
    font-family: inherit !important;
    font-size: 10px !important;
    font-weight: 600 !important;
    opacity: 0.7 !important;
    padding: 1px 4px !important;
    border-radius: 3px !important;
    background: rgba(255, 255, 255, 0.1) !important;
    border: 1px solid rgba(255, 255, 255, 0.2) !important;
    margin-left: 4px !important;
  }

  /* 底部快捷键全局提示栏 */
  .rn-stack-tips {
    width: 100% !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 12px !important;
    font-size: 11px !important;
    color: #8c8c9e !important;
    padding-top: 2px !important;
    user-select: none !important;
  }
  .rn-stack-tips span {
    display: inline-flex !important;
    align-items: center !important;
    gap: 4px !important;
    white-space: nowrap !important;
  }
  .rn-stack-tips kbd {
    display: inline-block !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace !important;
    font-size: 10px !important;
    font-weight: 600 !important;
    line-height: 1 !important;
    padding: 2px 5px !important;
    border-radius: 4px !important;
    color: #c4c4d4 !important;
    background: rgba(255, 255, 255, 0.08) !important;
    border: 1px solid rgba(255, 255, 255, 0.15) !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2) !important;
  }

  .rn-stack-icon-btn {
    all: unset !important;
    cursor: pointer !important;
    box-sizing: border-box !important;
    width: 44px !important;
    height: 44px !important;
    border-radius: 50% !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    background: rgba(255, 255, 255, 0.08) !important;
    border: 1px solid rgba(255, 255, 255, 0.16) !important;
    color: #cfcfe0 !important;
    transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25) !important;
  }
  .rn-stack-icon-btn svg {
    display: block !important;
    flex-shrink: 0 !important;
    transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
  }
  .rn-stack-icon-btn:hover {
    transform: scale(1.12) !important;
    background: rgba(255, 255, 255, 0.16) !important;
  }
  .rn-stack-icon-btn:active {
    transform: scale(0.92) !important;
  }
  .rn-stack-icon-btn:disabled {
    opacity: 0.35 !important;
    cursor: not-allowed !important;
    transform: none !important;
  }

  /* 点赞激活态：红心与柔和光晕 */
  .rn-stack-icon-btn.rn-active-liked {
    background: rgba(255, 36, 66, 0.15) !important;
    border-color: rgba(255, 36, 66, 0.5) !important;
    box-shadow: 0 4px 16px rgba(255, 36, 66, 0.35) !important;
  }
  .rn-stack-icon-btn.rn-active-liked:hover {
    background: rgba(255, 36, 66, 0.25) !important;
    border-color: #ff2442 !important;
  }
  .rn-stack-icon-btn.rn-active-liked svg {
    filter: drop-shadow(0 2px 6px rgba(255, 36, 66, 0.5)) !important;
  }

  /* 收藏激活态：黄金五角星与柔和光晕 */
  .rn-stack-icon-btn.rn-active-collected {
    background: rgba(255, 184, 0, 0.15) !important;
    border-color: rgba(255, 184, 0, 0.5) !important;
    box-shadow: 0 4px 16px rgba(255, 184, 0, 0.35) !important;
  }
  .rn-stack-icon-btn.rn-active-collected:hover {
    background: rgba(255, 184, 0, 0.25) !important;
    border-color: #ffb800 !important;
  }
  .rn-stack-icon-btn.rn-active-collected svg {
    filter: drop-shadow(0 2px 6px rgba(255, 184, 0, 0.5)) !important;
  }
`;
