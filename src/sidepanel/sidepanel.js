/*
 * RedNote Manager · Chrome 原生侧边栏脚本
 * ---------------------------------------------------------------
 * 职责：
 *   - 作为主交互界面，展示统计看板、搜索筛选、候选列表与实时日志
 *   - 与当前激活的小红书标签页 content.js 通信，双向同步勾选状态
 */
'use strict';

const C = globalThis.RNCore;
const RNAI = globalThis.RNAI;
const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

const CUP_SVG_INLINE = '<svg class="rn-cup-icon rn-cup-inline" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6.5C7 5.67 7.67 5 8.5 5H15.5C16.33 5 17 5.67 17 6.5V7H7V6.5Z" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="0.8"/><rect x="5.5" y="7" width="13" height="2.2" rx="1.1" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="0.6"/><path d="M6.6 9.2L7.8 19.3C7.9 20.3 8.7 21 9.7 21H14.3C15.3 21 16.1 20.3 16.2 19.3L17.4 9.2H6.6Z" fill="#1E3A8A"/><path d="M7.1 13.2C8.6 14.3 10.3 14.6 12 14C13.7 13.4 15.4 13.6 16.9 14.3L16.2 19.3C16.1 20.3 15.3 21 14.3 21H9.7C8.7 21 7.9 20.3 7.8 19.3L7.1 13.2Z" fill="#FFFFFF"/><circle cx="12" cy="11.4" r="1.1" fill="#FFFFFF"/></svg>';

let activeTabId = null;
let pollTimer = null;
let lastState = null;
let settingsOpen = false;
let aiTagsCache = {};
let activeTagFilter = 'all';
let isAiAnalyzing = false;
let showProcessedNotes = false;
let sidepanelPort = null;

function ensurePortConnection(tabId) {
  if (typeof tabId !== 'number') return;
  if (sidepanelPort && sidepanelPort.__tabId === tabId) return;
  if (sidepanelPort) {
    try { sidepanelPort.disconnect(); } catch (e) {}
    sidepanelPort = null;
  }
  try {
    if (chrome.tabs && chrome.tabs.connect) {
      sidepanelPort = chrome.tabs.connect(tabId, { name: 'rn-sidepanel' });
      sidepanelPort.__tabId = tabId;
      sidepanelPort.onDisconnect.addListener(function () {
        sidepanelPort = null;
      });
    }
  } catch (e) {
    sidepanelPort = null;
  }
}

/* ============================ 与当前标签页通信 ============================ */

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs && tabs[0]) return tabs[0];
  const allTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return allTabs && allTabs[0] ? allTabs[0] : null;
}

async function sendToTab(type, data) {
  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== 'number') return null;
  activeTabId = tab.id;
  ensurePortConnection(activeTabId);
  try {
    return await chrome.tabs.sendMessage(activeTabId, Object.assign({ type: type }, data || {}));
  } catch (e) {
    console.warn('[RedNote Sidepanel] 发送消息异常:', e);
    return null;
  }
}

async function requestState() {
  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== 'number') {
    renderDisconnected('未找到激活的标签页');
    return;
  }
  activeTabId = tab.id;
  ensurePortConnection(activeTabId);

  const url = tab.url || '';
  const isXhs = /xiaohongshu\.com|rednote\.com/.test(url);
  if (!isXhs) {
    renderDisconnected('当前不是小红书页面。<br>请在左侧浏览器中打开小红书（xiaohongshu.com）。');
    return;
  }

  const res = await sendToTab('RN_GET_STATE');
  if (!res || !res.ok || !res.state) {
    renderDisconnected('尚未检测到小红书页面就绪。<br>请打开小红书「我的主页 → 收藏 / 赞过」，或刷新页面。');
    return;
  }

  applyState(res.state);
}

/* ============================ 状态渲染 ============================ */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function titleOf(note) {
  const t = (note && note.title) || '未命名笔记';
  return t.length > 34 ? t.slice(0, 34) + '…' : t;
}

function getUnprocessedCandidates(st) {
  if (!st) return [];
  const list = Array.isArray(st.candidates) ? st.candidates : [];
  if (showProcessedNotes) return list;
  const mode = st.mode || 'uncollect';
  const processedSet = new Set((st.processed && st.processed[mode]) || []);
  if (processedSet.size === 0) return list;
  return list.filter(function (n) { return !processedSet.has(n.id); });
}

function getFilteredVisible(candidates, query, tagFilter) {
  let list = (candidates || []).slice();
  if (lastState && !showProcessedNotes) {
    const mode = lastState.mode || 'uncollect';
    const processedSet = new Set((lastState.processed && lastState.processed[mode]) || []);
    if (processedSet.size > 0) {
      list = list.filter(function (n) { return !processedSet.has(n.id); });
    }
  }
  if (query) {
    const terms = C.parseKeywords(query);
    list = list.filter(function (n) {
      return C.matchKeywords(n, terms);
    });
  }
  const tf = tagFilter !== undefined ? tagFilter : activeTagFilter;
  if (tf && tf !== 'all') {
    list = list.filter(function (n) {
      const info = aiTagsCache[n.id];
      if (!info) return false;
      return info.decision === tf || info.category === tf;
    });
  }
  return list;
}

function renderDisconnected(message) {
  lastState = null;
  $('rn-s-cand').textContent = '–';
  $('rn-s-sel').textContent = '–';
  $('rn-s-ok').textContent = '–';
  $('rn-s-fail').textContent = '–';
  $('rn-hit').textContent = '0/0';
  $('rn-sel-count').textContent = '已选 0';
  $('rn-bar').style.width = '0%';
  $('rn-start').disabled = true;
  $('rn-stop').disabled = true;
  $('rn-scan').disabled = true;
  $('rn-undo').disabled = true;
  $('rn-list').innerHTML = '<div class="rn-empty">' + message + '</div>';

  const alert = $('rn-alert');
  alert.innerHTML = message;
  alert.hidden = false;
}

