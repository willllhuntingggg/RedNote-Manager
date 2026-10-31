/*
 * RedNote Manager · Service Worker
 * ---------------------------------------------------------------
 * 职责：
 *   1. 首次安装时写入默认设置
 *   2. 点击工具栏图标时展开 Chrome 原生侧边栏 (openPanelOnActionClick)
 *   3. 响应页面请求展开侧边栏 (chrome.sidePanel.open)
 *   4. 代理页内计数到扩展图标 badge
 */
importScripts('/src/core.js');

const SETTINGS_KEY = 'rn:settings';

// 点击工具栏图标时直接打开侧边栏
if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function (e) {
    console.warn('[RedNote Manager] 配置侧边栏行为失败', e);
  });
}

chrome.runtime.onInstalled.addListener(async function () {
  try {
    const cur = await chrome.storage.local.get(SETTINGS_KEY);
    if (!cur[SETTINGS_KEY]) {
      const defaults = self.RNCore.clampSettings(null);
      await chrome.storage.local.set({ [SETTINGS_KEY]: defaults });
      console.info('[RedNote Manager] 已写入默认设置', defaults);
    }
  } catch (e) {
    console.warn('[RedNote Manager] 初始化设置失败', e);
  }
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'RN_OPEN_SIDE_PANEL') {
    const tabId = sender && sender.tab && sender.tab.id;
    const windowId = sender && sender.tab && sender.tab.windowId;
    if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
      if (typeof tabId === 'number' && tabId >= 0) {
        chrome.sidePanel.open({ tabId: tabId }).catch(function () {
          if (typeof windowId === 'number') {
            chrome.sidePanel.open({ windowId: windowId }).catch(function () {});
          }
        });
      } else if (typeof windowId === 'number') {
        chrome.sidePanel.open({ windowId: windowId }).catch(function () {});
      }
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'RN_BADGE') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (typeof tabId !== 'number' || tabId < 0) return;
    try {
      const p1 = chrome.action.setBadgeText({ tabId: tabId, text: msg.text || '' });
      if (p1 && p1.catch) p1.catch(function () {});
      const p2 = chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: msg.color || '#FF2E4D' });
      if (p2 && p2.catch) p2.catch(function () {});
    } catch (e) { /* 忽略 */ }
    sendResponse({ ok: true });
    return;
  }
});