function applyState(st) {
  if (!st) return;
  lastState = st;

  const s = st.settings || {};
  const isRunning = !!st.running;

  // 顶部提示
  const alert = $('rn-alert');
  if (!st.onProfile) {
    alert.innerHTML = '提示：当前不在你的个人主页。请进入「我的主页 → 收藏 / 赞过」后再操作。';
    alert.hidden = false;
  } else if (st.risk) {
    alert.innerHTML = '⛔ 触发风控熔断，已停止！建议休息 30 分钟后再试。';
    alert.hidden = false;
  } else if (st.isOwnNotes) {
    alert.innerHTML = '💡 当前在「我的笔记」（原创发布）页面。受安全保护不会读取您的原创笔记，请在左侧小红书切换至「收藏」或「赞过」列表。';
    alert.hidden = false;
  } else {
    alert.hidden = true;
  }

  // 模式 Tab
  const counts = st.cacheCounts || {};
  const uncollectNum = counts.uncollect !== undefined ? counts.uncollect : 0;
  const unlikeNum = counts.unlike !== undefined ? counts.unlike : 0;

  $$('.rn-tab').forEach(function (btn) {
    const isCur = btn.dataset.mode === st.mode;
    btn.classList.toggle('rn-on', isCur);
    btn.disabled = isRunning;
    const modeKey = btn.dataset.mode;
    const num = modeKey === 'uncollect' ? uncollectNum : unlikeNum;
    const badge = btn.querySelector('.rn-badge-cnt');
    if (badge && badge.textContent !== String(num)) {
      badge.textContent = String(num);
    }
  });

  const M = C && C.MODES ? C.MODES[st.mode] : null;
  $('rn-hint').textContent = M ? M.tabLabel : '小红书主页';

  // 统计看板（已处理的笔记不进入候选与计数）
  const allCandidates = Array.isArray(st.candidates) ? st.candidates : [];
  const processedSet = new Set((st.processed && st.processed[st.mode]) || []);
  const processedOnPage = allCandidates.filter(function (n) { return processedSet.has(n.id); }).length;

  const candList = getUnprocessedCandidates(st);
  const candCount = candList.length;
  const selCount = Array.isArray(st.selected) ? st.selected.length : (st.selectedCount || 0);
  $('rn-s-cand').textContent = String(candCount);
  if (processedOnPage > 0 && !showProcessedNotes) {
    $('rn-s-cand').title = '待处理 ' + candCount + ' 篇（页面共读取 ' + allCandidates.length + ' 篇，已隐藏 ' + processedOnPage + ' 篇已处理）';
  } else {
    $('rn-s-cand').removeAttribute('title');
  }
  $('rn-s-sel').textContent = String(selCount);
  $('rn-s-ok').textContent = String((st.stats && st.stats.ok) || processedOnPage);
  $('rn-s-fail').textContent = String(st.stats ? st.stats.fail : 0);

  // 进度条
  const total = (st.stats && st.stats.total) || 0;
  const done = (st.stats && (st.stats.ok + st.stats.fail)) || 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  $('rn-bar').style.width = pct + '%';

  // 控制按钮
  const startBtn = $('rn-start');
  const stopBtn = $('rn-stop');
  const scanBtn = $('rn-scan');
  const undoBtn = $('rn-undo');

  const isScanning = !!st.scanning;

  startBtn.disabled = isRunning || isScanning || !candCount || !selCount;
  stopBtn.disabled = !isRunning && !isScanning;
  scanBtn.disabled = isRunning || isScanning;

  if (isScanning) {
    scanBtn.textContent = '正在读取…';
  } else {
    scanBtn.textContent = '① 读取列表';
  }

  // 动态更新两处撤销按钮（设置抽屉内 + 底部操作记录栏）
  const undoBtns = [$('rn-undo'), $('rn-log-undo')].filter(Boolean);
  const lastUndo = st.lastUndo;
  undoBtns.forEach(function (btn) {
    if (isRunning || isScanning) {
      btn.disabled = true;
    } else if (lastUndo && lastUndo.canUndo) {
      btn.disabled = false;
      if (lastUndo.type === 'single') {
        btn.textContent = '↩️ 撤销单篇';
        btn.title = '撤销最近划走/处理的单篇笔记：' + (lastUndo.title || lastUndo.noteId);
      } else {
        btn.textContent = '↩️ 撤销上次 (' + lastUndo.count + '篇)';
        btn.title = '撤销最近批量处理的 ' + lastUndo.count + ' 篇笔记';
      }
    } else {
      btn.disabled = true;
      btn.textContent = '↩️ 撤销上次';
      btn.title = '当前没有可撤销的操作记录';
    }
  });

  const actionVerb = st.mode === 'unlike' ? '取消点赞' : '取消收藏';
  if (isScanning) {
    const planned = Math.min(selCount, s.maxPerRun || 30);
    startBtn.textContent = selCount ? (actionVerb + '（' + planned + ' 篇）') : actionVerb;
    stopBtn.title = '点击即可随时停止当前列表扫描';
  } else if (isRunning) {
    startBtn.textContent = '正在' + actionVerb + '…';
    stopBtn.title = '点击即可安全停止当前批量操作';
  } else {
    const planned = Math.min(selCount, s.maxPerRun || 30);
    startBtn.textContent = selCount ? (actionVerb + '（' + planned + ' 篇）') : actionVerb;
    stopBtn.title = '仅在批量执行运行中时激活，可随时手动停止';
  }

  ['rn-sel-all', 'rn-sel-invert', 'rn-sel-clear', 'rn-btn-stack'].forEach(function (id) {
    const b = $(id);
    if (b) b.disabled = isRunning || !candCount;
  });

  // 搜索框状态同步与即时筛选
  const qEl = $('rn-q');
  const qClearEl = $('rn-search-clear');
  const userEditing = qEl && document.activeElement === qEl;
  if (!userEditing && s.keyword !== undefined && qEl && s.keyword !== qEl.value) {
    qEl.value = s.keyword;
  }
  if (qClearEl && qEl) {
    qClearEl.hidden = !qEl.value;
  }
  const currentQuery = (qEl ? qEl.value : '').trim();

  // 根据当前搜索词与标签筛选过滤出展示内容
  const visList = getFilteredVisible(candList, currentQuery, activeTagFilter);

  // 搜索结果与筛选统计
  $('rn-hit').textContent = visList.length + '/' + candCount;

  const selectedSet = new Set(st.selected || []);
  const visSelCount = visList.filter(function (n) { return selectedSet.has(n.id); }).length;
  const hiddenCount = Math.max(0, selCount - visSelCount);
  let selText = '已选 ' + selCount;
  if (hiddenCount > 0) {
    selText += ' · 隐藏 ' + hiddenCount;
  } else if (processedOnPage > 0 && !showProcessedNotes) {
    selText += ' · 隐藏 ' + processedOnPage + ' 篇已处理';
  }
  $('rn-sel-count').textContent = selText;
  if (processedOnPage > 0) {
    $('rn-sel-count').title = '点击可在「仅看待处理」与「显示全部（含已处理）」之间切换';
  } else {
    $('rn-sel-count').removeAttribute('title');
  }

  // 渲染 AI 标签胶囊栏
  renderTagChips(candList);

  // 渲染笔记列表（在下方展示过滤命中的笔记）
  renderList(candList, visList, st, currentQuery);

  // 渲染设置项
  syncSettings(s);

  // 渲染日志
  renderLogs(st.logs || []);
}

function renderTagChips(candidates) {
  const bar = $('rn-tag-filter-bar');
  const container = $('rn-tag-chips');
  if (!bar || !container) return;

  const candList = candidates || [];
  let taggedCount = 0;
  const decCounts = {};
  const catCounts = {};

  candList.forEach(function (n) {
    const info = aiTagsCache[n.id];
    if (info) {
      taggedCount++;
      if (info.decision) {
        decCounts[info.decision] = (decCounts[info.decision] || 0) + 1;
      }
      if (info.category) {
        catCounts[info.category] = (catCounts[info.category] || 0) + 1;
      }
    }
  });

  if (taggedCount === 0) {
    bar.hidden = true;
    return;
  }

  bar.hidden = false;

  const chips = [];

  // 全部胶囊
  const allActive = activeTagFilter === 'all';
  chips.push(
    '<button class="rn-chip' + (allActive ? ' rn-chip-active' : '') + '" data-tag="all" type="button">' +
    '全部 <span class="rn-chip-cnt">' + candList.length + '</span>' +
    '</button>'
  );

  // 决策类胶囊（置顶排在最前，带醒目警示与推荐配色）
  const decOrder = [
    { key: '时效过期', label: '⚠️ 时效过期', cls: 'rn-chip-warn' },
    { key: '营销广告', label: '📢 营销推广', cls: 'rn-chip-danger' },
    { key: '干货保值', label: '💡 干货保值', cls: 'rn-chip-safe' },
    { key: '普通浏览', label: '☕ 普通浏览', cls: '' },
  ];

  decOrder.forEach(function (item) {
    const cnt = decCounts[item.key] || 0;
    if (cnt > 0) {
      const isActive = activeTagFilter === item.key;
      chips.push(
        '<button class="rn-chip ' + item.cls + (isActive ? ' rn-chip-active' : '') + '" data-tag="' + esc(item.key) + '" type="button">' +
        item.label + ' <span class="rn-chip-cnt">' + cnt + '</span>' +
        '</button>'
      );
    }
  });

  // 主题分类胶囊（按数量从大到小排序）
  const sortedCats = Object.keys(catCounts).sort(function (a, b) {
    return catCounts[b] - catCounts[a];
  });

  sortedCats.forEach(function (cat) {
    const cnt = catCounts[cat];
    const isActive = activeTagFilter === cat;
    chips.push(
      '<button class="rn-chip rn-chip-cat' + (isActive ? ' rn-chip-active' : '') + '" data-tag="' + esc(cat) + '" type="button">' +
      esc(cat) + ' <span class="rn-chip-cnt">' + cnt + '</span>' +
      '</button>'
    );
  });

  container.innerHTML = chips.join('');
}

function renderList(candidates, visible, st, query) {
  const container = $('rn-list');
  const mode = (st && st.mode) || 'uncollect';
  const allCandidates = Array.isArray(st && st.candidates) ? st.candidates : [];
  const selectedSet = new Set((st && st.selected) || []);
  const processedSet = new Set((st && st.processed && st.processed[mode]) || []);

  const candList = showProcessedNotes
    ? (candidates || [])
    : (candidates || []).filter(function (n) { return !processedSet.has(n.id); });
  const visList = showProcessedNotes
    ? (visible || [])
    : (visible || []).filter(function (n) { return !processedSet.has(n.id); });

  if (!candList.length) {
    if (st && st.isOwnNotes) {
      container.innerHTML = '<div class="rn-empty">当前处于「我的笔记」页面。<br>RedNote Manager 仅管理您的收藏与赞过列表，<br>受安全保护不会读取您的原创笔记。<br>请在左侧小红书页面切换至「收藏」或「赞过」标签。</div>';
      return;
    }
    // 关键体验优化：如果页面上其实已经读到了笔记，但全部处于已处理状态被隐藏，明确告知用户并提供快捷操作
    if (allCandidates.length > 0) {
      container.innerHTML = '<div class="rn-empty">' +
        '🎉 当前页面已识别到 <b>' + allCandidates.length + '</b> 篇笔记，全部已标记为已处理（已为您自动隐藏）。<br>' +
        '如需重新查看这些笔记或再次操作，可点击下方按钮：' +
        '<div style="margin-top:12px; display:flex; gap:8px; justify-content:center;">' +
        '<button class="rn-btn rn-mini" id="rn-btn-toggle-show-processed" type="button">查看已处理笔记</button>' +
        '<button class="rn-btn rn-mini rn-btn-danger" id="rn-btn-quick-reset" type="button">清空已处理记录</button>' +
        '</div></div>';
      return;
    }
    const modeName = mode === 'unlike' ? '取消点赞' : '取消收藏';
    const tabName = mode === 'unlike' ? '赞过' : '收藏';
    container.innerHTML = '<div class="rn-empty">当前「' + modeName + '」暂无待处理数据。<br>请在左侧小红书页面切换至「' + tabName + '」列表并滚动浏览，已加载的笔记将自动缓存至此处；<br>也可点击上方「① 读取列表」自动跳转并读取。</div>';
    return;
  }

  if (!visList.length) {
    const filterHint = activeTagFilter !== 'all' ? '（当前筛选：' + esc(activeTagFilter) + '）' : '';
    container.innerHTML = '<div class="rn-empty">未找到匹配「' + esc(query || '全部') + '」' + filterHint + ' 的笔记。<br>可按 Esc 清空搜索或点击「全部」标签查看全部 ' + candList.length + ' 篇已加载笔记。</div>';
    return;
  }

  const topNotice = showProcessedNotes
    ? '<div class="rn-banner-processed-notice" style="padding:6px 10px; background:rgba(255,255,255,0.06); border-radius:6px; font-size:11px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">' +
      '<span>已显示全部笔记（包含已处理）</span>' +
      '<button class="rn-btn rn-mini" id="rn-btn-hide-processed" type="button" style="padding:2px 8px; font-size:11px;">仅看待处理</button>' +
      '</div>'
    : '';

  const maxShow = 150;
  const itemsHtml = visList.slice(0, maxShow).map(function (n) {
    const isDone = processedSet.has(n.id);
    const isSel = !isDone && selectedSet.has(n.id);
    const aiInfo = aiTagsCache[n.id] || null;

    let tagsHtml = '';
    if (aiInfo) {
      const decCls = aiInfo.decision === '时效过期' ? 'rn-badge-warn'
        : aiInfo.decision === '营销广告' ? 'rn-badge-danger'
        : aiInfo.decision === '干货保值' ? 'rn-badge-safe'
        : 'rn-badge-normal';
      const decLabel = aiInfo.decision === '时效过期' ? '⚠️ 时效过期'
        : aiInfo.decision === '营销广告' ? '📢 营销推广'
        : aiInfo.decision === '干货保值' ? '💡 干货保值'
        : '☕ 普通浏览';

      tagsHtml = '<div class="rn-item-tags">' +
        '<span class="rn-badge-tag ' + decCls + '" title="AI 决策建议: ' + esc(aiInfo.decision) + (aiInfo.reason ? ' (' + esc(aiInfo.reason) + ')' : '') + '">' + decLabel + '</span>' +
        (aiInfo.category ? '<span class="rn-badge-tag rn-badge-cat">' + esc(aiInfo.category) + '</span>' : '') +
        (aiInfo.reason ? '<span class="rn-badge-reason" title="' + esc(aiInfo.reason) + '">' + esc(aiInfo.reason) + '</span>' : '') +
        '</div>';
    }

    const noteUrl = C.buildNoteUrl(n.url || n.id, n.xsecToken);
    return (
      '<div class="rn-item' + (isSel ? ' rn-sel' : '') + (isDone ? ' rn-done' : '') + '"' +
      ' data-id="' + esc(n.id) + '" role="checkbox" aria-checked="' + (isSel ? 'true' : 'false') + '"' +
      ' title="' + esc(n.title) + (n.author ? ' · ' + esc(n.author) : '') + (isDone ? ' (已处理)' : '') + ' · ' + esc(n.id) + '">' +
      '<span class="rn-box"></span>' +
      '<div class="rn-item-main">' +
        '<div class="rn-item-row">' +
          '<span class="rn-nm">' + esc(titleOf(n)) + '</span>' +
          '<a class="rn-item-link" href="' + esc(noteUrl) + '" target="_blank" rel="noopener" title="在新标签页中打开查看笔记原文">↗</a>' +
          '<span class="rn-id">' + esc(n.id.slice(-6)) + '</span>' +
        '</div>' +
        tagsHtml +
      '</div>' +
      '</div>'
    );
  }).join('');

  container.innerHTML = topNotice + itemsHtml +
    (visList.length > maxShow ? '<div class="rn-empty">… 还有 ' + (visList.length - maxShow) + ' 篇未展示，缩小搜索词即可查看</div>' : '');
}

function syncSettings(s) {
  const active = document.activeElement;
  const setVal = function (id, val) {
    const el = $(id);
    if (el && active !== el && val !== undefined) el.value = val;
  };
  setVal('rn-minDelay', s.minDelay);
  setVal('rn-maxDelay', s.maxDelay);
  setVal('rn-maxPerRun', s.maxPerRun);
  setVal('rn-cooldownEvery', s.cooldownEvery);
  setVal('rn-cooldownMs', s.cooldownMs);
  const auto = $('rn-autoScroll');
  if (auto && active !== auto && typeof s.autoScroll === 'boolean') {
    auto.checked = s.autoScroll;
  }
}

function renderLogs(logs) {
  const container = $('rn-log');
  if (!container) return;
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 25;
  const html = logs.slice(-100).map(function (l) {
    const cls = l.kind && l.kind !== 'info' ? ' rn-l-' + l.kind : '';
    let undoHtml = '';
    if (l.canUndo) {
      if (l.undone) {
        undoHtml = '<button class="rn-line-undo-btn rn-undone" type="button" disabled>已撤销</button>';
      } else {
        const btnText = l.undoType === 'batch' ? ('撤销本批 (' + (l.count || '') + '篇)') : '撤销';
        const btnTitle = l.undoType === 'batch' ? ('撤销此批处理的 ' + (l.count || '') + ' 篇笔记') : ('撤销对「' + (l.title || l.noteId || '') + '」的操作');
        undoHtml = '<button class="rn-line-undo-btn" data-undo-type="' + esc(l.undoType || 'single') + '" data-note-id="' + esc(l.noteId || '') + '" data-batch-id="' + esc(l.batchId || '') + '" data-mode="' + esc(l.mode || '') + '" type="button" title="' + esc(btnTitle) + '">' + esc(btnText) + '</button>';
      }
    } else if (l.isSponsor) {
      undoHtml = '<button class="rn-line-sponsor-btn" type="button" title="请作者喝杯咖啡">' + CUP_SVG_INLINE + '<span>请喝咖啡</span></button>';
    }
    return '<div class="rn-line' + cls + '">' +
      '<span class="rn-t">' + esc(l.t) + '</span> ' +
      '<span class="rn-msg">' + esc(l.msg) + '</span>' +
      (undoHtml ? undoHtml : '') +
      '</div>';
  }).join('');
  container.innerHTML = html;
  const hasSponsor = logs && logs.length && logs.some(function (l) { return l.isSponsor; });
  if (wasAtBottom || hasSponsor) container.scrollTop = container.scrollHeight;
}

function openSponsorModal() {
  const modal = $('rn-sponsor-modal');
  if (modal) {
    modal.hidden = false;
  }
}

function closeSponsorModal() {
  const modal = $('rn-sponsor-modal');
  if (modal) {
    modal.hidden = true;
  }
}

/* ============================ 事件绑定 ============================ */

function bindEvents() {
  // 模式切换
  $$('.rn-tab').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      const mode = btn.dataset.mode;
      if (!mode) return;
      // 立即乐观切换选中视觉，交互零延迟
      $$('.rn-tab').forEach(function (b) {
        b.classList.toggle('rn-on', b === btn);
      });
      const query = $('rn-q') ? $('rn-q').value.trim() : '';
      const res = await sendToTab('RN_SET_MODE', {
        mode: mode,
        keyword: query,
        tag: activeTagFilter,
      });
      if (res && res.state) {
        applyState(res.state);
      } else {
        requestState();
      }
      syncCurrentFilterToStack();
    });
  });

  // 操作按钮
  $('rn-scan').addEventListener('click', async function () {
    await sendToTab('RN_ACTION', { action: 'scan' });
    requestState();
  });

  $('rn-start').addEventListener('click', async function () {
    await sendToTab('RN_ACTION', { action: 'start' });
    requestState();
  });

  $('rn-stop').addEventListener('click', async function () {
    await sendToTab('RN_ACTION', { action: 'stop' });
    requestState();
  });

  $('rn-undo').addEventListener('click', async function () {
    await sendToTab('RN_ACTION', { action: 'undo' });
    requestState();
  });

  const logUndoBtn = $('rn-log-undo');
  if (logUndoBtn) {
    logUndoBtn.addEventListener('click', async function () {
      await sendToTab('RN_ACTION', { action: 'undo' });
      requestState();
    });
  }

  const logContainer = $('rn-log');
  if (logContainer) {
    logContainer.addEventListener('click', async function (ev) {
      const sponsorBtn = ev.target && ev.target.closest ? ev.target.closest('.rn-line-sponsor-btn') : null;
      if (sponsorBtn) {
        ev.stopPropagation();
        openSponsorModal();
        return;
      }
      const btn = ev.target && ev.target.closest ? ev.target.closest('.rn-line-undo-btn:not(.rn-undone)') : null;
      if (!btn) return;
      ev.stopPropagation();
      const undoType = btn.dataset.undoType || 'single';
      const noteId = btn.dataset.noteId || '';
      const batchId = btn.dataset.batchId || '';
      const mode = btn.dataset.mode || '';
      btn.disabled = true;
      btn.textContent = '撤销中…';
      await sendToTab('RN_ACTION', {
        action: 'undo',
        undoType: undoType,
        noteId: noteId,
        batchId: batchId,
        mode: mode,
      });
      requestState();
    });
  }

  $('rn-diag').addEventListener('click', async function () {
    await sendToTab('RN_ACTION', { action: 'diagnose' });
    requestState();
  });

  const refreshBtn = $('rn-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async function () {
      await sendToTab('RN_REFRESH_CACHE');
      requestState();
    });
  }

  // 搜索筛选：本地即时响应 + 页面联动与叠卡数据完全同步
  const q = $('rn-q');
  let qTimer = null;
  let syncStackTimer = null;

  function syncCurrentFilterToStack() {
    clearTimeout(syncStackTimer);
    syncStackTimer = setTimeout(async function () {
      if (!lastState) return;
      const query = q ? q.value.trim() : '';
      const candList = getUnprocessedCandidates(lastState);
      const filtered = getFilteredVisible(candList, query, activeTagFilter);
      const ids = filtered.map(function (n) { return n.id; });
      await sendToTab('RN_SYNC_STACK_FILTER', {
        keyword: query,
        tag: activeTagFilter,
        ids: ids,
      });
    }, 60);
  }

  function doSearchLocally() {
    if (!lastState) return;
    const query = q.value.trim();
    const allCandidates = Array.isArray(lastState.candidates) ? lastState.candidates : [];
    const mode = lastState.mode || 'uncollect';
    const processedSet = new Set((lastState.processed && lastState.processed[mode]) || []);
    const processedOnPage = allCandidates.filter(function (n) { return processedSet.has(n.id); }).length;

    const candList = getUnprocessedCandidates(lastState);
    const filtered = getFilteredVisible(candList, query, activeTagFilter);

    // 立即更新命中数与已选统计
    $('rn-hit').textContent = filtered.length + '/' + candList.length;
    const selectedSet = new Set(lastState.selected || []);
    const visSelCount = filtered.filter(function (n) { return selectedSet.has(n.id); }).length;
    const hiddenCount = Math.max(0, selectedSet.size - visSelCount);
    let selText = '已选 ' + selectedSet.size;
    if (hiddenCount > 0) {
      selText += ' · 隐藏 ' + hiddenCount;
    } else if (processedOnPage > 0 && !showProcessedNotes) {
      selText += ' · 隐藏 ' + processedOnPage + ' 篇已处理';
    }
    $('rn-sel-count').textContent = selText;

    // 立即在下方展示胶囊栏与搜索结果
    renderTagChips(candList);
    renderList(candList, filtered, lastState, query);

    // 立即实时向左侧页面正在浏览的叠卡同步筛选卡组
    syncCurrentFilterToStack();
  }

  const qClear = $('rn-search-clear');

  function clearSearchInput() {
    q.value = '';
    if (qClear) qClear.hidden = true;
    activeTagFilter = 'all';
    doSearchLocally();
    sendToTab('RN_SET_KEYWORD', { keyword: '' });
  }

  if (qClear) {
    qClear.addEventListener('click', function () {
      clearSearchInput();
      q.focus();
    });
  }

  q.addEventListener('input', function () {
    if (qClear) qClear.hidden = !q.value;
    // 1. 本地即时计算并渲染搜索结果，并同步叠卡卡组
    doSearchLocally();

    // 2. 联动向小红书页面同步搜索词（暗化页面未命中的卡片）
    clearTimeout(qTimer);
    qTimer = setTimeout(async function () {
      await sendToTab('RN_SET_KEYWORD', { keyword: q.value });
    }, 120);
  });

  q.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      clearSearchInput();
    }
  });

  // 胶囊标签点击事件（支持点击激活或再次点击反选）
  const chipsBar = $('rn-tag-chips');
  if (chipsBar) {
    chipsBar.addEventListener('click', function (ev) {
      const chip = ev.target && ev.target.closest ? ev.target.closest('.rn-chip') : null;
      if (!chip) return;
      const tag = chip.dataset.tag;
      if (!tag) return;
      if (activeTagFilter === tag && tag !== 'all') {
        activeTagFilter = 'all';
      } else {
        activeTagFilter = tag;
      }
      doSearchLocally();
    });
  }

  // 批量操作（基于当前关键词+AI标签联合过滤结果）
  $('rn-sel-all').addEventListener('click', async function () {
    const query = $('rn-q').value;
    const candList = getUnprocessedCandidates(lastState);
    const filtered = getFilteredVisible(candList, query, activeTagFilter);
    const ids = filtered.map(function (n) { return n.id; });
    await sendToTab('RN_SELECT_ALL_VISIBLE', { keyword: query, ids: ids });
    requestState();
  });

  $('rn-sel-invert').addEventListener('click', async function () {
    const query = $('rn-q').value;
    const candList = getUnprocessedCandidates(lastState);
    const filtered = getFilteredVisible(candList, query, activeTagFilter);
    const ids = filtered.map(function (n) { return n.id; });
    await sendToTab('RN_INVERT_VISIBLE', { ids: ids });
    requestState();
  });

  $('rn-sel-clear').addEventListener('click', async function () {
    await sendToTab('RN_CLEAR_SELECTION');
    requestState();
  });

  // 点击叠卡浏览：传入当前搜索词、激活的Tag以及精确过滤的列表IDs，100%保持完全一致
  $('rn-btn-stack').addEventListener('click', async function () {
    const query = $('rn-q') ? $('rn-q').value.trim() : '';
    const candList = getUnprocessedCandidates(lastState);
    const filtered = getFilteredVisible(candList, query, activeTagFilter);
    const ids = filtered.map(function (n) { return n.id; });
    const res = await sendToTab('RN_OPEN_STACK_VIEW', {
      keyword: query,
      tag: activeTagFilter,
      ids: ids,
    });
    if (!res) {
      alert('未检测到小红书页面或通信超时。\n请确认左侧网页已打开小红书（xiaohongshu.com）主页并刷新页面重试。');
    } else if (!res.ok) {
      alert(res.reason || '当前未检测到笔记卡片：\n请在小红书页面向下滚动浏览加载内容，或点击「读取列表」后再试。');
    }
  });

  // ✨ AI 分类按钮点击：触发 DeepSeek 语义分析
  const aiBtn = $('rn-btn-ai');
  if (aiBtn) {
    aiBtn.addEventListener('click', async function () {
      if (isAiAnalyzing) return;

      // 动态读取输入框中的实时密钥，优先使用界面上的新输入并自动持久化，防止用户未点「保存」导致读取旧数据
      const inputKey = ($('rn-ai-key') ? $('rn-ai-key').value : '');
      const cleanedInputKey = (RNAI && RNAI.cleanApiKey) ? RNAI.cleanApiKey(inputKey) : inputKey.trim();

      let cfg = (RNAI && RNAI.loadConfig) ? await RNAI.loadConfig() : null;
      if (!cfg) cfg = Object.assign({}, RNAI.DEFAULT_CONFIG);

      // 若当前输入框有内容，且与存储不一致，自动同步并静默持久化保存
      if (cleanedInputKey) {
        if (cleanedInputKey !== cfg.apiKey) {
          cfg.apiKey = cleanedInputKey;
          const currentModel = $('rn-ai-model') ? $('rn-ai-model').value : (cfg.model || 'deepseek-chat');
          cfg.model = currentModel;
          await RNAI.saveConfig(cfg);
        }
        // 回写规范化后的密钥至输入框
        if ($('rn-ai-key') && $('rn-ai-key').value !== cleanedInputKey) {
          $('rn-ai-key').value = cleanedInputKey;
        }
      }

      if (!cfg || !cfg.apiKey || !cfg.apiKey.trim()) {
        settingsOpen = true;
        $('rn-settings').hidden = false;
        $('rn-gear').classList.add('rn-active');
        const keyInput = $('rn-ai-key');
        if (keyInput) keyInput.focus();
        alert('请先在「⚙️ 设置与维护」中填写 DeepSeek API Key 并点击保存（可前往 platform.deepseek.com 获取）。');
        return;
      }

      const candList = getUnprocessedCandidates(lastState);
      if (!candList.length) {
        alert('当前暂无已读取的笔记数据。\n请在小红书页面滚动加载笔记或点击「① 读取列表」后再试。');
        return;
      }

      // 区分未分析和已分析笔记
      const unanalyzed = candList.filter(function (n) { return !aiTagsCache[n.id]; });
      let notesToAnalyze = unanalyzed;

      if (unanalyzed.length === 0) {
        const redo = confirm('当前 ' + candList.length + ' 篇笔记全部已有打标结果。是否需要重新全部分析？');
        if (!redo) return;
        notesToAnalyze = candList;
      }

      isAiAnalyzing = true;
      aiBtn.classList.add('rn-loading');
      aiBtn.disabled = true;
      const originText = '✨ AI 分类';
      aiBtn.textContent = '✨ 分析中 (0/' + notesToAnalyze.length + ')';

      try {
        const newTags = await RNAI.analyzeNotes(cfg, notesToAnalyze, function (done, total) {
          aiBtn.textContent = '✨ 分析中 (' + done + '/' + total + ')';
        });

        const merged = await RNAI.saveTags(newTags);
        aiTagsCache = merged;
        aiBtn.textContent = '✓ 完成打标';

        doSearchLocally();

        if (lastState && lastState.logs) {
          lastState.logs.push({
            t: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            kind: 'ok',
            msg: '✨ DeepSeek 成功为 ' + Object.keys(newTags).length + ' 篇笔记完成智能打标分类',
          });
          renderLogs(lastState.logs);
        }

        setTimeout(function () {
          aiBtn.textContent = originText;
        }, 2200);
      } catch (err) {
        alert('AI 打标失败：' + (err && err.message ? err.message : String(err)));
        aiBtn.textContent = originText;
      } finally {
        isAiAnalyzing = false;
        aiBtn.classList.remove('rn-loading');
        aiBtn.disabled = false;
      }
    });
  }

  // 点击单条勾选 / Shift 区间勾选 / 快捷操作按钮
  $('rn-list').addEventListener('click', async function (ev) {
    if (ev.target && ev.target.id === 'rn-btn-toggle-show-processed') {
      showProcessedNotes = true;
      if (lastState) applyState(lastState);
      return;
    }
    if (ev.target && ev.target.id === 'rn-btn-hide-processed') {
      showProcessedNotes = false;
      if (lastState) applyState(lastState);
      return;
    }
    if (ev.target && ev.target.id === 'rn-btn-quick-reset') {
      await sendToTab('RN_CLEAR_RECORDS');
      requestState();
      return;
    }
    // 点击查看原文外链，优先使用 chrome.tabs.create 打开新标签页，并阻止冒泡到列表项勾选事件
    const link = ev.target && ev.target.closest ? ev.target.closest('.rn-item-link') : null;
    if (link) {
      ev.preventDefault();
      ev.stopPropagation();
      const targetUrl = link.getAttribute('href') || link.href;
      if (targetUrl && targetUrl !== '#' && !targetUrl.startsWith('javascript:')) {
        if (chrome.tabs && typeof chrome.tabs.create === 'function') {
          chrome.tabs.create({ url: targetUrl });
        } else {
          window.open(targetUrl, '_blank', 'noopener');
        }
      }
      return;
    }
    const item = ev.target && ev.target.closest ? ev.target.closest('.rn-item') : null;
    if (!item || !item.dataset.id) return;
    if (item.classList.contains('rn-done')) return;
    const noteId = item.dataset.id;
    await sendToTab('RN_TOGGLE_SELECTION', { noteId: noteId, shiftKey: !!ev.shiftKey });
    requestState();
  });

  // 点击已选统计可快捷切换显示/隐藏已处理笔记
  $('rn-sel-count').addEventListener('click', function () {
    if (!lastState) return;
    const allCandidates = Array.isArray(lastState.candidates) ? lastState.candidates : [];
    const mode = lastState.mode || 'uncollect';
    const processedSet = new Set((lastState.processed && lastState.processed[mode]) || []);
    const processedOnPage = allCandidates.filter(function (n) { return processedSet.has(n.id); }).length;
    if (processedOnPage > 0) {
      showProcessedNotes = !showProcessedNotes;
      applyState(lastState);
    }
  });

  // 设置面板切换
  $('rn-gear').addEventListener('click', function () {
    settingsOpen = !settingsOpen;
    $('rn-settings').hidden = !settingsOpen;
    $('rn-gear').classList.toggle('rn-active', settingsOpen);
  });

  // 设置项保存
  const settingFields = ['minDelay', 'maxDelay', 'maxPerRun', 'cooldownEvery', 'cooldownMs'];
  settingFields.forEach(function (key) {
    const el = $('rn-' + key);
    if (!el) return;
    el.addEventListener('change', async function () {
      const patch = {};
      patch[key] = el.value;
      await sendToTab('RN_UPDATE_SETTINGS', { settings: patch });
      requestState();
    });
  });

  $('rn-autoScroll').addEventListener('change', async function () {
    await sendToTab('RN_UPDATE_SETTINGS', { settings: { autoScroll: !!$('rn-autoScroll').checked } });
    requestState();
  });

  $('rn-clear').addEventListener('click', async function () {
    await sendToTab('RN_CLEAR_RECORDS');
    requestState();
  });

  // AI 设置相关事件绑定
  const aiKeyEye = $('rn-ai-key-eye');
  if (aiKeyEye) {
    aiKeyEye.addEventListener('click', function () {
      const keyInput = $('rn-ai-key');
      if (!keyInput) return;
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
      aiKeyEye.textContent = keyInput.type === 'password' ? '👁' : '🔒';
    });
  }

  // 监听输入框变动并自动保存，防止用户填完直接使用时因未手动点保存而读取旧配置
  const aiKeyInput = $('rn-ai-key');
  if (aiKeyInput) {
    const handleKeyChange = async function () {
      const raw = aiKeyInput.value || '';
      const cleaned = (RNAI && RNAI.cleanApiKey) ? RNAI.cleanApiKey(raw) : raw.trim();
      if (cleaned !== raw) {
        aiKeyInput.value = cleaned;
      }
      const model = $('rn-ai-model') ? $('rn-ai-model').value : 'deepseek-chat';
      if (RNAI && RNAI.saveConfig) {
        await RNAI.saveConfig({ apiKey: cleaned, model: model, baseUrl: 'https://api.deepseek.com' });
      }
    };
    aiKeyInput.addEventListener('change', handleKeyChange);
    aiKeyInput.addEventListener('blur', handleKeyChange);
    aiKeyInput.addEventListener('paste', function () {
      setTimeout(handleKeyChange, 60);
    });
  }

  const aiModelSelect = $('rn-ai-model');
  if (aiModelSelect) {
    aiModelSelect.addEventListener('change', async function () {
      const rawKey = ($('rn-ai-key') ? $('rn-ai-key').value : '');
      const apiKey = (RNAI && RNAI.cleanApiKey) ? RNAI.cleanApiKey(rawKey) : rawKey.trim();
      if (RNAI && RNAI.saveConfig) {
        await RNAI.saveConfig({ apiKey: apiKey, model: aiModelSelect.value, baseUrl: 'https://api.deepseek.com' });
      }
    });
  }

  const aiSaveBtn = $('rn-ai-save');
  if (aiSaveBtn) {
    aiSaveBtn.addEventListener('click', async function () {
      const rawKey = ($('rn-ai-key') ? $('rn-ai-key').value : '');
      const apiKey = (RNAI && RNAI.cleanApiKey) ? RNAI.cleanApiKey(rawKey) : rawKey.trim();
      if ($('rn-ai-key')) $('rn-ai-key').value = apiKey;
      const model = $('rn-ai-model') ? $('rn-ai-model').value : 'deepseek-chat';
      if (RNAI && RNAI.saveConfig) {
        await RNAI.saveConfig({ apiKey: apiKey, model: model, baseUrl: 'https://api.deepseek.com' });
        alert('✅ DeepSeek 密钥与配置已成功保存！');
      }
    });
  }

  const aiTestBtn = $('rn-ai-test');
  if (aiTestBtn) {
    aiTestBtn.addEventListener('click', async function () {
      const rawKey = ($('rn-ai-key') ? $('rn-ai-key').value : '');
      const apiKey = (RNAI && RNAI.cleanApiKey) ? RNAI.cleanApiKey(rawKey) : rawKey.trim();
      if ($('rn-ai-key')) $('rn-ai-key').value = apiKey;
      const model = $('rn-ai-model') ? $('rn-ai-model').value : 'deepseek-chat';
      if (!apiKey) {
        alert('请先填入 DeepSeek API Key');
        return;
      }
      // 测试前先自动同步保存
      if (RNAI && RNAI.saveConfig) {
        await RNAI.saveConfig({ apiKey: apiKey, model: model, baseUrl: 'https://api.deepseek.com' });
      }
      aiTestBtn.disabled = true;
      aiTestBtn.textContent = '测试中…';
      const res = await RNAI.testConnection({ apiKey: apiKey, model: model });
      aiTestBtn.disabled = false;
      aiTestBtn.textContent = '测试连接';
      if (res && res.ok) {
        alert('✅ 连接成功！DeepSeek API Key 验证有效，可正常使用。');
      } else {
        alert('❌ 连接失败：' + (res && res.error ? res.error : '未知错误'));
      }
    });
  }

  const aiClearBtn = $('rn-ai-clear');
  if (aiClearBtn) {
    aiClearBtn.addEventListener('click', async function () {
      if (!confirm('确定清空本地缓存的全部 AI 标签吗？清空后若需再次分类需重新调用。')) return;
      if (RNAI && RNAI.clearTags) {
        await RNAI.clearTags();
      }
      aiTagsCache = {};
      activeTagFilter = 'all';
      doSearchLocally();
      alert('已清空本地 AI 标签缓存！');
    });
  }

  // 赞赏支持弹窗事件绑定
  const sponsorModal = $('rn-sponsor-modal');
  const sponsorCloseBtn = $('rn-sponsor-close');
  const hdrSponsorBtn = $('rn-btn-sponsor-hdr');
  const settingsSponsorBtn = $('rn-btn-sponsor-settings');

  if (hdrSponsorBtn) {
    hdrSponsorBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openSponsorModal();
    });
  }
  if (settingsSponsorBtn) {
    settingsSponsorBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openSponsorModal();
    });
  }
  if (sponsorCloseBtn) {
    sponsorCloseBtn.addEventListener('click', function () {
      closeSponsorModal();
    });
  }
  if (sponsorModal) {
    sponsorModal.addEventListener('click', function (ev) {
      if (ev.target === sponsorModal) {
        closeSponsorModal();
      }
    });
  }
  window.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && sponsorModal && !sponsorModal.hidden) {
      closeSponsorModal();
    }
  });

  // 监听来自 content.js 的主动状态广播（保证实时性）
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'RN_STATE_UPDATED' && msg.state) {
      applyState(msg.state);
    } else if (msg.type === 'RN_FILTER_CLEARED') {
      const qInput = $('rn-q');
      const qClearBtn = $('rn-search-clear');
      if (qInput) qInput.value = '';
      if (qClearBtn) qClearBtn.hidden = true;
      activeTagFilter = 'all';
      doSearchLocally();
    }
  });

  // 监听标签页切换与更新
  chrome.tabs.onActivated.addListener(function (activeInfo) {
    activeTabId = activeInfo.tabId;
    ensurePortConnection(activeTabId);
    requestState();
  });

  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (tabId === activeTabId && changeInfo.status === 'complete') {
      ensurePortConnection(activeTabId);
      requestState();
    }
  });

  window.addEventListener('beforeunload', function () {
    if (sidepanelPort) {
      try { sidepanelPort.disconnect(); } catch (e) {}
      sidepanelPort = null;
    }
  });
}

/* ============================ 初始化与启动 ============================ */

async function initAiSettings() {
  if (RNAI && RNAI.loadConfig) {
    const cfg = await RNAI.loadConfig();
    const keyInput = $('rn-ai-key');
    const modelSelect = $('rn-ai-model');
    if (keyInput && cfg.apiKey) keyInput.value = cfg.apiKey;
    if (modelSelect && cfg.model) modelSelect.value = cfg.model;
  }
}

async function boot() {
  if (RNAI && RNAI.loadSavedTags) {
    aiTagsCache = (await RNAI.loadSavedTags()) || {};
  }
  bindEvents();
  await initAiSettings();
  await requestState();
  // 轮询作为兜底保活
  pollTimer = setInterval(requestState, 1000);
}

document.addEventListener('DOMContentLoaded', boot);
