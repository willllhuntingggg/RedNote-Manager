/*
 * RedNote Manager · 内容脚本（隔离世界）
 * ---------------------------------------------------------------
 * 职责：
 *   1. 从「我的主页 → 收藏/赞过」页面读取已渲染的笔记卡片（候选来源）
 *   2. 通过 bridge.js 调用页面签名函数，逐条发取消请求
 *   3. 限速 / 批次冷却 / 连续失败暂停 / 风控熔断 / 记录持久化 / 撤销
 *   4. 页面端卡片勾选 + 底部已选条数浮动实时反馈栏
 *   5. 与 Chrome 原生侧边栏 (Side Panel) 双向通信同步
 *
 * 设计取舍：
 *   - 界面采用 Chrome 原生侧边栏展开/收起，不再有阻塞网页的大悬浮窗。
 *   - 用户在小红书页面直接勾选笔记卡片时，底部浮动栏和侧边栏均实时反馈已选条数。
 *   - 真实模式执行，每次运行二次确认，受单次上限与安全限速严格保护。
 */
(function () {
  'use strict';

  const C = globalThis.RNCore;
  const STYLE = globalThis.RNStyle;
  if (!C || !STYLE) {
    console.warn('[RedNote Manager] core/style 未加载，脚本退出');
    return;
  }
  if (window.__RN_CONTENT_READY__) return;
  window.__RN_CONTENT_READY__ = true;

  /* ============================ 常量 ============================ */

  const KEY_SETTINGS = 'rn:settings';
  const KEY_PROCESSED = 'rn:processed';
  const KEY_HISTORY = 'rn:history';
  const KEY_AI_TAGS = 'rn:ai_tags';
  const PROFILE_RE = /\/user\/profile(?:\/([0-9a-f]{24}))?/i;
  const PROCESSED_CAP = 3000;
  const HISTORY_CAP = 800;
  const LOG_CAP = 200;

  const TAB_ALIASES = { 收藏: ['收藏'], 点赞: ['点赞', '赞过'], 赞过: ['赞过', '点赞'] };
  const ACTIVE_RE = /(?:^|\s)(?:active|current|selected|on)(?:\s|$)/i;
  const EDIT_TEXT = /编辑资料|编辑主页|发布笔记/;

  /* ============================ 状态 ============================ */

  const state = {
    settings: C.clampSettings(null),
    aiTags: {},
    /** 模式独立候选集缓存：uncollect 存收藏候选，unlike 存点赞候选 */
    modeCache: {
      uncollect: [],
      unlike: [],
    },
    /** 模式独立勾选集缓存 */
    modeSelected: {
      uncollect: new Map(),
      unlike: new Map(),
    },
    /** 当前活跃模式 candidates 的动态引用（保持与各模式缓存同步） */
    candidates: [],
    /** 当前活跃模式 selected 的动态引用 */
    selected: new Map(),
    /** Shift 区间选择的锚点 */
    anchorId: null,
    processed: { uncollect: [], unlike: [] },
    history: [],
    xsecTokens: {},
    running: false,
    scanning: false,
    stopRequested: false,
    stats: { ok: 0, fail: 0, risk: false, startedAt: 0, total: 0 },
    logs: [],
    mounted: false,
    els: null,
    sidepanelConnected: typeof chrome !== 'undefined' && (!chrome.runtime || !chrome.runtime.onConnect),
  };

  // 监听侧边栏长链接生命周期：侧边栏关闭时自动释放页面卡片暗化
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onConnect) {
    try {
      chrome.runtime.onConnect.addListener(function (port) {
        if (port.name === 'rn-sidepanel') {
          state.sidepanelConnected = true;
          refreshPageCards();
          port.onDisconnect.addListener(function () {
            state.sidepanelConnected = false;
            refreshPageCards();
          });
        }
      });
    } catch (e) {}
  }

  /** 同步 candidates / selected 指针指向当前活跃模式的独立缓存 */
  function syncActiveModePointers() {
    const m = (state.settings && state.settings.mode) || 'uncollect';
    if (!state.modeCache) state.modeCache = { uncollect: [], unlike: [] };
    if (!state.modeSelected) state.modeSelected = { uncollect: new Map(), unlike: new Map() };
    if (!state.modeCache[m]) state.modeCache[m] = [];
    if (!state.modeSelected[m]) state.modeSelected[m] = new Map();
    state.candidates = state.modeCache[m];
    state.selected = state.modeSelected[m];
  }

  /* ============================ 小工具 ============================ */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms || 0)));
  const nowMs = () => Date.now();

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function log(msg, kind, extra) {
    const entry = Object.assign({ t: stamp(), msg: String(msg), kind: kind || 'info' }, extra || {});
    state.logs.push(entry);
    if (state.logs.length > LOG_CAP) state.logs.shift();
    broadcastState();
    if (kind === 'err') console.warn('[RedNote Manager]', msg);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function titleOf(note) {
    const t = (note && note.title) || '未命名笔记';
    return t.length > 34 ? t.slice(0, 34) + '…' : t;
  }

  /** 可被「停止」打断的等待；返回 false 表示等待期间被叫停 */
  async function interruptibleSleep(ms) {
    const end = nowMs() + Math.max(0, ms || 0);
    while (nowMs() < end) {
      if (state.stopRequested) return false;
      await sleep(Math.min(200, end - nowMs()));
    }
    return !state.stopRequested;
  }

  /* ============================ 持久化 ============================ */

  async function loadStorage() {
    try {
      const got = await chrome.storage.local.get([KEY_SETTINGS, KEY_PROCESSED, KEY_HISTORY, KEY_AI_TAGS]);
      state.settings = C.clampSettings(got[KEY_SETTINGS]);
      const p = got[KEY_PROCESSED] || {};
      state.processed.uncollect = Array.isArray(p.uncollect) ? p.uncollect.slice(-PROCESSED_CAP) : [];
      state.processed.unlike = Array.isArray(p.unlike) ? p.unlike.slice(-PROCESSED_CAP) : [];
      state.history = Array.isArray(got[KEY_HISTORY]) ? got[KEY_HISTORY].slice(-HISTORY_CAP) : [];
      state.aiTags = got[KEY_AI_TAGS] || {};
    } catch (e) {
      console.warn('[RedNote Manager] 读取存储失败', e);
    }
  }

  function quietly(p) {
    if (p && typeof p.catch === 'function') p.catch(function () {});
    return p;
  }

  function saveSettings() {
    try {
      quietly(chrome.storage.local.set({ [KEY_SETTINGS]: state.settings }));
    } catch (e) { /* 扩展重载时忽略 */ }
  }

  function saveProcessed() {
    try {
      quietly(chrome.storage.local.set({
        [KEY_PROCESSED]: {
          uncollect: state.processed.uncollect.slice(-PROCESSED_CAP),
          unlike: state.processed.unlike.slice(-PROCESSED_CAP),
        },
      }));
    } catch (e) { /* 忽略 */ }
  }

  async function saveHistory() {
    try {
      await chrome.storage.local.set({ [KEY_HISTORY]: state.history.slice(-HISTORY_CAP) });
    } catch (e) { /* 忽略 */ }
  }

  function isProcessed(mode, id) {
    return state.processed[mode].indexOf(id) !== -1;
  }

  function markProcessed(mode, id) {
    if (isProcessed(mode, id)) return;
    state.processed[mode].push(id);
    if (state.processed[mode].length > PROCESSED_CAP) {
      state.processed[mode] = state.processed[mode].slice(-PROCESSED_CAP);
    }
    saveProcessed();
  }

  function unmarkProcessed(mode, id) {
    const i = state.processed[mode].indexOf(id);
    if (i !== -1) {
      state.processed[mode].splice(i, 1);
      saveProcessed();
    }
  }

  function removeCandidate(mode, id) {
    if (state.modeCache && state.modeCache[mode]) {
      state.modeCache[mode] = state.modeCache[mode].filter(function (n) { return n.id !== id; });
    }
    if (state.candidates) {
      state.candidates = state.candidates.filter(function (n) { return n.id !== id; });
    }
    if (state.modeSelected && state.modeSelected[mode]) {
      state.modeSelected[mode].delete(id);
    }
    if (state.selected) {
      state.selected.delete(id);
    }
  }

  function pushHistory(item) {
    state.history.push(item);
    if (state.history.length > HISTORY_CAP) state.history = state.history.slice(-HISTORY_CAP);
    saveHistory();
  }

  /* ============================ 与页面通信 ============================ */

  const bridgePending = new Map();
  let bridgeSeq = 0;

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== 'RN_BRIDGE' || !msg.id) return;
    const p = bridgePending.get(msg.id);
    if (!p) return;
    bridgePending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || '页面内调用失败'));
  });

  function bridge(kind, payload, timeoutMs) {
    const id = 'rn-' + (++bridgeSeq) + '-' + nowMs();
    const limit = timeoutMs || 15000;
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        bridgePending.delete(id);
        reject(new Error('页面内调用超时（' + limit + 'ms）'));
      }, limit);
      bridgePending.set(id, {
        resolve: function (v) { clearTimeout(timer); resolve(v); },
        reject: function (e) { clearTimeout(timer); reject(e); },
      });
      const msg = Object.assign({ source: 'RN_UI', id: id, kind: kind }, payload || {});
      try {
        window.postMessage(msg, location.origin);
      } catch (e) {
        clearTimeout(timer);
        bridgePending.delete(id);
        reject(e);
      }
    });
  }

  async function pingBridge() {
    try {
      return await bridge('ping', {}, 4000);
    } catch (e) {
      return null;
    }
  }

  const myProfileInfo = { userId: '', nickname: '' };
  const ownNoteIdSet = new Set();

  function recordOwnNoteIdsFromDom() {
    cardNodes().forEach(function (el) {
      const id = cardIdOf(el);
      if (id) ownNoteIdSet.add(id);
    });
  }

  function updateMyProfileInfo() {
    const m = location.pathname.match(PROFILE_RE);
    if (m && m[1]) {
      myProfileInfo.userId = m[1].toLowerCase();
    }
    try {
      const editBtn = $$('button, a, div').filter(function (el) {
        return EDIT_TEXT.test(el.textContent || '') && el.children.length <= 2;
      })[0];
      if (editBtn) {
        const header = editBtn.closest('.user-info, #userPageContainer, [class*="user-header"]') || editBtn.parentElement;
        if (header) {
          const nameEl = header.querySelector('.user-name, [class*="user-name"], .user-nickname, .info-part .name');
          if (nameEl && !nameEl.closest('.note-item, .feeds-container, .notes-container')) {
            const t = (nameEl.textContent || '').trim();
            if (t && t.length >= 2 && t.length < 50 && !/^(?:笔记|收藏|点赞|赞过)/.test(t)) {
              myProfileInfo.nickname = t;
            }
          }
        }
      }
    } catch (e) {}
  }

  async function detectMyUserInfo() {
    try {
      const r = await bridge('me', {}, 3000);
      if (r) {
        if (r.me) myProfileInfo.userId = r.me.toLowerCase();
        if (r.nickname) myProfileInfo.nickname = r.nickname.trim();
        if (r.tokens && typeof r.tokens === 'object') {
          Object.assign(state.xsecTokens, r.tokens);
        }
        return r;
      }
    } catch (e) {}
    return { me: '', nickname: '' };
  }

  async function syncPageTokens() {
    try {
      const r = await bridge('tokens', {}, 3000);
      if (r && r.tokens && typeof r.tokens === 'object') {
        Object.assign(state.xsecTokens, r.tokens);
      }
    } catch (e) {}
  }

  async function detectMyUserId() {
    const info = await detectMyUserInfo();
    return (info && info.me) || myProfileInfo.userId || '';
  }

  /** 判断是否为当前用户发布的原创笔记（严禁采集与批量操作） */
  function isOwnNote(note) {
    if (!note || !note.id) return false;
    if (ownNoteIdSet.has(note.id)) return true;

    // 1. 若卡片标注的作者 UID 与当前博主 UID 一致，坚决判定为原创笔记！
    if (myProfileInfo.userId && note.authorId) {
      if (note.authorId.toLowerCase() === myProfileInfo.userId.toLowerCase()) return true;
    }

    // 2. 若卡片标注的作者昵称与当前博主昵称一致（至少2字），坚决判定为原创笔记！
    if (myProfileInfo.nickname && myProfileInfo.nickname.length >= 2 && note.author) {
      if (note.author.trim() === myProfileInfo.nickname.trim()) return true;
    }

    return false;
  }

  /** 发一次写请求；返回 {status, payload} */
  async function callWrite(mode, phase, noteId) {
    const req = C.buildWrite(mode, phase, noteId);
    const res = await bridge('call', { path: req.path, method: req.method, body: req.body }, 20000);
    return { status: res.status, payload: res.payload };
  }

  /* ============================ DOM：卡片 / 标签页 ============================ */

  const CARD_SELECTORS = [
    'section.note-item',
    '.note-item',
    '.feeds-container .note-item',
    '.feeds-container section',
    'section[class*="note"]',
    '.note-card',
    '.feed-card'
  ];
  const LINK_SELECTORS = ['a[href*="/explore/"]', 'a.cover[href]', 'a[href*="/discovery/item/"]'];
  const TITLE_SELECTORS = ['.title span', '.footer .title span', '.title', '.footer .title'];

  function isCardVisible(el) {
    if (!el) return false;
    // 1. 标准 checkVisibility API (Chrome 105+)
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
          return false;
        }
      } catch (e) {}
    }
    // 2. 传统 display:none 检测 (自身或祖先 display:none 时 offsetParent 为 null)
    if (el.offsetParent === null) {
      try {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const st = window.getComputedStyle(el);
        if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
      } catch (e) {}
    }
    // 3. 祖先隐藏属性
    if (el.closest) {
      if (el.closest('[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"], [style*="visibility: hidden"]')) {
        return false;
      }
    }
    return true;
  }

  function isCardInWrongTabContainer(el, tab) {
    if (!el || !el.closest || !tab) return false;
    if (tab === 'collect') {
      if (el.closest('#userLikeFeeds, #userPostedFeeds, .user-like, .user-posted, [class*="like-feeds"], [class*="likeFeeds"]')) {
        return true;
      }
    } else if (tab === 'like') {
      if (el.closest('#userCollectFeeds, #userPostedFeeds, .user-collect, .user-posted, [class*="collect-feeds"], [class*="collectFeeds"]')) {
        return true;
      }
    } else if (tab === 'notes') {
      if (el.closest('#userCollectFeeds, #userLikeFeeds, .user-collect, .user-like')) {
        return true;
      }
    }
    return false;
  }

  function cardNodes(forTab) {
    const curTab = forTab || getPageActualTabType();
    const out = [];
    for (let i = 0; i < CARD_SELECTORS.length; i++) {
      const list = $$(CARD_SELECTORS[i]);
      for (let j = 0; j < list.length; j++) {
        const node = list[j];
        if (!isCardVisible(node)) continue;
        if (isCardInWrongTabContainer(node, curTab)) continue;
        if (out.indexOf(node) === -1) out.push(node);
      }
    }
    if (out.length > 0) return out;

    // 强力兜底：通过 /explore/ 链接反向向上寻找卡片容器
    const links = $$('a[href*="/explore/"]');
    for (let i = 0; i < links.length; i++) {
      const a = links[i];
      const card = (a.closest && a.closest('section, article, [class*="note"], [class*="item"], [class*="card"]')) || a.parentElement;
      if (card && isCardVisible(card) && !isCardInWrongTabContainer(card, curTab) && out.indexOf(card) === -1) {
        out.push(card);
      }
    }
    return out;
  }

  function noteFromCard(el) {
    if (!el) return null;

    let href = '';
    let id = '';
    let token = '';

    // 收集卡片关联的所有 <a> 候选节点
    const candidates = [];
    if (el.tagName === 'A' && (el.getAttribute('href') || el.href)) {
      candidates.push(el);
    }
    const innerLinks = $$('a[href]', el);
    for (let i = 0; i < innerLinks.length; i++) {
      candidates.push(innerLinks[i]);
    }
    if (el.closest) {
      const up = el.closest('a[href]');
      if (up) candidates.push(up);
    }

    // 优先匹配既有 noteId 且携带 xsec_token 的有效链接
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i];
      const rawH = a.getAttribute('href') || a.href || '';
      const nid = C.extractNoteId(rawH);
      if (nid) {
        if (!id) {
          id = nid;
          href = rawH;
        }
        const t = C.extractXsecToken(rawH) || a.getAttribute('data-xsec-token') || a.getAttribute('data-token') || '';
        if (t) {
          id = nid;
          href = rawH;
          token = t;
          break; // 找到完整带 token 凭证的链接，立即采纳
        }
      }
    }

    if (!id) return null;

    // 提取可绕过防爬/扫码拦截的 xsec_token 安全凭证并生成完整原文链接
    if (!token && el.getAttribute) {
      token = el.getAttribute('data-xsec-token') || el.getAttribute('data-token') || '';
    }
    if (!token && state.xsecTokens && state.xsecTokens[id]) {
      token = state.xsecTokens[id];
    }
    if (token && id) {
      state.xsecTokens[id] = token;
    }

    const noteUrl = C.buildNoteUrl(href || id, token);

    let title = '';
    for (let i = 0; i < TITLE_SELECTORS.length; i++) {
      const t = $(TITLE_SELECTORS[i], el);
      if (t && t.textContent && t.textContent.trim()) { title = t.textContent.trim(); break; }
    }
    if (!title) {
      const titleEl = el.querySelector('.title, .footer, [class*="title"], a[title]');
      if (titleEl) title = (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
    }
    let cover = '';
    const img = $('img', el);
    if (img) {
      cover = img.getAttribute('src') || img.getAttribute('data-src') || '';
      if (!title) title = (img.getAttribute('alt') || '').trim();
    }

    // 提取作者：必须限定在作者区域内部，严禁在卡片外层误抓其他链接！
    let author = '';
    let authorId = '';
    const authorContainer = el.querySelector('.author, .author-wrapper, .user, .name-container, .footer .author, [class*="author"]');
    if (authorContainer) {
      const authorNameEl = authorContainer.querySelector('.name, .author-name, .user-name') || authorContainer;
      author = (authorNameEl.textContent || '').trim();
      const authorLink = (authorContainer.tagName === 'A' && authorContainer.getAttribute('href'))
        ? authorContainer
        : authorContainer.querySelector('a[href*="/user/profile/"]');
      if (authorLink) {
        authorId = C.extractUserId(authorLink.getAttribute('href'));
      }
    }

    return {
      id: id,
      title: title.replace(/\s+/g, ' ').slice(0, 80),
      author: author.replace(/\s+/g, ' ').slice(0, 40),
      authorId: authorId,
      cover: cover,
      url: noteUrl,
      xsecToken: token,
    };
  }

  /**
   * 扫描当前页面可见的笔记卡片。
   * 核心安全保护：若明确处于发布笔记页（自己的原创笔记），绝对不读！
   */
  function scanCards(forTab) {
    if (isOwnNotesPage()) return [];

    const out = [];
    cardNodes(forTab).forEach(function (el) {
      const n = noteFromCard(el);
      if (n && !isOwnNote(n)) out.push(n);
    });
    return C.dedupeNotes(out);
  }

  let currentScannedTabType = '';
  let tabTransitionLock = false;
  let tabTransitionTarget = '';
  let tabTransitionStaleIds = new Set();
  let tabTransitionStartTime = 0;
  let activeScanSessionId = 0;
  let tabSwitchGeneration = 0; // 每次 Tab 切换递增，用于废弃所有旧异步链

  /**
   * 即刻熔断所有正在执行的后台读取/扫描循环，并递增会话标识
   */
  function abortActiveScan(reason) {
    activeScanSessionId++;
    if (state.scanning || state.running) {
      state.stopRequested = true;
      state.scanning = false;
      log('已中止先前执行中的读取扫描（' + (reason || 'Tab 切换') + '）以彻底杜绝串仓', 'warn');
      broadcastState();
    }
  }

  /**
   * 启动严格的 Tab 切换过渡保护：
   * 1. 立即熔断后台扫描任务；
   * 2. 拍摄当前 DOM 中所有卡片 ID 以及前一模式已缓存的卡片 ID 作为陈旧卡片黑名单；
   * 3. 开启 tabTransitionLock，直至页面换批渲染新卡片且旧卡片彻底卸载。
   */
  function beginTabTransition(targetTab) {
    if (!targetTab || (targetTab !== 'collect' && targetTab !== 'like' && targetTab !== 'notes')) return;
    // 如果已经在目标 Tab 且无未决过渡，直接保持就绪状态
    if (currentScannedTabType === targetTab && !tabTransitionLock) return;

    abortActiveScan('切换标签至「' + (targetTab === 'like' ? '点赞' : (targetTab === 'collect' ? '收藏' : '发布笔记')) + '」');

    const targetMode = targetTab === 'like' ? 'unlike' : (targetTab === 'collect' ? 'uncollect' : '');
    const prevMode = currentScannedTabType === 'like' ? 'unlike' : (currentScannedTabType === 'collect' ? 'uncollect' : '');
    const oppositeMode = targetTab === 'collect' ? 'unlike' : (targetTab === 'like' ? 'uncollect' : '');

    // 目标模式的已有卡片集合（防止频繁切换时将目标模式已有的正常卡片误加入黑名单）
    const targetKnownIds = new Set(
      ((targetMode && state.modeCache && state.modeCache[targetMode]) || []).map(function (n) { return n.id; })
    );

    // 黑名单初始化：仅包含当前 DOM 中不属于目标模式的卡片（即真正来自旧 Tab 的卡片）
    tabTransitionStaleIds = new Set();
    pageCardIds().forEach(function (id) {
      if (!targetKnownIds.has(id)) {
        tabTransitionStaleIds.add(id);
      }
    });

    if (prevMode && state.modeCache && state.modeCache[prevMode]) {
      state.modeCache[prevMode].forEach(function (n) {
        if (n && n.id && !targetKnownIds.has(n.id)) tabTransitionStaleIds.add(n.id);
      });
    }

    // 严密加入对立模式已有的全部卡片，彻底物理阻断对立模式渗透
    if (oppositeMode && state.modeCache && state.modeCache[oppositeMode]) {
      state.modeCache[oppositeMode].forEach(function (n) {
        if (n && n.id && !targetKnownIds.has(n.id)) tabTransitionStaleIds.add(n.id);
      });
    }

    tabTransitionLock = true;
    tabTransitionTarget = targetTab;
    tabTransitionStartTime = Date.now();
    currentScannedTabType = targetTab;
    tabSwitchGeneration++;

    clearPageCards();
  }

  /**
   * 自动感知用户在页面上已加载/滚动的笔记，无感合入对应模式的独立 candidates 缓存。
   * 即使未点击「读取列表」，只要用户浏览到了卡片，右侧面板即展示数据（默认未选）。
   */
  function syncDomCardsToCandidates() {
    if (!PROFILE_RE.test(location.pathname)) return false;
    if (isOwnNotesPage()) return false;
    quietly(syncPageTokens());

    // 智能识别卡片归属：必须基于左侧小红书页面客观真实的 Tab / URL！
    // 严禁受侧边栏筛选按钮（state.settings.mode）篡改，防止把收藏卡片误存入点赞缓存！
    const actualTab = getPageActualTabType();
    if (actualTab !== 'collect' && actualTab !== 'like') {
      return false;
    }

    // 检测到隐式 Tab 切换（例如用户后退/前进或直接改 URL）
    if (currentScannedTabType && currentScannedTabType !== actualTab && !tabTransitionLock) {
      beginTabTransition(actualTab);
    }
    if (!currentScannedTabType) {
      currentScannedTabType = actualTab;
    }

    // 过渡期严格防护：过渡锁期间一律拒绝入库旧卡片！
    if (tabTransitionLock) {
      // 若实际 Tab 尚未切到目标 Tab，坚决不读
      if (actualTab !== tabTransitionTarget) {
        return false;
      }

      const allCards = scanCards(actualTab);
      if (!allCards.length) {
        return false; // DOM 处于清空/加载中状态，暂不入库
      }

      // 只要 DOM 中的卡片全部是切换前拍摄的旧卡片，说明小红书新卡片尚未渲染，坚决拒绝入库！
      const allStale = allCards.every(function (c) {
        return tabTransitionStaleIds.has(c.id);
      });
      if (allStale) {
        // 只要 DOM 中的卡片全部仍是切换前拍摄的旧卡片，坚决拒绝入库，耐心等待小红书新数据渲染！
        return false;
      }

      // 新批次卡片已出现（!allStale）！
      const anyStale = allCards.some(function (c) {
        return tabTransitionStaleIds.has(c.id);
      });
      // 只有当 DOM 中的旧卡片全部彻底卸载后，才安全解除过渡锁与清空黑名单
      if (!anyStale) {
        tabTransitionLock = false;
        tabTransitionStaleIds.clear();
      }
    }

    const targetMode = actualTab === 'like' ? 'unlike' : 'uncollect';
    if (!state.modeCache[targetMode]) state.modeCache[targetMode] = [];
    const targetList = state.modeCache[targetMode];

    const cards = scanCards(actualTab);
    if (!cards.length) return false;

    // 过滤掉前一个 Tab 残留在 DOM 里的旧卡片以及本人发布的笔记
    const validCards = [];
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      if (isOwnNote(c)) continue;
      // 只要卡片属于切换前拍摄的旧卡片黑名单（说明来自前一个 Tab），坚决丢弃，绝不串仓！
      if (tabTransitionStaleIds && tabTransitionStaleIds.has(c.id)) {
        continue;
      }
      validCards.push(c);
    }

    if (!validCards.length) return false;

    let changed = false;
    const existingMap = new Map();
    for (let i = 0; i < targetList.length; i++) {
      existingMap.set(targetList[i].id, targetList[i]);
    }

    for (let i = 0; i < validCards.length; i++) {
      const c = validCards[i];
      if (!existingMap.has(c.id)) {
        targetList.push(c);
        existingMap.set(c.id, c);
        changed = true;
      } else {
        const old = existingMap.get(c.id);
        if (c.title && (!old.title || old.title === '未命名笔记' || old.title.length < c.title.length)) {
          old.title = c.title;
          changed = true;
        }
        if (c.author && !old.author) {
          old.author = c.author;
          changed = true;
        }
        if (c.cover && !old.cover) {
          old.cover = c.cover;
          changed = true;
        }
      }
    }

    syncActiveModePointers();
    return changed;
  }

  const OWN_NOTE_TAB_KEYWORDS = ['笔记', '发布', '原创', '视频', '图文'];

  function detectTabFromText(text) {
    const clean = String(text || '').replace(/\s+/g, '');
    if (clean.indexOf('全部笔记') !== -1) return 'collect';
    if (/(?:赞过|点赞|喜欢)/.test(clean)) return 'like';
    if (/(?:收藏|合集)/.test(clean)) return 'collect';
    if (/(?:笔记|发布|原创|图文|视频)/.test(clean)) return 'notes';
    return '';
  }

  function isOwnNotesTab(el) {
    if (!el) return false;
    const text = (typeof el === 'string' ? el : (el.textContent || '')).replace(/\s+/g, '').replace(/\d+/g, '');
    return OWN_NOTE_TAB_KEYWORDS.some(function (k) { return text.indexOf(k) === 0; });
  }

  function isTabItemActive(el) {
    if (!el) return false;
    if (el.getAttribute && el.getAttribute('aria-selected') === 'true') return true;
    if (el.classList) {
      if (el.classList.contains('reds-tab-item-active') ||
          el.classList.contains('active') ||
          el.classList.contains('selected') ||
          el.classList.contains('is-active')) {
        return true;
      }
    }
    if (ACTIVE_RE.test(el.className || '')) return true;
    if (el.querySelector) {
      const childActive = el.querySelector('.active, .is-active, .selected, .current, [aria-selected="true"]');
      if (childActive) return true;
    }
    return false;
  }

  function mainTabs() {
    // 1. 优先定位同时包含「收藏」与（「点赞」或「发布笔记」）的主 Tab 栏容器
    const headers = $$('#userPageTabs, .user-tabs, .reds-tabs-header, .reds-tabs-list, .user-page-tabs, .user-page .reds-tabs, .reds-tabs, .tab-bar, [class*="tab-bar"], [class*="tabs-header"]');
    for (let h = 0; h < headers.length; h++) {
      if (headers[h].closest && headers[h].closest('.feeds-container, .note-list, #rn-manager-host')) continue;
      const candidates = $$('.reds-tab-item, [role="tab"], .tab-link, [class*="tab-item"]', headers[h]);
      let hasCollect = false;
      let hasLikeOrNotes = false;
      const validInHeader = [];
      for (let i = 0; i < candidates.length; i++) {
        const d = detectTabFromText(candidates[i].textContent);
        if (d === 'collect') hasCollect = true;
        if (d === 'like' || d === 'notes') hasLikeOrNotes = true;
        if (d === 'collect' || d === 'like' || d === 'notes') {
          validInHeader.push(candidates[i]);
        }
      }
      if (hasCollect && hasLikeOrNotes && validInHeader.length >= 2) {
        return validInHeader;
      }
    }

    // 2. 兜底：全页面扫描，严格排除笔记卡片容器与插件自身面板（绝不可误排除带有 sub-tab-list 的主 Tab 自身）
    const all = $$('#userPageTabs .reds-tab-item, .user-page .reds-tab-item, .reds-tabs-header .reds-tab-item, .reds-tab-item, [role="tab"], .tab-link, [class*="tab-item"]');
    const matched = all.filter(function (el) {
      if (el.closest && el.closest('.tab-content-item, .feeds-container, .note-list, #rn-manager-host')) return false;
      const detected = detectTabFromText(el.textContent);
      return detected === 'like' || detected === 'collect' || detected === 'notes';
    });
    const uniq = [];
    matched.forEach(function (el) { if (uniq.indexOf(el) === -1) uniq.push(el); });
    if (uniq.length >= 2) return uniq;
    return all.filter(function (el) { return !el.closest || !el.closest('.tab-content-item, .feeds-container, .note-list, #rn-manager-host'); });
  }

  function getTabFromUrl() {
    try {
      const search = new URLSearchParams(location.search);
      const tab = (search.get('tab') || search.get('tab_name') || search.get('type') || '').toLowerCase();
      // 1. 精准匹配小红书官方地址栏参数（收藏：tab=fav&subTab=note；点赞：tab=liked；发布笔记：tab=note）
      if (tab === 'fav' || tab === 'collect' || tab === 'board' || tab === 'star') return 'collect';
      if (tab === 'liked' || tab === 'like' || tab === 'zan') return 'like';
      if (tab === 'note' || tab === 'publish' || tab === 'post') return 'notes';

      // 2. 泛匹配
      if (/collect|fav|star|board|album/.test(tab)) return 'collect';
      if (/like|praise|zan/.test(tab)) return 'like';
      if (/note|publish|own|post|video/.test(tab)) return 'notes';

      const hash = (location.hash || '').toLowerCase();
      if (/collect|fav|star|board|album/.test(hash)) return 'collect';
      if (/like|praise|zan/.test(hash)) return 'like';
      if (/note|publish|own|post|video/.test(hash)) return 'notes';
    } catch (e) {}
    return '';
  }

  /**
   * 严谨判定当前左侧小红书页面客观所展示的内容类型：
   * 'collect' (收藏) | 'like' (赞过) | 'notes' (我的笔记) | '' (未识别)
   * 
   * 权威判定顺序：
   * 1. 绝对第一标准：页面主 Tab 当前客观高亮的 DOM 激活项（用户眼见为实）
   *    在 SPA 单页应用中，DOM 激活状态直接决定了页面渲染的内容。严禁盲信 URL 参数，
   *    防止用户在页面切换 Tab 时因 URL Query 未同步更新而导致点赞笔记串仓存入收藏缓存！
   * 2. 兜底：若 DOM 尚未就绪或未找到高亮项，检查官方地址栏参数（URL Query Parameter）
   * 3. 根路径 /user/profile/:id 无任何参数时，小红书默认展现博主自己的发布笔记列表 ('notes')
   */
  function getPageActualTabType() {
    // 1. 优先读取主 Tab 自身真实激活状态（用户眼见为实的 DOM 真实态）
    const cur = activeTabEl();
    if (cur) {
      const detected = detectTabFromText(cur.textContent);
      if (detected) return detected;
    }

    // 2. 兜底：若 DOM 尚未渲染完成或未检出 active 标记，读取官方地址栏参数
    const urlTab = getTabFromUrl();
    if (urlTab) return urlTab;

    // 3. 若 DOM 与 URL 尚未就绪，返回空字符串，绝不盲目套用侧边栏模式，彻底杜绝串仓！
    return '';
  }

  function activeTabEl() {
    const tabs = mainTabs();
    if (!tabs || !tabs.length) return null;

    // 阶段 1：首选显式激活标记（aria-selected 或 active class）
    for (let i = 0; i < tabs.length; i++) {
      if (isTabItemActive(tabs[i])) return tabs[i];
    }

    // 阶段 2：检查是否有红色指示条（.reds-tab-ink-bar / active indicator）对齐
    for (let i = 0; i < tabs.length; i++) {
      const el = tabs[i];
      const parent = el.parentElement;
      if (parent) {
        const bar = parent.querySelector('.reds-tab-ink-bar, .ink-bar, .indicator, .active-bar');
        if (bar) {
          try {
            const barRect = bar.getBoundingClientRect();
            const tabRect = el.getBoundingClientRect();
            const barCenter = barRect.left + barRect.width / 2;
            if (barCenter >= tabRect.left && barCenter <= tabRect.right) {
              return el;
            }
          } catch (e) {}
        }
      }
    }

    // 阶段 3：字体粗细横向对比（只有独占最高字重且比其他所有 Tab 都更粗时才采纳）
    let maxFw = 0;
    let heaviestEl = null;
    let maxCount = 0;
    for (let i = 0; i < tabs.length; i++) {
      try {
        const fwStr = window.getComputedStyle(tabs[i]).fontWeight;
        const fw = parseInt(fwStr, 10) || (fwStr === 'bold' ? 700 : 400);
        if (fw > maxFw) {
          maxFw = fw;
          heaviestEl = tabs[i];
          maxCount = 1;
        } else if (fw === maxFw) {
          maxCount++;
        }
      } catch (e) {}
    }
    if (maxCount === 1 && maxFw >= 600 && heaviestEl) {
      return heaviestEl;
    }

    return null;
  }

  function isOwnNotesPage() {
    const tabType = getPageActualTabType();
    if (tabType === 'notes') return true;
    if (tabType === 'collect' || tabType === 'like') return false;
    return false;
  }

  function syncModeWithActiveTab() {
    const tabType = getPageActualTabType();
    if (tabType === 'collect' && state.settings.mode !== 'uncollect') {
      state.settings.mode = 'uncollect';
      syncActiveModePointers();
      saveSettings();
      state.anchorId = null;
      clearPageCards();
      afterSelectionChange();
      if (stackState.open) syncStackListToFilter();
      refreshPageCards();
      broadcastState();
    } else if (tabType === 'like' && state.settings.mode !== 'unlike') {
      state.settings.mode = 'unlike';
      syncActiveModePointers();
      saveSettings();
      state.anchorId = null;
      clearPageCards();
      afterSelectionChange();
      if (stackState.open) syncStackListToFilter();
      refreshPageCards();
      broadcastState();
    }
  }

  function tabMatches(el, want) {
    const text = ((el && el.textContent) || '').replace(/\s+/g, '');
    const aliases = TAB_ALIASES[want] || [want];
    return aliases.some(function (a) { return text.indexOf(a) !== -1; });
  }

  function currentTabLabel() {
    const el = activeTabEl();
    return el ? ((el.textContent || '').replace(/\s+/g, '').replace(/\d+/g, '')) : '';
  }

  /** 切完标签后卡片是异步渲染的，必须等到新 Tab 的卡片出现且无旧卡片残留再算就绪 */
  async function waitForCards(timeoutMs, expectedTab) {
    const gen = tabSwitchGeneration;
    const end = nowMs() + (timeoutMs || 4000);
    while (nowMs() < end) {
      // 如果在等待期间又发生了新的 Tab 切换，此异步链已过时，立即放弃
      if (tabSwitchGeneration !== gen) return false;

      const curTab = getPageActualTabType();
      if (expectedTab && curTab !== expectedTab) {
        await sleep(150);
        continue;
      }
      const cards = scanCards(curTab);
      if (cards.length > 0) {
        const allStale = cards.every(function (c) {
          return tabTransitionStaleIds && tabTransitionStaleIds.has(c.id);
        });
        if (!allStale) {
          const anyStale = cards.some(function (c) {
            return tabTransitionStaleIds && tabTransitionStaleIds.has(c.id);
          });
          // 只有当 DOM 中的旧卡片全部消失后，才安全解除过渡锁
          if (!anyStale && tabSwitchGeneration === gen) {
            tabTransitionLock = false;
            tabTransitionStaleIds.clear();
          }
          return true;
        }
      }
      await sleep(150);
    }
    // 超时结束时：若新卡片始终未出现，坚决不释放锁与不清空黑名单，防止旧DOM卡片被当作新数据反向吞噬！
    return false;
  }

  async function ensureTab(want) {
    const wantTab = detectTabFromText(want);
    const cur = activeTabEl();
    if (cur && tabMatches(cur, want)) {
      if (wantTab && wantTab !== currentScannedTabType) {
        beginTabTransition(wantTab);
      }
      return true;
    }

    const tabs = mainTabs();
    const target = tabs.filter(function (el) { return tabMatches(el, want); })[0];
    if (!target) return false;

    // 记录切换前页面的旧卡片黑名单并熔断先前扫描
    if (wantTab && wantTab !== currentScannedTabType) {
      beginTabTransition(wantTab);
    }

    // 触发点击切换（支持原生与事件冒泡分发，双重触发保证 SPA 路由生效）
    try {
      const clickEl = target.querySelector('span, a, [class*="title"], [class*="text"]') || target;
      target.click();
      if (clickEl !== target) clickEl.click();
      clickEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      if (clickEl !== target) {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
    } catch (e) {}

    const deadline = nowMs() + 4500;
    while (nowMs() < deadline) {
      await sleep(200);
      const a = activeTabEl();
      if ((a && tabMatches(a, want)) || (wantTab && getPageActualTabType() === wantTab)) {
        await sleep(200);
        return true;
      }
    }
    await sleep(200);
    const finalA = activeTabEl();
    return !!((finalA && tabMatches(finalA, want)) || (wantTab && getPageActualTabType() === wantTab));
  }

  /* ============================ DOM：滚动加载 ============================ */

  function findScrollContainer() {
    const list = [
      '.feeds-container',
      '.user-page .feeds-container',
      '.note-list',
      '#userPostedFeeds',
      '#userCollectFeeds',
      '#userLikeFeeds',
      '.user-page',
      '.main-container',
      '#app'
    ];
    for (let i = 0; i < list.length; i++) {
      const el = $(list[i]);
      if (el && el.scrollHeight > el.clientHeight + 60) return el;
    }
    return null;
  }

  function scrollStep() {
    const el = findScrollContainer();
    if (el) {
      const step = Math.max(250, Math.round(el.clientHeight * 0.85));
      el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + step);
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 16;
    }
    const step = Math.max(350, Math.round(window.innerHeight * 0.85));
    window.scrollBy(0, step);
    window.dispatchEvent(new Event('scroll'));
    const docHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      document.documentElement.clientHeight
    );
    return window.scrollY + window.innerHeight >= docHeight - 20;
  }

  function scrollToTop() {
    const el = findScrollContainer();
    if (el) el.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  async function collectCandidates() {
    const mySessionId = ++activeScanSessionId;
    state.scanning = true;
    state.stopRequested = false;
    broadcastState();

    const m = state.settings.mode;
    const M = C.MODES[m];
    const expectedTab = (m === 'unlike') ? 'like' : 'collect';

    // 严密防串仓：若当前页面实际展示的 Tab 与模式不匹配，必须先切换并等待真实卡片就绪
    let curTab = getPageActualTabType();
    if (curTab && curTab !== expectedTab) {
      log('当前在「' + (curTab === 'like' ? '点赞' : (curTab === 'collect' ? '收藏' : '我的笔记')) + '」，正在切换至「' + M.tabLabel + '」…', 'info');
      beginTabTransition(expectedTab);
      await ensureTab(M.tabLabel);
      await waitForCards(6000, expectedTab);
      curTab = getPageActualTabType();
    }
    if (curTab !== expectedTab || activeScanSessionId !== mySessionId || state.stopRequested) {
      log('页面当前未能进入「' + M.tabLabel + '」列表或任务已重置，已终止读取以彻底杜绝串仓', 'err');
      state.scanning = false;
      broadcastState();
      return (state.modeCache && state.modeCache[m]) || [];
    }

    const isAutoScroll = state.settings.autoScroll !== false;
    // 当开启「滚动加载全部」时，不再人为截断在 maxPerRun * 3 (如90条)，支持深度加载至 3000 条或页面末尾；
    // 仅在明确关闭滚动时才退守至当前单批上限
    const cap = isAutoScroll ? 3000 : Math.max(60, state.settings.maxPerRun * 3);
    const budget = isAutoScroll ? 120000 : 15000;
    const started = nowMs();

    // 增量合并：若当前模式已缓存有笔记，继承已有集合，避免重复扫描时丢弃或回退
    const existing = (state.modeCache && state.modeCache[m]) || [];
    const acc = new Map();
    existing.forEach(function (n) {
      if (n && n.id) acc.set(n.id, n);
    });

    const merge = function () {
      if (activeScanSessionId !== mySessionId || state.stopRequested) return 0;
      const activeTabNow = getPageActualTabType();
      if (!activeTabNow || activeTabNow !== expectedTab) {
        // 过渡期或 Tab 错位时严格拒绝入库！
        return 0;
      }
      let added = 0;
      scanCards().forEach(function (n) {
        if (tabTransitionStaleIds && tabTransitionStaleIds.has(n.id)) return;
        if (!acc.has(n.id)) {
          acc.set(n.id, n);
          added++;
        } else {
          // 增量补全已有卡片可能缺失的封面、标题与安全凭证
          const old = acc.get(n.id);
          if (n.title && (!old.title || old.title.length < n.title.length)) old.title = n.title;
          if (n.cover && !old.cover) old.cover = n.cover;
          if (n.author && !old.author) old.author = n.author;
          if (n.xsecToken && !old.xsecToken) { old.xsecToken = n.xsecToken; old.url = n.url; }
        }
      });
      return added;
    };

    // 若此前没有扫描过任何笔记，先从顶部开始采集；若已有缓存，直接从当前视口继续向下滚读
    if (!existing.length) {
      scrollToTop();
      await sleep(350);
    }

    merge();
    state.modeCache[m] = Array.from(acc.values());
    syncActiveModePointers();
    broadcastState();

    let stall = 0;
    let lastLogSize = acc.size;
    let lastLogTime = nowMs();

    while (nowMs() - started < budget && acc.size < cap) {
      if (activeScanSessionId !== mySessionId || state.stopRequested) {
        log('已停止扫描列表，当前保留已识别的 ' + acc.size + ' 篇笔记', 'warn');
        break;
      }

      const curTabNow = getPageActualTabType();
      if (curTabNow !== expectedTab) {
        log('检测到页面已离开「' + M.tabLabel + '」列表，已立即中止扫描以彻底杜绝串仓', 'warn');
        break;
      }

      const before = acc.size;
      const atBottom = scrollStep();
      await sleep(700);

      if (activeScanSessionId !== mySessionId || state.stopRequested) break;
      if (getPageActualTabType() !== expectedTab) break;

      merge();

      // 实时同步数据到全局状态与面板计数看板
      state.modeCache[m] = Array.from(acc.values());
      syncActiveModePointers();
      broadcastState();

      if (acc.size > before) {
        stall = 0;
        // 每新识别出卡片，平滑打印阶段性进度（避免刷屏，间隔至少 15 条或 2.5 秒）
        if (acc.size - lastLogSize >= 15 || nowMs() - lastLogTime >= 2500) {
          log('正在读取「' + (M ? M.tabLabel : '笔记') + '」… 已累计识别 ' + acc.size + ' 篇', 'info');
          lastLogSize = acc.size;
          lastLogTime = nowMs();
        }
        continue;
      }

      if (atBottom) {
        stall++;
        // 容错提升：至少连续 6 次检测到底部且完全无新卡片，才确认已达真实末尾（给慢速网络留出充分缓冲时间）
        if (stall >= 6) break;

        // 核心技巧：在底部触发微小的上下抖动回弹，强制唤醒可能休眠的 IntersectionObserver 或滚动监听器
        const el = findScrollContainer();
        if (el) {
          el.scrollTop = Math.max(0, el.scrollTop - 40);
          await sleep(120);
          el.scrollTop = el.scrollTop + 40;
          el.dispatchEvent(new Event('scroll', { bubbles: true }));
        } else {
          window.scrollBy(0, -60);
          await sleep(120);
          window.scrollBy(0, 60);
          window.dispatchEvent(new Event('scroll'));
        }

        await sleep(1000);
        if (activeScanSessionId !== mySessionId || state.stopRequested) break;
        if (getPageActualTabType() !== expectedTab) break;
        merge();
      }
    }

    scrollToTop();
    const result = Array.from(acc.values());
    state.modeCache[m] = result;
    syncActiveModePointers();
    state.scanning = false;
    broadcastState();
    return result;
  }

  /* ============================ 前置校验 ============================ */

  function hasOwnProfileMarker() {
    const scope = $('.user-page') || $('.user-info') || $('#userPageContainer') || document.body;
    if (!scope) return false;
    const text = (scope.innerText || '').slice(0, 4000);
    return EDIT_TEXT.test(text);
  }

  async function assertOwnProfile() {
    const m = location.pathname.match(PROFILE_RE);
    if (!m) throw new Error('请先打开你自己的主页（xiaohongshu.com/user/profile/…）');
    const pageId = (m[1] || '').toLowerCase();

    const me = await detectMyUserId();
    if (pageId && me && me !== pageId) {
      throw new Error('当前是别人的主页（' + pageId + '），已阻止操作');
    }
    if (me && me === pageId) return pageId;

    if (hasOwnProfileMarker()) return pageId || me || 'self';
    log('无法从页面确认这是你自己的主页，请自己确认后再开始', 'warn');
    return pageId || me || 'self';
  }

  /* ============================ 搜索与选择 ============================ */

  function visibleCandidates() {
    const terms = C.parseKeywords(state.settings.keyword);
    const m = state.settings.mode;
    return state.candidates.filter(function (n) {
      return !isProcessed(m, n.id) && C.matchKeywords(n, terms);
    });
  }

  function noteById(id) {
    for (let i = 0; i < state.candidates.length; i++) {
      if (state.candidates[i].id === id) return state.candidates[i];
    }
    return null;
  }

  function selectedTargets() {
    const mode = state.settings.mode;
    const out = [];
    const seen = new Set();
    state.candidates.forEach(function (n) {
      if (!state.selected.has(n.id) || isProcessed(mode, n.id)) return;
      out.push(n);
      seen.add(n.id);
    });
    state.selected.forEach(function (n, id) {
      if (seen.has(id) || isProcessed(mode, id)) return;
      out.push(n);
    });
    return out;
  }

  /**
   * 勾选发生变化时的统一收尾：
   * 1. 刷新小红书页面底部的已选条数浮动反馈栏
   * 2. 刷新页面卡片的高亮与勾选状态
   * 3. 广播给 Chrome 原生侧边栏以保持实时同步
   */
  function afterSelectionChange(feedback) {
    updateSelectionFeedback(feedback);
    refreshPageCards();
    broadcastState();
  }

  function toggleSelection(note, shiftKey, ctx) {
    if (!note || !note.id) return;
    const mode = state.settings.mode;
    const id = note.id;
    if (isProcessed(mode, id)) return;

    const order = (ctx && ctx.order) || visibleCandidates().map(function (n) { return n.id; });
    const lookup = (ctx && ctx.lookup) || function (x) { return noteById(x) || { id: x, title: '' }; };

    const idx = order.indexOf(id);
    const anchorIdx = state.anchorId ? order.indexOf(state.anchorId) : -1;
    const prevSize = state.selected.size;
    const wasSel = state.selected.has(id);

    if (shiftKey && anchorIdx !== -1 && idx !== -1 && anchorIdx !== idx) {
      C.selectRange(order, anchorIdx, idx).forEach(function (x) {
        if (isProcessed(mode, x)) return;
        if (!state.selected.has(x)) state.selected.set(x, lookup(x));
      });
      state.anchorId = id;
      const delta = state.selected.size - prevSize;
      afterSelectionChange({
        type: 'range',
        delta: delta,
        total: state.selected.size,
        text: '✓ 已区间选择 ' + delta + ' 篇（当前共 ' + state.selected.size + ' 篇）',
      });
    } else if (wasSel) {
      state.selected.delete(id);
      state.anchorId = id;
      afterSelectionChange({
        type: 'remove',
        title: note.title,
        total: state.selected.size,
        text: '已取消选择：' + titleOf(note) + '（当前共 ' + state.selected.size + ' 篇）',
      });
    } else {
      state.selected.set(id, { id: id, title: note.title || '' });
      state.anchorId = id;
      afterSelectionChange({
        type: 'add',
        title: note.title,
        total: state.selected.size,
        text: '✓ 已勾选：' + titleOf(note) + '（当前共 ' + state.selected.size + ' 篇）',
      });
    }
  }

  function selectAllVisible(explicitIds) {
    const mode = state.settings.mode;
    const pool = Array.isArray(explicitIds)
      ? explicitIds.map(function (id) { return state.candidates.get(id); }).filter(Boolean)
      : visibleCandidates();
    let added = 0;
    pool.forEach(function (n) {
      if (isProcessed(mode, n.id)) return;
      if (!state.selected.has(n.id)) {
        state.selected.set(n.id, { id: n.id, title: n.title || '' });
        added++;
      }
    });
    afterSelectionChange({
      type: 'all',
      total: state.selected.size,
      text: '✓ 已全选当前可见笔记（当前共 ' + state.selected.size + ' 篇）',
    });
  }

  function invertVisible(explicitIds) {
    const mode = state.settings.mode;
    const pool = Array.isArray(explicitIds)
      ? explicitIds.map(function (id) { return state.candidates.get(id); }).filter(Boolean)
      : visibleCandidates();
    pool.forEach(function (n) {
      if (isProcessed(mode, n.id)) return;
      if (state.selected.has(n.id)) state.selected.delete(n.id);
      else state.selected.set(n.id, { id: n.id, title: n.title || '' });
    });
    state.anchorId = null;
    afterSelectionChange({
      type: 'invert',
      total: state.selected.size,
      text: '已反选可见笔记（当前共 ' + state.selected.size + ' 篇）',
    });
  }

  function clearSelection() {
    state.selected.clear();
    state.anchorId = null;
    afterSelectionChange({
      type: 'clear',
      total: 0,
      text: '已清空勾选',
    });
  }

  /* ============================ 页面卡片勾选框 ============================ */

  let pageStyleEl = null;
  let pageTimer = null;

  function ensurePageStyle() {
    if (pageStyleEl && pageStyleEl.isConnected) return;
    pageStyleEl = document.createElement('style');
    pageStyleEl.id = 'rn-page-style';
    pageStyleEl.textContent = STYLE;
    (document.head || document.documentElement).appendChild(pageStyleEl);
  }

  function cardIdOf(el) {
    if (!el) return '';
    let href = '';
    if (el.tagName === 'A' && el.getAttribute('href')) {
      href = el.getAttribute('href');
    }
    if (!href && el.querySelector) {
      const a = el.querySelector('a[href*="/explore/"], a.cover[href], a[href*="/discovery/item/"]');
      if (a && a.getAttribute('href')) href = a.getAttribute('href');
    }
    if (!href && el.querySelector) {
      const anyA = el.querySelector('a[href]');
      if (anyA && anyA.getAttribute('href')) href = anyA.getAttribute('href');
    }
    return C.extractNoteId(href);
  }

  function pageCardIds() {
    const ids = [];
    const seen = new Set();
    cardNodes().forEach(function (el) {
      const id = cardIdOf(el);
      if (!id || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    });
    return ids;
  }

  function pageNoteFor(id) {
    const cards = cardNodes();
    for (let i = 0; i < cards.length; i++) {
      if (cardIdOf(cards[i]) !== id) continue;
      const n = noteFromCard(cards[i]);
      if (n) return n;
    }
    return null;
  }

  function ensureBadge(el) {
    let badge = el.querySelector(':scope > .rn-pick');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'rn-pick';
      badge.setAttribute('role', 'checkbox');
      badge.setAttribute('tabindex', '0');
      el.appendChild(badge);
    }
    return badge;
  }

  function isRelevantTab() {
    const curType = getPageActualTabType();
    if (curType === 'notes') return false;
    if (curType === 'like' && state.settings.mode === 'unlike') return true;
    if (curType === 'collect' && state.settings.mode === 'uncollect') return true;
    const cur = activeTabEl();
    if (!cur) return true;
    return tabMatches(cur, C.MODES[state.settings.mode].tabLabel);
  }

  function refreshPageCards() {
    if (!state.mounted) return;
    if (!PROFILE_RE.test(location.pathname)) return;
    ensurePageStyle();

    document.documentElement.setAttribute('data-rn-tab', isRelevantTab() ? '1' : '0');

    const mode = state.settings.mode;
    const rawQuery = (state.settings.keyword || '').trim();
    const terms = C.parseKeywords(rawQuery);
    const cards = cardNodes();
    let matchedCount = 0;
    let relevantCount = 0;

    for (let i = 0; i < cards.length; i++) {
      const el = cards[i];
      const id = cardIdOf(el);
      if (!id) continue;

      const n = noteById(id) || noteFromCard(el);
      if (isOwnNote(n)) {
        // 核心安全隔离：自己的原创笔记，绝对不加勾选框！
        const oldBadge = el.querySelector(':scope > .rn-pick');
        if (oldBadge) oldBadge.remove();
        el.classList.remove('rn-card-sel', 'rn-card-dim', 'rn-card-done');
        continue;
      }
      relevantCount++;

      if (!el.dataset.rnPos) {
        try {
          const pos = getComputedStyle(el).position;
          if (!pos || pos === 'static' || pos === 'initial') el.style.position = 'relative';
        } catch (e) { /* 忽略 */ }
        el.dataset.rnPos = '1';
      }

      const badge = ensureBadge(el);
      if (el.dataset.rnId !== id) {
        el.dataset.rnId = id;
        el.classList.remove('rn-card-sel');
        badge.classList.remove('rn-on', 'rn-done');
      }
      badge.dataset.rnId = id;

      const sel = state.selected.has(id);
      const done = isProcessed(mode, id);
      const match = !rawQuery || C.matchKeywords(
        { id: id, title: (noteById(id) || noteFromCard(el) || {}).title || '' },
        terms
      );
      if (match) matchedCount++;

      el.classList.toggle('rn-card-sel', sel && !done);
      // 只有在侧边栏保持连接打开时才对非命中卡片进行视觉暗化
      el.classList.toggle('rn-card-dim', state.sidepanelConnected && !!rawQuery && !match);
      badge.classList.toggle('rn-on', sel && !done);
      badge.classList.toggle('rn-done', done);
      badge.setAttribute('aria-checked', sel ? 'true' : 'false');
      badge.title = done
        ? '这篇已经处理过了'
        : (sel ? '取消勾选（Shift 点击可区间多选）' : '勾选这篇（Shift 点击可区间多选）');
    }

    updateFilterPill(rawQuery, matchedCount, relevantCount);
  }

  function updateFilterPill(rawQuery, matchedCount, totalCount) {
    if (!state.els || !state.els.filterPill) return;
    const pill = state.els.filterPill;
    const txt = state.els.filterPillText;
    const q = (rawQuery !== undefined ? rawQuery : (state.settings.keyword || '')).trim();

    if (!state.sidepanelConnected || !q) {
      pill.classList.remove('rn-show', 'rn-pill-stacked');
      return;
    }

    const m = matchedCount !== undefined ? matchedCount : 0;
    const t = totalCount !== undefined ? totalCount : 0;
    const isWrapVisible = state.els.wrap && !state.els.wrap.classList.contains('rn-hidden');
    pill.classList.toggle('rn-pill-stacked', isWrapVisible);

    const escQ = q.length > 12 ? q.slice(0, 12) + '…' : q;
    if (m === 0 && t > 0) {
      txt.innerHTML = '正在筛选：“<b>' + esc(escQ) + '</b>”（当前页面 0 篇匹配）';
    } else {
      txt.innerHTML = '正在筛选：“<b>' + esc(escQ) + '</b>”（已匹配 <b>' + m + '</b>/' + t + ' 篇）';
    }
    pill.classList.add('rn-show');
  }

  function clearPageCards() {
    if (pageTimer) { clearInterval(pageTimer); pageTimer = null; }
    try {
      $$('.rn-pick').forEach(function (b) { b.remove(); });
      cardNodes().forEach(function (el) {
        el.classList.remove('rn-card-sel', 'rn-card-dim', 'rn-card-done');
        if (el.dataset.rnPos === '1' && el.style && el.style.position === 'relative') el.style.position = '';
        delete el.dataset.rnId;
        delete el.dataset.rnPos;
      });
      if (state.els && state.els.filterPill) {
        state.els.filterPill.classList.remove('rn-show', 'rn-pill-stacked');
      }
      document.documentElement.removeAttribute('data-rn-tab');
    } catch (e) { /* 忽略 */ }
  }

  function bindPageEvents() {
    if (window.__rnPageBound) return;
    window.__rnPageBound = true;

    const stopIfBadge = function (ev) {
      if (!(ev.target && ev.target.closest && ev.target.closest('.rn-pick'))) return false;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      return true;
    };

    window.addEventListener('mousedown', stopIfBadge, true);

    window.addEventListener('click', function (ev) {
      if (!stopIfBadge(ev)) return;
      const badge = ev.target.closest('.rn-pick');
      const el = badge.closest('.note-item') || badge.parentElement;
      const id = badge.dataset.rnId || (el && el.dataset.rnId);
      if (!id) return;
      if (!isRelevantTab()) {
        const msg = '当前不在「' + C.MODES[state.settings.mode].tabLabel + '」列表，先切换标签页再勾选';
        log(msg, 'warn');
        showToast(msg);
        return;
      }
      if (isProcessed(state.settings.mode, id)) {
        log('这篇已经处理过了', 'warn');
        showToast('这篇笔记已经处理过了');
        return;
      }

      const note = noteFromCard(el);
      if (!note || isOwnNote(note)) {
        showToast('这是你发布的原创笔记，不支持取消收藏/点赞');
        return;
      }
      note.id = id;
      if (!noteById(id)) {
        state.candidates.push(note);
        log('已把「' + titleOf(note) + '」加入候选（页面上勾选的）', 'info');
      }

      toggleSelection(note, !!ev.shiftKey, {
        order: pageCardIds(),
        lookup: function (x) { return pageNoteFor(x) || noteById(x) || { id: x, title: '' }; },
      });
    }, true);

    window.addEventListener('keydown', function (ev) {
      if (stackState.open) {
        if (ev.key === 'Escape') {
          closeStackView();
          return;
        }
        if (ev.key === 'ArrowLeft') {
          prevStackCard();
          return;
        }
        if (ev.key === 'ArrowRight') {
          nextStackCard('right');
          return;
        }
        if (ev.key === ' ' || ev.key === 'Enter' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          executeStackAction(state.settings.mode);
          return;
        }
        if (ev.key === 'z' || ev.key === 'Z') {
          ev.preventDefault();
          undoRun({ undoType: 'single', mode: state.settings.mode });
          return;
        }
      }
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const badge = ev.target && ev.target.closest ? ev.target.closest('.rn-pick') : null;
      if (!badge) return;
      ev.preventDefault();
      badge.click();
    }, true);

    // 用户自主滚动浏览时，自动增量捕获新渲染的卡片并同步至侧边栏
    let scrollTimer = null;
    const onManualScroll = function () {
      if (tabTransitionLock) return;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function () {
        if (tabTransitionLock) return;
        if (syncDomCardsToCandidates()) {
          refreshPageCards();
          broadcastState();
        }
      }, 150);
    };
    window.addEventListener('scroll', onManualScroll, { capture: true, passive: true });
    window.addEventListener('wheel', onManualScroll, { capture: true, passive: true });

    // 监听 DOM 树变化（无限滚动异步插入卡片）
    try {
      let mutTimer = null;
      const observer = new MutationObserver(function (mutations) {
        if (tabTransitionLock) return;
        let hasNewNodes = false;
        for (let i = 0; i < mutations.length; i++) {
          if (mutations[i].addedNodes && mutations[i].addedNodes.length > 0) {
            hasNewNodes = true;
            break;
          }
        }
        if (hasNewNodes) {
          clearTimeout(mutTimer);
          mutTimer = setTimeout(function () {
            if (tabTransitionLock) return;
            if (syncDomCardsToCandidates()) {
              refreshPageCards();
              broadcastState();
            }
          }, 150);
        }
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* 忽略 */ }

    // 监听小红书页面主标签点击：根据被点击的 Tab 立即同步模式，切换对应独立缓存并安全过渡
    window.addEventListener('click', function (ev) {
      const tab = ev.target && ev.target.closest && ev.target.closest('.reds-tab-item, [role="tab"], .tab-link, [class*="tab-item"]');
      if (tab) {
        const detected = detectTabFromText(tab.textContent);
        if (detected) {
          if (detected !== currentScannedTabType) {
            beginTabTransition(detected);
          }

          if (detected === 'like') {
            state.settings.mode = 'unlike';
            saveSettings();
          } else if (detected === 'collect') {
            state.settings.mode = 'uncollect';
            saveSettings();
          }

          // 切换到目标模式的独立缓存指针并刷新界面
          syncActiveModePointers();
          state.anchorId = null;
          clearPageCards();
          broadcastState();

          // 等待新 Tab 的卡片 DOM 渲染就绪并安全合入对应缓存
          var clickGen = tabSwitchGeneration;
          waitForCards(3000, detected).then(function (success) {
            if (tabSwitchGeneration !== clickGen || !success) return; // 已过时或新卡片未到，放弃
            if (syncDomCardsToCandidates()) broadcastState();
            refreshPageCards();
          });
        }
      }
    }, true);
  }

  /* ============================ 页面浮动条反馈 ============================ */

  let toastTimer = null;

  function showToast(text, durationMs) {
    if (!state.els || !state.els.toast) return;
    const t = state.els.toast;
    t.textContent = text;
    t.classList.add('rn-show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove('rn-show');
    }, durationMs || 1200);
  }

  function updateSelectionFeedback(feedback) {
    const selCount = state.selected.size;

    if (state.els && state.els.count) {
      state.els.count.textContent = String(selCount);
      state.els.count.classList.remove('rn-bump');
      void state.els.count.offsetWidth; // 触发 reflow 产生弹性跳动动画
      state.els.count.classList.add('rn-bump');
      setTimeout(function () {
        if (state.els && state.els.count) state.els.count.classList.remove('rn-bump');
      }, 200);
    }

    if (state.els && state.els.wrap) {
      state.els.wrap.classList.toggle('rn-hidden', selCount === 0);
    }

    if (feedback && feedback.text) {
      showToast(feedback.text);
    }

    setBadge(selCount > 0 ? String(selCount) : '');
  }

  function setBadge(text) {
    try {
      quietly(chrome.runtime.sendMessage({ type: 'RN_BADGE', text: text || '', color: '#FF2E4D' }));
    } catch (e) { /* SW 可能已休眠，忽略 */ }
  }

  /* ============================ 叠卡速览模式引擎 ============================ */

  const stackState = {
    open: false,
    list: [],
    index: 0,
    autoAdvance: true,
    randomMode: false,
    history: [],
    working: false,
    els: null,
    filter: {
      keyword: '',
      tag: 'all',
      explicitIds: null,
    },
    sessionProcessed: 0,
  };

  try {
    const savedAuto = localStorage.getItem('rn:stack_auto_advance');
    if (savedAuto !== null) stackState.autoAdvance = savedAuto === 'true';
    const savedRandom = localStorage.getItem('rn:stack_random_mode');
    if (savedRandom !== null) stackState.randomMode = savedRandom === 'true';
  } catch (e) {}

  /**
   * 计算当前叠卡卡组的数据源（严格与右侧侧边栏展示的数据源对齐）
   */
  function getStackFilteredList() {
    const curMode = state.settings.mode;
    // 1. 如果有侧边栏精准同步过来的当前可见 ID 列表，优先严格对齐并保持顺序（排除已处理笔记）
    if (Array.isArray(stackState.filter.explicitIds)) {
      const candMap = new Map();
      state.candidates.forEach(function (n) { candMap.set(n.id, n); });
      return stackState.filter.explicitIds.map(function (id) {
        return candMap.get(id);
      }).filter(Boolean).filter(function (n) {
        return !isProcessed(curMode, n.id);
      });
    }

    // 2. 否则按关键词 + Tag 联合过滤当前模式的 candidates（排除已处理笔记）
    let list = state.candidates.slice();
    const kw = (stackState.filter.keyword || state.settings.keyword || '').trim();
    if (kw) {
      const terms = C.parseKeywords(kw);
      list = list.filter(function (n) { return C.matchKeywords(n, terms); });
    }
    const tag = stackState.filter.tag;
    if (tag && tag !== 'all') {
      list = list.filter(function (n) {
        const info = state.aiTags && state.aiTags[n.id];
        if (!info) return false;
        return info.decision === tag || info.category === tag;
      });
    }
    return list.filter(function (n) {
      return !isProcessed(curMode, n.id);
    });
  }

  function openStackView(opts) {
    if (!state.mounted) mount();

    // 1. 核心安全校验：若停留在「我的笔记/发布」页面，坚决拦截并引导切换 Tab
    const curTab = activeTabEl();
    if (curTab && isOwnNotesTab(curTab)) {
      const targetLabel = C.MODES[state.settings.mode].tabLabel;
      try { ensureTab(targetLabel); } catch (e) {}
      const msg = '当前在「我的笔记」页面（自己发布的原创笔记不可操作），请先在小红书页面切换至「' + targetLabel + '」列表';
      log(msg, 'warn');
      showToast(msg);
      return { ok: false, count: 0, reason: msg };
    }

    // 2. 清洗可能残留的原创笔记
    state.candidates = state.candidates.filter(function (n) { return !isOwnNote(n); });

    // 3. 在合规的「收藏」或「赞过」Tab 增量同步页面卡片（由 syncDomCardsToCandidates 保证严格按实际 Tab 归仓，绝不强行串仓兜底）
    syncDomCardsToCandidates();

    // 5. 更新过滤规则（与右侧侧边栏传入的搜索、tag与ids完全同步）
    if (opts) {
      if (typeof opts.keyword === 'string') {
        stackState.filter.keyword = opts.keyword.trim();
        state.settings.keyword = stackState.filter.keyword;
      }
      if (typeof opts.tag === 'string') {
        stackState.filter.tag = opts.tag;
      }
      if (Array.isArray(opts.ids)) {
        stackState.filter.explicitIds = opts.ids.slice();
      } else if (opts.ids === null) {
        stackState.filter.explicitIds = null;
      }
    }

    const list = getStackFilteredList();

    if (!list.length) {
      const emptyMsg = (stackState.filter.tag && stackState.filter.tag !== 'all')
        ? '未找到匹配标签「' + stackState.filter.tag + '」的笔记'
        : (stackState.filter.keyword
            ? '未找到匹配「' + stackState.filter.keyword + '」的笔记'
            : '当前模式下暂无已缓存笔记，请滚动小红书页面加载');
      log(emptyMsg, 'warn');
      showToast(emptyMsg);
      return { ok: false, count: 0, reason: emptyMsg };
    }

    stackState.list = list;
    stackState.history = [];
    stackState.open = true;
    stackState.working = false;
    stackState.sessionProcessed = 0;

    if (stackState.randomMode && list.length > 1) {
      stackState.index = Math.floor(Math.random() * list.length);
    } else {
      stackState.index = 0;
    }

    // 展开宿主容器至全视口，保证模态框与阴影遮罩可完整呈现并捕获交互
    if (state.els && state.els.host) {
      state.els.host.style.width = '100vw';
      state.els.host.style.height = '100vh';
      state.els.host.style.pointerEvents = 'auto';
    }

    try {
      chrome.storage.local.get([KEY_AI_TAGS], function (res) {
        if (res && res[KEY_AI_TAGS]) {
          state.aiTags = res[KEY_AI_TAGS];
          if (stackState.open) renderStackCard();
        }
      });
    } catch (e) {}

    if (stackState.els && stackState.els.overlay) {
      stackState.els.overlay.classList.add('rn-open');
    }
    renderStackCard();
    return { ok: true, count: list.length };
  }

  function closeStackView() {
    const processed = stackState.sessionProcessed || 0;
    stackState.open = false;
    stackState.working = false;
    stackState.sessionProcessed = 0;
    if (stackState.els && stackState.els.overlay) {
      stackState.els.overlay.classList.remove('rn-open');
    }
    // 恢复宿主容器为零尺寸，彻底避免阻挡页面底层交互
    if (state.els && state.els.host) {
      state.els.host.style.width = '0';
      state.els.host.style.height = '0';
      state.els.host.style.pointerEvents = 'none';
    }
    refreshPageCards();
    if (processed >= 3) {
      log('🎉 叠卡清理完成（共 ' + processed + ' 篇）！若帮到了你，欢迎请作者喝杯咖啡 ☕', 'ok', {
        isSponsor: true,
      });
    }
  }

  function syncStackListToFilter(filterPatch) {
    if (!stackState.open) return;

    if (filterPatch) {
      if (typeof filterPatch.keyword === 'string') {
        stackState.filter.keyword = filterPatch.keyword.trim();
        state.settings.keyword = stackState.filter.keyword;
      }
      if (typeof filterPatch.tag === 'string') {
        stackState.filter.tag = filterPatch.tag;
      }
      if (Array.isArray(filterPatch.ids)) {
        stackState.filter.explicitIds = filterPatch.ids.slice();
      } else if (filterPatch.ids === null) {
        stackState.filter.explicitIds = null;
      }
    }

    const currentNote = stackState.list[stackState.index];
    const filtered = getStackFilteredList();
    stackState.list = filtered;

    if (filtered.length === 0) {
      stackState.index = 0;
      renderStackCard();
      return;
    }

    // 若当前正在查看的卡片依然在筛选列表中，保持在此卡片
    let targetIdx = 0;
    if (currentNote && currentNote.id) {
      for (let i = 0; i < filtered.length; i++) {
        if (filtered[i].id === currentNote.id) { targetIdx = i; break; }
      }
    }
    stackState.index = targetIdx;
    renderStackCard();
  }

  const SVG_HEART_FILLED = '<svg viewBox="0 0 24 24" width="22" height="22" fill="#ff2442"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
  const SVG_HEART_OUTLINE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/></svg>';
  const SVG_STAR_FILLED = '<svg viewBox="0 0 24 24" width="22" height="22" fill="#ffb800"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
  const SVG_STAR_OUTLINE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/></svg>';

  function getNoteStatus(note, targetMode) {
    if (!note || !note.id) return { active: false, processed: true, liked: false, collected: false };

    const mode = targetMode || (state && state.settings && state.settings.mode) || 'uncollect';
    const isProc = isProcessed(mode, note.id);

    if (mode === 'unlike') {
      let active;
      if (typeof note._liked === 'boolean') {
        active = note._liked;
      } else {
        active = !isProc;
      }
      return {
        mode: 'unlike',
        active: active,
        processed: isProc || !active,
        liked: active,
        collected: false,
      };
    } else {
      let active;
      if (typeof note._collected === 'boolean') {
        active = note._collected;
      } else {
        active = !isProc;
      }
      return {
        mode: 'uncollect',
        active: active,
        processed: isProc || !active,
        collected: active,
        liked: false,
      };
    }
  }

  function renderStackCard() {
    if (!stackState.els) return;
    const total = stackState.list.length;

    // 当筛选结果为空时的提示卡片，保持叠卡不崩溃并明确指示原因
    if (total === 0) {
      stackState.els.counter.textContent = '第 0 / 0 篇';
      stackState.els.img.removeAttribute('src');
      stackState.els.img.style.display = 'none';
      stackState.els.empty.textContent = '🎉';
      stackState.els.empty.style.display = 'block';
      stackState.els.status.textContent = '已无待处理笔记';
      stackState.els.status.classList.remove('rn-pill-done');
      if (stackState.els.btnOpen) stackState.els.btnOpen.style.display = 'none';

      let hintReason = '';
      if (stackState.filter && stackState.filter.tag && stackState.filter.tag !== 'all') {
        hintReason = '标签「' + stackState.filter.tag + '」';
      }
      if (stackState.filter && stackState.filter.keyword) {
        hintReason += (hintReason ? ' + ' : '') + '搜索「' + stackState.filter.keyword + '」';
      }

      if (stackState.sessionProcessed > 0) {
        stackState.els.title.textContent = '🎉 连续清理完成！已处理 ' + stackState.sessionProcessed + ' 篇笔记';
        stackState.els.author.textContent = '若帮到了你，欢迎请作者喝杯咖啡 ☕';
      } else {
        stackState.els.title.textContent = hintReason
          ? '当前' + hintReason + '下笔记已全部处理完成'
          : '当前模式下已无待处理笔记';
        stackState.els.author.textContent = '可在右侧侧边栏切换 Tab、Tag 标签或修改搜索词';
      }
      stackState.els.id.textContent = '';
      stackState.els.btnPrev.disabled = true;
      stackState.els.btnNext.disabled = true;
      const actionBtn = stackState.els.btnAction || stackState.els.btnCollect || stackState.els.btnLike;
      if (actionBtn) actionBtn.disabled = true;
      if (stackState.els.layer1) stackState.els.layer1.style.display = 'none';
      if (stackState.els.layer2) stackState.els.layer2.style.display = 'none';

      if (stackState.els.btnUndo) {
        const lastStackUndo = C.findUndoTarget(state.history, state.settings.mode);
        const canUndo = !!(lastStackUndo && lastStackUndo.type === 'single' && !state.running);
        stackState.els.btnUndo.disabled = !canUndo;
        if (canUndo && lastStackUndo.title) {
          stackState.els.btnUndo.title = '撤销刚才处理的笔记：「' + lastStackUndo.title + '」';
        } else {
          stackState.els.btnUndo.title = '当前无刚划走/处理的单篇笔记可撤销';
        }
      }
      return;
    }

    if (stackState.index < 0) stackState.index = 0;
    if (stackState.index >= total) stackState.index = total - 1;

    const idx = stackState.index;
    const note = stackState.list[idx];

    // 更新序号指示（带上当前筛选的 Tag 或搜索词）
    let filterHint = '';
    if (stackState.filter && stackState.filter.tag && stackState.filter.tag !== 'all') {
      filterHint = ' · ' + stackState.filter.tag;
    } else if (stackState.filter && stackState.filter.keyword) {
      filterHint = ' · "' + stackState.filter.keyword + '"';
    }

    if (stackState.randomMode) {
      stackState.els.counter.textContent = '🎲 随机 · 第 ' + (idx + 1) + ' / ' + total + ' 篇' + filterHint;
    } else {
      stackState.els.counter.textContent = '第 ' + (idx + 1) + ' / ' + total + ' 篇' + filterHint;
    }

    // 更新大图封面
    if (note.cover) {
      stackState.els.img.src = note.cover;
      stackState.els.img.style.display = 'block';
      stackState.els.empty.style.display = 'none';
    } else {
      stackState.els.img.removeAttribute('src');
      stackState.els.img.style.display = 'none';
      stackState.els.empty.textContent = '🎴';
      stackState.els.empty.style.display = 'block';
    }

    // 更新查看原文链接按钮（必须附带安全令牌 xsec_token 才能在新标签页直接查看原文并绕过扫码拦截）
    const token = note.xsecToken || (state.xsecTokens && state.xsecTokens[note.id]) || '';
    const noteUrl = C.buildNoteUrl(note.url || note.id, token);
    if (stackState.els.btnOpen) {
      if (noteUrl) {
        stackState.els.btnOpen.href = noteUrl;
        stackState.els.btnOpen.style.display = 'inline-flex';
      } else {
        stackState.els.btnOpen.style.display = 'none';
      }
    }

    // 更新文本信息
    stackState.els.title.textContent = note.title || '未命名笔记';
    if (noteUrl) {
      stackState.els.title.title = '点击可在新标签页查看笔记原文（' + noteUrl + '）';
    } else {
      stackState.els.title.removeAttribute('title');
    }
    stackState.els.author.textContent = note.author ? ('@' + note.author) : '';
    const aiTag = state.aiTags && state.aiTags[note.id];
    if (aiTag) {
      const decMap = {
        '时效过期': '⚠️ 时效过期',
        '营销广告': '📢 营销推广',
        '干货保值': '💡 干货保值',
        '普通浏览': '☕ 普通浏览',
      };
      const decText = decMap[aiTag.decision] || aiTag.decision || '';
      const catText = aiTag.category ? ('[' + aiTag.category + '] ') : '';
      const reasonText = aiTag.reason ? (' · ' + aiTag.reason) : '';
      stackState.els.id.textContent = catText + decText + reasonText;
    } else {
      stackState.els.id.textContent = note.id ? ('ID: ' + note.id) : '';
    }

    // 状态判定与单模式专属展示
    const curMode = state.settings.mode;
    const st = getNoteStatus(note, curMode);

    if (curMode === 'unlike') {
      if (st.processed || !st.active) {
        stackState.els.status.textContent = '已取消点赞';
        stackState.els.status.classList.add('rn-pill-done');
      } else {
        stackState.els.status.textContent = '已点赞 ❤️';
        stackState.els.status.classList.remove('rn-pill-done');
      }
    } else {
      if (st.processed || !st.active) {
        stackState.els.status.textContent = '已取消收藏';
        stackState.els.status.classList.add('rn-pill-done');
      } else {
        stackState.els.status.textContent = '已收藏 ⭐';
        stackState.els.status.classList.remove('rn-pill-done');
      }
    }

    // 更新导航按钮状态
    if (stackState.randomMode) {
      stackState.els.btnPrev.disabled = (!stackState.history || stackState.history.length === 0) && idx <= 0;
      stackState.els.btnNext.disabled = total <= 1;
      stackState.els.btnNext.innerHTML = '随机下一个 <span>🎲</span>';
      stackState.els.btnNext.title = '随机下一张 (快捷键: →)';
    } else {
      stackState.els.btnPrev.disabled = idx <= 0;
      stackState.els.btnNext.disabled = idx >= total - 1;
      stackState.els.btnNext.innerHTML = '下一个 <span>➡</span>';
      stackState.els.btnNext.title = '下一张 (快捷键: →)';
    }

    // 更新单动作专属操作按钮（取消点赞 / 取消收藏），明确在按钮上直观展示快捷键 Space
    const actionBtn = stackState.els.btnAction || stackState.els.btnCollect || stackState.els.btnLike;
    if (actionBtn) {
      actionBtn.disabled = stackState.working || st.processed || !st.active;
      if (curMode === 'unlike') {
        actionBtn.className = 'rn-stack-action-btn rn-btn-unlike';
        if (st.processed || !st.active) {
          actionBtn.innerHTML = SVG_HEART_OUTLINE + '<span>已取消点赞</span>';
          actionBtn.title = '该笔记已取消点赞';
        } else {
          actionBtn.innerHTML = SVG_HEART_FILLED + '<span>取消点赞</span><kbd class="rn-stack-kbd">Space</kbd>';
          actionBtn.title = '取消点赞 (快捷键: 空格 Space / 回车 Enter / 方向键下 ↓)';
        }
      } else {
        actionBtn.className = 'rn-stack-action-btn rn-btn-uncollect';
        if (st.processed || !st.active) {
          actionBtn.innerHTML = SVG_STAR_OUTLINE + '<span>已取消收藏</span>';
          actionBtn.title = '该笔记已取消收藏';
        } else {
          actionBtn.innerHTML = SVG_STAR_FILLED + '<span>取消收藏</span><kbd class="rn-stack-kbd">Space</kbd>';
          actionBtn.title = '取消收藏 (快捷键: 空格 Space / 回车 Enter / 方向键下 ↓)';
        }
      }
    }

    // 更新叠卡顶部撤销按钮状态（仅在有刚才取消的单篇笔记时高亮激活）
    if (stackState.els.btnUndo) {
      const lastStackUndo = C.findUndoTarget(state.history, state.settings.mode);
      const canUndo = !!(lastStackUndo && lastStackUndo.type === 'single' && !state.running);
      stackState.els.btnUndo.disabled = !canUndo;
      if (canUndo && lastStackUndo.title) {
        stackState.els.btnUndo.title = '撤销刚才处理的笔记：「' + lastStackUndo.title + '」';
      } else {
        stackState.els.btnUndo.title = '当前无刚划走/处理的单篇笔记可撤销';
      }
    }

    // 参差错落下层卡片视觉呈现
    const nextIdx1 = stackState.randomMode ? (idx + 1) % total : idx + 1;
    const nextIdx2 = stackState.randomMode ? (idx + 2) % total : idx + 2;

    if (stackState.els.layer1) {
      if (total >= 2 && stackState.list[nextIdx1] && nextIdx1 !== idx) {
        const next1 = stackState.list[nextIdx1];
        stackState.els.layer1.style.display = 'block';
        if (next1.cover) {
          stackState.els.layer1.style.backgroundImage = 'linear-gradient(rgba(26,26,36,0.65), rgba(26,26,36,0.88)), url(' + next1.cover + ')';
        } else {
          stackState.els.layer1.style.backgroundImage = 'none';
        }
      } else {
        stackState.els.layer1.style.display = 'none';
      }
    }

    if (stackState.els.layer2) {
      if (total >= 3 && stackState.list[nextIdx2] && nextIdx2 !== idx) {
        const next2 = stackState.list[nextIdx2];
        stackState.els.layer2.style.display = 'block';
        if (next2.cover) {
          stackState.els.layer2.style.backgroundImage = 'linear-gradient(rgba(20,20,28,0.7), rgba(20,20,28,0.92)), url(' + next2.cover + ')';
        } else {
          stackState.els.layer2.style.backgroundImage = 'none';
        }
      } else {
        stackState.els.layer2.style.display = 'none';
      }
    }
  }

  function nextStackCard(direction) {
    if (stackState.animating) return;
    const total = stackState.list.length;
    if (total <= 1) {
      showToast('当前只有 1 篇笔记');
      return;
    }
    if (!stackState.randomMode && stackState.index >= total - 1) {
      showToast('已是最后一张笔记');
      return;
    }

    stackState.animating = true;
    const cardMain = stackState.els.cardMain;
    const deck = stackState.els.deck || cardMain.parentElement;

    // 1. 克隆当前卡片作为飞离幽灵层，保证上一张卡片自然向左飞走
    const ghost = cardMain.cloneNode(true);
    ghost.removeAttribute('id');
    const childIds = ghost.querySelectorAll('[id]');
    for (let i = 0; i < childIds.length; i++) childIds[i].removeAttribute('id');
    ghost.classList.add('rn-card-ghost');
    deck.appendChild(ghost);

    // 记录历史供 prevStackCard 回溯（以 note.id 记录，避免删除卡片后索引偏移）
    if (!stackState.history) stackState.history = [];
    const currentNote = stackState.list[stackState.index];
    if (currentNote && currentNote.id) {
      stackState.history.push(currentNote.id);
      if (stackState.history.length > 100) stackState.history.shift();
    }

    // 2. 计算下一张索引
    if (stackState.randomMode) {
      let rand;
      do {
        rand = Math.floor(Math.random() * total);
      } while (rand === stackState.index && total > 1);
      stackState.index = rand;
    } else {
      stackState.index++;
    }
    renderStackCard();

    // 3. 让克隆的旧卡片朝左侧平滑甩出并渐隐
    void ghost.offsetWidth; // 触发 reflow 确保起始帧就绪
    ghost.classList.add('rn-ghost-fly-out');

    setTimeout(function () {
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      stackState.animating = false;
    }, 280);
  }

  function prevStackCard() {
    if (stackState.animating) return;
    const total = stackState.list.length;
    if (total === 0) return;

    let targetIdx = -1;
    while (stackState.history && stackState.history.length > 0) {
      const prevId = stackState.history.pop();
      const found = stackState.list.findIndex(function (n) { return n.id === prevId; });
      if (found !== -1 && found !== stackState.index) {
        targetIdx = found;
        break;
      }
    }
    if (targetIdx === -1 && stackState.index > 0) {
      targetIdx = stackState.index - 1;
    }

    if (targetIdx === -1 || targetIdx === stackState.index) {
      showToast('已是第一张笔记');
      return;
    }

    stackState.animating = true;
    const cardMain = stackState.els.cardMain;

    // 1. 将主卡片先无过渡定位在左侧屏幕外
    cardMain.classList.remove('rn-enter-active');
    cardMain.classList.add('rn-entering-from-left');

    // 2. 渲染上一篇卡片的内容
    stackState.index = targetIdx;
    renderStackCard();

    // 3. 强制重绘，锁定左侧起始帧
    void cardMain.offsetWidth;

    // 4. 下一帧加上过渡类，从左侧平滑滑入中央归位
    requestAnimationFrame(function () {
      cardMain.classList.remove('rn-entering-from-left');
      cardMain.classList.add('rn-enter-active');
    });

    setTimeout(function () {
      cardMain.classList.remove('rn-enter-active');
      stackState.animating = false;
    }, 320);
  }

  /** 处理叠卡中笔记已被取消/处理后的平滑飞离与列表剔除 */
  function handleCardProcessedFlyOut(processedNoteId) {
    if (!stackState.open) return;
    const cardMain = stackState.els && stackState.els.cardMain;
    const deck = stackState.els && (stackState.els.deck || (cardMain && cardMain.parentElement));

    // 幽灵卡片平滑向左甩出动画
    if (cardMain && deck) {
      const ghost = cardMain.cloneNode(true);
      ghost.removeAttribute('id');
      const childIds = ghost.querySelectorAll('[id]');
      for (let i = 0; i < childIds.length; i++) childIds[i].removeAttribute('id');
      ghost.classList.add('rn-card-ghost');
      deck.appendChild(ghost);
      void ghost.offsetWidth;
      ghost.classList.add('rn-ghost-fly-out');
      setTimeout(function () {
        if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      }, 280);
    }

    // 从叠卡列表彻底剔除已处理的笔记，确保不论在列表还是叠卡都不再出现
    stackState.list = stackState.list.filter(function (n) { return n.id !== processedNoteId; });

    // 从历史记录中剔除已处理笔记，确保「上一个」绝不回溯到已处理的笔记
    if (stackState.history) {
      stackState.history = stackState.history.filter(function (histId) { return histId !== processedNoteId; });
    }

    const newTotal = stackState.list.length;
    if (newTotal === 0) {
      stackState.index = 0;
    } else if (stackState.randomMode) {
      stackState.index = Math.floor(Math.random() * newTotal);
    } else if (stackState.index >= newTotal) {
      stackState.index = newTotal - 1;
    }

    renderStackCard();
  }

  async function toggleStackAction(type) {
    if (stackState.working) return;
    const note = stackState.list[stackState.index];
    if (!note || !note.id) return;

    const actionType = (type === 'unlike' || type === 'like') ? 'like' : 'collect';
    const curMode = (actionType === 'like') ? 'unlike' : 'uncollect';
    const st = getNoteStatus(note, curMode);

    if (actionType === 'like') {
      const willUnlike = st.active;
      const mode = 'unlike';
      const phase = willUnlike ? 'do' : 'undo';

      stackState.working = true;
      renderStackCard();

      try {
        const res = await callWrite(mode, phase, note.id);
        if (C.isRiskResponse(res.payload, res.status)) {
          log('⛔ 命中风控，请暂停操作：' + C.describeError(res.payload, res.status), 'err');
          showToast('命中风控提示，请稍候再试');
          return;
        }

        if (C.isSuccess(res.payload)) {
          if (willUnlike) {
            note._liked = false;
            markProcessed('unlike', note.id);
            removeCandidate('unlike', note.id);
            state.selected.delete(note.id);
            const singleId = 'single_' + nowMs() + '_' + note.id;
            const histItem = {
              id: note.id,
              title: note.title || '',
              mode: 'unlike',
              ts: nowMs(),
              type: 'single',
              batchId: singleId,
              source: 'stack',
              note: {
                id: note.id,
                title: note.title,
                author: note.author,
                cover: note.cover,
                url: note.url,
                xsecToken: note.xsecToken,
                _liked: false,
                _collected: note._collected,
              },
            };
            pushHistory(histItem);
            log('[叠卡] 已取消点赞：' + titleOf(note), 'ok', {
              canUndo: true,
              undoType: 'single',
              noteId: note.id,
              batchId: singleId,
              title: titleOf(note),
              mode: 'unlike',
            });
            stackState.sessionProcessed = (stackState.sessionProcessed || 0) + 1;
            if (stackState.sessionProcessed % 10 === 0) {
              showToast('🎉 已连续清理 ' + stackState.sessionProcessed + ' 篇！');
            } else {
              showToast('已取消点赞');
            }

            // 核心：处理过的笔记在叠卡与列表中剔除
            if (stackState.autoAdvance) {
              handleCardProcessedFlyOut(note.id);
            } else {
              renderStackCard();
            }
          } else {
            note._liked = true;
            unmarkProcessed('unlike', note.id);
            stackState.sessionProcessed = Math.max(0, (stackState.sessionProcessed || 0) - 1);
            log('已重新点赞：' + titleOf(note), 'ok');
            showToast('已点赞 ❤️');
          }
          broadcastState();
          updateSelectionFeedback();
          refreshPageCards();
        } else {
          const errText = C.describeError(res.payload, res.status);
          log('操作失败：' + errText, 'err');
          showToast('失败：' + errText);
        }
      } catch (e) {
        log('操作出错：' + ((e && e.message) || e), 'err');
        showToast('操作出错');
      } finally {
        stackState.working = false;
        renderStackCard();
      }
    } else if (actionType === 'collect') {
      const willUncollect = st.active;
      const mode = 'uncollect';
      const phase = willUncollect ? 'do' : 'undo';

      stackState.working = true;
      renderStackCard();

      try {
        const res = await callWrite(mode, phase, note.id);
        if (C.isRiskResponse(res.payload, res.status)) {
          log('⛔ 命中风控，请暂停操作：' + C.describeError(res.payload, res.status), 'err');
          showToast('命中风控提示，请稍候再试');
          return;
        }

        if (C.isSuccess(res.payload)) {
          if (willUncollect) {
            note._collected = false;
            markProcessed('uncollect', note.id);
            removeCandidate('uncollect', note.id);
            state.selected.delete(note.id);
            const singleId = 'single_' + nowMs() + '_' + note.id;
            const histItem = {
              id: note.id,
              title: note.title || '',
              mode: 'uncollect',
              ts: nowMs(),
              type: 'single',
              batchId: singleId,
              source: 'stack',
              note: {
                id: note.id,
                title: note.title,
                author: note.author,
                cover: note.cover,
                url: note.url,
                xsecToken: note.xsecToken,
                _liked: note._liked,
                _collected: false,
              },
            };
            pushHistory(histItem);
            log('[叠卡] 已取消收藏：' + titleOf(note), 'ok', {
              canUndo: true,
              undoType: 'single',
              noteId: note.id,
              batchId: singleId,
              title: titleOf(note),
              mode: 'uncollect',
            });
            stackState.sessionProcessed = (stackState.sessionProcessed || 0) + 1;
            if (stackState.sessionProcessed % 10 === 0) {
              showToast('🎉 已连续清理 ' + stackState.sessionProcessed + ' 篇！');
            } else {
              showToast('已取消收藏');
            }

            // 核心：处理过的笔记在叠卡与列表中剔除
            if (stackState.autoAdvance) {
              handleCardProcessedFlyOut(note.id);
            } else {
              renderStackCard();
            }
          } else {
            note._collected = true;
            unmarkProcessed('uncollect', note.id);
            stackState.sessionProcessed = Math.max(0, (stackState.sessionProcessed || 0) - 1);
            log('已重新收藏：' + titleOf(note), 'ok');
            showToast('已收藏 ⭐');
          }
          broadcastState();
          updateSelectionFeedback();
          refreshPageCards();
        } else {
          const errText = C.describeError(res.payload, res.status);
          log('操作失败：' + errText, 'err');
          showToast('失败：' + errText);
        }
      } catch (e) {
        log('操作出错：' + ((e && e.message) || e), 'err');
        showToast('操作出错');
      } finally {
        stackState.working = false;
        renderStackCard();
      }
    }
  }

  function executeStackAction(mode) {
    const curMode = mode || state.settings.mode;
    return toggleStackAction(curMode === 'unlike' ? 'like' : 'collect');
  }

  /* ============================ 运行引擎 ============================ */

  async function startRun() {
    if (state.running) return;
    if (!state.mounted) mount();

    const s = state.settings;
    const M = C.MODES[s.mode];

    try {
      await assertOwnProfile();
      await ensureTab(M.tabLabel);

      let scannedNow = false;
      if (!state.candidates.length) {
        log('正在读取「' + M.tabLabel + '」列表…');
        await waitForCards(6000, s.mode === 'unlike' ? 'like' : 'collect');
        state.candidates = await collectCandidates();
        if (!state.candidates.length) {
          log('没读到笔记卡片：如果当前停在「专辑」子页，请切到「笔记」子页再试', 'err');
          return;
        }
        log('读到 ' + state.candidates.length + ' 篇笔记', 'ok');
        refreshPageCards();
        scannedNow = true;
      }

      const queue = selectedTargets();
      if (!queue.length) {
        const tip = scannedNow
          ? '已读到 ' + state.candidates.length + ' 篇，但还没有勾选：在页面上逐条勾选（或侧边栏点「全选命中」）后再开始'
          : '还没有勾选要处理的笔记：直接在小红书页面点卡片勾选，或在侧边栏点「全选命中」';
        log(tip, 'warn');
        showToast('请先勾选笔记，再点开始');
        return;
      }

      const planned = Math.min(queue.length, s.maxPerRun);
      const lines = [
        '即将执行：' + M.verb,
        '',
        '已勾选 ' + queue.length + ' 篇，本次最多执行 ' + planned + ' 篇',
        '请求间隔 ' + s.minDelay + '–' + s.maxDelay + ' ms',
      ];
      const preview = queue.slice(0, 3).map(function (n) { return '· ' + titleOf(n); });
      if (preview.length) lines.push('', '前几条：', preview.join('\n'));
      if (s.cooldownEvery > 0) {
        lines.push('每 ' + s.cooldownEvery + ' 篇冷却 ' + Math.round(s.cooldownMs / 1000) + ' 秒');
      }
      lines.push('', '确定开始？');
      if (!window.confirm(lines.join('\n'))) {
        log('已取消本次运行', 'warn');
        return;
      }

      state.running = true;
      state.stopRequested = false;
      state.stats = { ok: 0, fail: 0, risk: false, startedAt: nowMs(), total: planned };
      const currentBatchId = 'batch_' + nowMs() + '_' + Math.random().toString(36).slice(2, 7);
      broadcastState();

      let streak = 0;
      for (let i = 0; i < queue.length; i++) {
        if (state.stopRequested) { log('已手动停止', 'warn'); break; }
        const done = state.stats.ok + state.stats.fail;
        if (done >= s.maxPerRun) {
          log('已达单次上限 ' + s.maxPerRun + ' 篇，停止（避免风控）', 'warn');
          break;
        }

        const note = queue[i];
        if (isProcessed(s.mode, note.id)) continue;

        if (C.shouldCooldown(done, s.cooldownEvery)) {
          log('批次冷却 ' + Math.round(s.cooldownMs / 1000) + ' 秒…', 'warn');
          if (!(await interruptibleSleep(s.cooldownMs))) { log('冷却中被停止', 'warn'); break; }
        }

        if (!(await interruptibleSleep(C.delayBetween(s.minDelay, s.maxDelay)))) {
          log('已被停止', 'warn');
          break;
        }

        state.stats.index = i;
        broadcastState();

        try {
          const res = await callWrite(s.mode, 'do', note.id);

          if (C.isRiskResponse(res.payload, res.status)) {
            state.stats.risk = true;
            log('⛔ 命中风控，已立即停止：' + C.describeError(res.payload, res.status), 'err');
            log('建议：至少等 30 分钟，把间隔调到 3000–6000ms、单次降到 10–20 篇再试', 'warn');
            break;
          }

          if (C.isSuccess(res.payload)) {
            streak = 0;
            state.stats.ok++;
            markProcessed(s.mode, note.id);
            removeCandidate(s.mode, note.id);
            state.selected.delete(note.id);
            pushHistory({
              id: note.id,
              title: note.title || '',
              mode: s.mode,
              ts: nowMs(),
              type: 'batch',
              batchId: currentBatchId,
              source: 'batch',
              note: {
                id: note.id,
                title: note.title,
                author: note.author,
                cover: note.cover,
                url: note.url,
                xsecToken: note.xsecToken,
              },
            });
            log('[' + (done + 1) + '/' + planned + '] 已' + M.verb + '：' + titleOf(note), 'ok', {
              noteId: note.id,
              batchId: currentBatchId,
              mode: s.mode,
              type: 'batch',
            });
          } else {
            streak++;
            state.stats.fail++;
            log('[' + (done + 1) + '/' + planned + '] 失败：' + titleOf(note) + ' — ' + C.describeError(res.payload, res.status), 'err');
            if (streak >= 5) {
              log('连续失败 5 次，先停下排查（可能是接口字段或登录态变了，点「诊断」看看）', 'err');
              break;
            }
          }
        } catch (e) {
          streak++;
          state.stats.fail++;
          log('[' + (done + 1) + '/' + planned + '] 出错：' + titleOf(note) + ' — ' + ((e && e.message) || e), 'err');
          if (streak >= 5) {
            log('连续出错 5 次，已停止', 'err');
            break;
          }
        }

        broadcastState();
        updateSelectionFeedback();
        refreshPageCards();
      }
    } catch (e) {
      log('中断：' + ((e && e.message) || e), 'err');
    } finally {
      const wasRunning = state.running;
      state.running = false;
      state.stopRequested = false;
      updateSelectionFeedback();
      refreshPageCards();
      broadcastState();
      if (wasRunning) {
        log('本次结束：' + C.summarize({
          ok: state.stats.ok,
          fail: state.stats.fail,
          risk: state.stats.risk,
          elapsedMs: nowMs() - state.stats.startedAt,
        }), state.stats.risk ? 'err' : 'ok', {
          canUndo: state.stats.ok > 0,
          undoType: 'batch',
          batchId: currentBatchId,
          count: state.stats.ok,
          mode: s.mode,
        });

        if (state.stats.ok > 0) {
          log('🎉 清理完成（共 ' + state.stats.ok + ' 篇）！若帮到了你，欢迎请作者喝杯咖啡 ☕', 'ok', {
            isSponsor: true,
          });
          showToast('🎉 清理完成！已处理 ' + state.stats.ok + ' 篇笔记');
        }
      }
    }
  }

  async function scanOnly() {
    if (state.running || state.scanning) return;
    if (!state.mounted) mount();
    const M = C.MODES[state.settings.mode];
    const prevCount = state.candidates ? state.candidates.length : 0;
    state.running = true;
    state.scanning = true;
    state.stopRequested = false;
    broadcastState();
    try {
      await assertOwnProfile();
      await ensureTab(M.tabLabel);
      log('开始读取「' + M.tabLabel + '」列表…');
      await waitForCards(6000, state.settings.mode === 'unlike' ? 'like' : 'collect');
      state.candidates = await collectCandidates();
      broadcastState();
      if (!state.candidates.length) {
        log('没读到笔记卡片：确认当前在「收藏/赞过 → 笔记」子页（不是「专辑」），并且列表不是空的', 'err');
        return;
      }
      refreshPageCards();
      const newAdded = Math.max(0, state.candidates.length - prevCount);
      if (prevCount > 0 && newAdded > 0) {
        log('扫描完成：新增识别 ' + newAdded + ' 篇，累计共读到 ' + state.candidates.length + ' 篇。可以直接在页面上点卡片左上角勾选，或在侧边栏中搜索后「全选命中」', 'ok');
      } else {
        log('扫描完成：读到 ' + state.candidates.length + ' 篇。可以直接在页面上点卡片左上角勾选，或在侧边栏中搜索后「全选命中」', 'ok');
      }
      log('💡 提示：若此数量少于您主页总数，属于小红书正常机制：自定义专辑中的笔记需在专辑内查看，且已失效/下架笔记不会在网页中渲染。', 'info');
    } catch (e) {
      log('扫描失败：' + ((e && e.message) || e), 'err');
    } finally {
      state.running = false;
      state.scanning = false;
      state.stopRequested = false;
      broadcastState();
      refreshPageCards();
    }
  }

  async function undoRun(options) {
    if (state.running) return;
    const mode = (options && options.mode) || state.settings.mode;
    const M = C.MODES[mode];
    const target = C.findUndoTarget(state.history, mode, options);
    if (!target || !target.items || !target.items.length) {
      log('当前模式（' + (M ? M.label : mode) + '）没有可撤销的记录', 'warn');
      showToast('没有可撤销的记录');
      return;
    }

    const items = target.items;
    const isSingle = target.type === 'single';

    if (!isSingle) {
      const confirmMsg = '将' + M.undoVerb + '上次批量处理的 ' + items.length + ' 篇笔记，确定？';
      if (!window.confirm(confirmMsg)) return;
    }

    state.running = true;
    state.stopRequested = false;
    state.stats = { ok: 0, fail: 0, risk: false, startedAt: nowMs(), total: items.length };
    broadcastState();

    try {
      for (let i = 0; i < items.length; i++) {
        if (state.stopRequested) break;
        if (i > 0 && !(await interruptibleSleep(C.delayBetween(state.settings.minDelay, state.settings.maxDelay)))) break;

        const h = items[i];
        const itemMode = h.mode || mode;
        const itemM = C.MODES[itemMode] || M;
        try {
          const res = await callWrite(itemMode, 'undo', h.id);
          if (C.isRiskResponse(res.payload, res.status)) {
            state.stats.risk = true;
            log('⛔ 撤销时命中风控，已停止：' + C.describeError(res.payload, res.status), 'err');
            showToast('撤销命中风控，已停止');
            break;
          }
          if (C.isSuccess(res.payload)) {
            state.stats.ok++;
            h.undone = true;
            h.undoneAt = nowMs();
            unmarkProcessed(itemMode, h.id);

            // 更新日志中对应项的撤销状态标记
            state.logs.forEach(function (l) {
              if (l.noteId === h.id || (target.batchId && l.batchId === target.batchId)) {
                l.undone = true;
              }
            });

            // 恢复笔记回候选列表 / 模式独立缓存
            const restoredNote = h.note ? Object.assign({}, h.note) : { id: h.id, title: h.title };
            if (itemMode === 'uncollect') restoredNote._collected = true;
            if (itemMode === 'unlike') restoredNote._liked = true;

            if (state.candidates && !state.candidates.some(function (n) { return n.id === h.id; })) {
              state.candidates.unshift(restoredNote);
            }
            if (state.modeCache && state.modeCache[itemMode] && !state.modeCache[itemMode].some(function (n) { return n.id === h.id; })) {
              state.modeCache[itemMode].unshift(restoredNote);
            }

            // 若叠卡速览浮层处于打开状态，将恢复的笔记插回叠卡列表当前位置并刷新卡片展示
            if (stackState.open) {
              const existingIdx = stackState.list.findIndex(function (n) { return n.id === h.id; });
              if (existingIdx === -1) {
                stackState.list.splice(stackState.index, 0, restoredNote);
              }
              renderStackCard();
            }

            const prefix = isSingle ? ('已撤销单篇（' + itemM.undoVerb + '）') : ('[' + (i + 1) + '/' + items.length + '] 已' + itemM.undoVerb);
            log(prefix + '：' + (h.title || h.id), 'ok');
            if (isSingle) {
              showToast('已恢复' + itemM.tabLabel + '：「' + (h.title || h.id) + '」');
            }
          } else {
            state.stats.fail++;
            const errStr = C.describeError(res.payload, res.status);
            log((isSingle ? '撤销失败' : '[' + (i + 1) + '/' + items.length + '] ' + itemM.undoVerb + '失败') + '：' + (h.title || h.id) + ' — ' + errStr, 'err');
            showToast('撤销失败：' + errStr);
          }
        } catch (e) {
          state.stats.fail++;
          log((isSingle ? '撤销出错' : '[' + (i + 1) + '/' + items.length + '] 出错') + '：' + ((e && e.message) || e), 'err');
        }
        broadcastState();
        await saveHistory();
      }
    } finally {
      state.running = false;
      state.stopRequested = false;
      updateSelectionFeedback();
      refreshPageCards();
      if (stackState.open) renderStackCard();
      broadcastState();
      if (!isSingle) {
        log('批量撤销结束：' + C.summarize({ ok: state.stats.ok, fail: state.stats.fail, risk: state.stats.risk, elapsedMs: nowMs() - state.stats.startedAt }), 'ok');
        showToast('批量撤销结束：成功 ' + state.stats.ok + ' 篇');
      }
      await saveHistory();
    }
  }

  function requestStop() {
    if (!state.running && !state.scanning) return;
    state.stopRequested = true;
    if (state.scanning) {
      log('正在停止扫描列表…', 'warn');
    } else {
      log('正在停止…（当前这条请求会走完）', 'warn');
    }
  }

  async function diagnose() {
    const lines = [];
    const p = await pingBridge();
    lines.push('页面代理：' + (p
      ? '正常，签名函数 ' + (p.signer ? '已就绪' : '缺失（刷新页面）') + '，接口域 ' + p.origin
      : '无响应（脚本可能未注入）'));
    lines.push('当前路径：' + location.pathname + location.search);
    lines.push('页面识别：' + (getPageActualTabType() || '未知'));
    lines.push('卡片节点：section.note-item=' + $$('section.note-item').length + '，.note-item=' + $$('.note-item').length);
    lines.push('能解析出的笔记：' + scanCards().length + ' 篇');
    const tabs = mainTabs();
    lines.push('主标签：' + (tabs.length ? tabs.map(function (t) { return (t.textContent || '').trim().slice(0, 8); }).join(' | ') : '未找到'));
    lines.push('激活标签：' + (currentTabLabel() || '无法判定（不影响运行）'));
    lines.push('滚动方式：' + (findScrollContainer() ? '内部容器' : 'window'));

    const uncollectCount = (state.modeCache && state.modeCache.uncollect) ? state.modeCache.uncollect.length : 0;
    const unlikeCount = (state.modeCache && state.modeCache.unlike) ? state.modeCache.unlike.length : 0;
    lines.push('独立缓存：收藏 ' + uncollectCount + ' 篇，点赞 ' + unlikeCount + ' 篇');
    lines.push('本地记录：已取消收藏 ' + state.processed.uncollect.length + ' 条，已取消点赞 ' + state.processed.unlike.length + ' 条');
    lines.push('累计历史：' + state.history.length + ' 条');
    lines.forEach(function (l) { log('· ' + l); });
    console.info('[RedNote Manager] 诊断\n' + lines.join('\n'));
    if (!p || !p.signer) log('提示：签名函数缺失通常刷新页面即可恢复', 'warn');
  }

  async function clearRecords() {
    if (state.running) return;
    if (!window.confirm('清空「已处理」记录和撤销历史？这不会影响账号，只是让这些笔记重新进入候选。')) return;
    state.processed = { uncollect: [], unlike: [] };
    state.history = [];
    state.modeCache = { uncollect: [], unlike: [] };
    state.modeSelected = { uncollect: new Map(), unlike: new Map() };
    syncActiveModePointers();
    tabTransitionLock = false;
    tabTransitionStaleIds.clear();
    saveProcessed();
    await saveHistory();
    log('已清空本地记录与各模式缓存', 'ok');
    broadcastState();
  }

  function setMode(mode) {
    if (!C.MODES[mode] || state.running) return;

    const targetTab = mode === 'unlike' ? 'like' : 'collect';
    const curActualTab = getPageActualTabType();

    if (targetTab !== currentScannedTabType || curActualTab !== targetTab) {
      beginTabTransition(targetTab);
    }

    if (state.settings.mode === mode) return;

    state.settings.mode = mode;
    saveSettings();
    syncActiveModePointers(); // 切换指针到当前模式的独立缓存！
    state.anchorId = null;
    clearPageCards();
    log('已切换到「' + C.MODES[mode].label + '」视图，显示对应已缓存笔记（' + state.candidates.length + ' 篇）', 'info');
    afterSelectionChange();
    if (stackState.open) syncStackListToFilter();
    refreshPageCards();
    broadcastState();
  }

  /* ============================ 挂载页面底部反馈栏与叠卡浮层 ============================ */

  function mount() {
    if (state.mounted) return;
    const existingHost = document.getElementById('rn-manager-host');
    if (existingHost) {
      try { existingHost.remove(); } catch (e) {}
    }
    const host = document.createElement('div');
    host.id = 'rn-manager-host';
    host.style.cssText = 'position: fixed; inset: 0; width: 0; height: 0; z-index: 2147483600; pointer-events: none;';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    // 1. 全局居中独立提示浮层（不依赖底部条显示）
    const toast = document.createElement('div');
    toast.className = 'rn-global-toast';
    toast.id = 'rn-global-toast';
    root.appendChild(toast);

    // 2. 底部已选条数悬浮反馈栏
    const wrap = document.createElement('div');
    wrap.className = 'rn-bar-wrap rn-hidden';
    wrap.id = 'rn-bar-wrap';
    wrap.innerHTML = [
      '<div class="rn-bar-toast" id="rn-bar-toast"></div>',
      '<div class="rn-bar-badge">',
      '  <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
      '</div>',
      '<div class="rn-bar-info">',
      '  已选择 <span class="rn-bar-count" id="rn-bar-count">0</span> 篇笔记',
      '</div>',
      '<span class="rn-bar-sep"></span>',
      '<button class="rn-bar-btn" id="rn-bar-stack" type="button" title="以叠卡形式逐篇浏览并快速操作">🗂️ 叠卡浏览</button>',
      '<button class="rn-bar-btn" id="rn-bar-clear" type="button" title="清空全部已选笔记">清空</button>',
      '<button class="rn-bar-btn rn-bar-open" id="rn-bar-open" type="button" title="展开 Chrome 原生侧边栏操作">展开侧边栏 ⇥</button>',
    ].join('');
    root.appendChild(wrap);

    // 2.5 页面端筛选状态指示胶囊（让用户一眼感知搜索筛选状态，并支持一键恢复全部笔记）
    const filterPill = document.createElement('div');
    filterPill.className = 'rn-filter-pill';
    filterPill.id = 'rn-filter-pill';
    filterPill.innerHTML = [
      '<span class="rn-filter-pill-icon">🔍</span>',
      '<span class="rn-filter-pill-text" id="rn-filter-pill-text"></span>',
      '<button class="rn-filter-pill-clear" id="rn-filter-pill-clear" type="button" title="清空搜索词并恢复全部卡片">清空 ×</button>',
    ].join('');
    root.appendChild(filterPill);

    // 3. 叠卡速览交互模态框
    const stackOverlay = document.createElement('div');
    stackOverlay.className = 'rn-stack-overlay';
    stackOverlay.id = 'rn-stack-overlay';
    stackOverlay.innerHTML = [
      '<div class="rn-stack-box">',
      '  <div class="rn-stack-header">',
      '    <div class="rn-stack-title-area">',
      '      <span class="rn-stack-badge">🗂️ 叠卡浏览</span>',
      '      <span class="rn-stack-counter" id="rn-stack-counter">第 0 / 0 篇</span>',
      '    </div>',
      '    <div class="rn-stack-header-actions">',
      '      <button class="rn-stack-header-undo" id="rn-stack-undo" type="button" title="撤销刚才处理的笔记 (快捷键: Z)" disabled>↩️ 撤销刚才</button>',
      '      <button class="rn-stack-close" id="rn-stack-close" type="button" title="关闭 (Esc)">×</button>',
      '    </div>',
      '  </div>',
      '  <div class="rn-stack-auto-row">',
      '    <div class="rn-stack-opt">',
      '      <span>🎲 随机回顾</span>',
      '      <label class="rn-stack-toggle" title="开启后，下一个将随机抽取笔记进行回顾">',
      '        <input type="checkbox" id="rn-stack-random-toggle"' + (stackState.randomMode ? ' checked' : '') + '>',
      '        <span class="rn-stack-slider"></span>',
      '      </label>',
      '    </div>',
      '    <div class="rn-stack-opt">',
      '      <span>操作后自动下一个</span>',
      '      <label class="rn-stack-toggle" title="开启后，点击操作按钮将自动滑向下一篇">',
      '        <input type="checkbox" id="rn-stack-auto-toggle"' + (stackState.autoAdvance ? ' checked' : '') + '>',
      '        <span class="rn-stack-slider"></span>',
      '      </label>',
      '    </div>',
      '  </div>',
      '  <div class="rn-stack-deck" id="rn-stack-deck">',
      '    <div class="rn-card-layer rn-layer-2" id="rn-layer-2"></div>',
      '    <div class="rn-card-layer rn-layer-1" id="rn-layer-1"></div>',
      '    <div class="rn-card-main" id="rn-card-main">',
      '      <div class="rn-card-cover-box">',
      '        <img class="rn-card-cover-img" id="rn-card-img" alt="封面" style="display:none;" />',
      '        <div class="rn-card-cover-empty" id="rn-card-empty">🎴</div>',
      '        <span class="rn-card-status-pill" id="rn-card-status">待处理</span>',
      '        <a class="rn-card-open-btn" id="rn-card-open-btn" target="_blank" rel="noopener" title="在新标签页中打开查看笔记原文">查看原文 ↗</a>',
      '      </div>',
      '      <div class="rn-card-info-box">',
      '        <div class="rn-card-title" id="rn-card-title"></div>',
      '        <div class="rn-card-meta">',
      '          <span class="rn-card-author" id="rn-card-author"></span>',
      '          <span id="rn-card-id"></span>',
      '        </div>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <div class="rn-stack-actions">',
      '    <button class="rn-action-nav-btn" id="rn-stack-prev" type="button" title="上一张 (快捷键: ←)">',
      '      <span>⬅</span> 上一个',
      '    </button>',
      '    <div class="rn-action-exec-btns">',
      '      <button class="rn-stack-action-btn" id="rn-stack-action" type="button" aria-label="执行操作" title="取消操作 (快捷键: 空格 / 回车 / ↓)"></button>',
      '    </div>',
      '    <button class="rn-action-nav-btn" id="rn-stack-next" type="button" title="下一张 (快捷键: →)">',
      '      下一个 <span>➡</span>',
      '    </button>',
      '  </div>',
      '  <div class="rn-stack-tips">',
      '    <span><kbd>Space</kbd> 取消操作</span>',
      '    <span><kbd>←</kbd> <kbd>→</kbd> 翻页</span>',
      '    <span><kbd>Z</kbd> 撤销</span>',
      '    <span><kbd>Esc</kbd> 关闭</span>',
      '  </div>',
      '</div>',
    ].join('');
    root.appendChild(stackOverlay);

    (document.body || document.documentElement).appendChild(host);
    state.mounted = true;

    state.els = {
      host: host,
      root: root,
      wrap: wrap,
      count: $('#rn-bar-count', root),
      toast: toast,
      clear: $('#rn-bar-clear', root),
      open: $('#rn-bar-open', root),
      stack: $('#rn-bar-stack', root),
      filterPill: filterPill,
      filterPillText: $('#rn-filter-pill-text', root),
      filterPillClear: $('#rn-filter-pill-clear', root),
    };

    stackState.els = {
      overlay: stackOverlay,
      deck: $('#rn-stack-deck', root),
      counter: $('#rn-stack-counter', root),
      close: $('#rn-stack-close', root),
      autoToggle: $('#rn-stack-auto-toggle', root),
      randomToggle: $('#rn-stack-random-toggle', root),
      layer1: $('#rn-layer-1', root),
      layer2: $('#rn-layer-2', root),
      cardMain: $('#rn-card-main', root),
      img: $('#rn-card-img', root),
      empty: $('#rn-card-empty', root),
      status: $('#rn-card-status', root),
      title: $('#rn-card-title', root),
      author: $('#rn-card-author', root),
      id: $('#rn-card-id', root),
      btnPrev: $('#rn-stack-prev', root),
      btnNext: $('#rn-stack-next', root),
      btnAction: $('#rn-stack-action', root),
      btnLike: $('#rn-stack-action', root),
      btnCollect: $('#rn-stack-action', root),
      btnUncollect: $('#rn-stack-action', root),
      btnUnlike: $('#rn-stack-action', root),
      btnOpen: $('#rn-card-open-btn', root),
      btnUndo: $('#rn-stack-undo', root),
    };

    const openBtn = $('#rn-card-open-btn', root);
    if (openBtn) {
      openBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        const note = stackState.list[stackState.index];
        if (note && note.id) {
          const token = note.xsecToken || (state.xsecTokens && state.xsecTokens[note.id]) || '';
          const url = C.buildNoteUrl(note.url || note.id, token);
          if (url) {
            window.open(url, '_blank', 'noopener');
          }
        }
      });
    }

    const titleEl = $('#rn-card-title', root);
    if (titleEl) {
      titleEl.addEventListener('click', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        const note = stackState.list[stackState.index];
        if (note && note.id) {
          const token = note.xsecToken || (state.xsecTokens && state.xsecTokens[note.id]) || '';
          const url = C.buildNoteUrl(note.url || note.id, token);
          if (url) {
            window.open(url, '_blank', 'noopener');
          }
        }
      });
    }

    $('#rn-bar-clear', root).addEventListener('click', function (ev) {
      ev.stopPropagation();
      clearSelection();
    });

    $('#rn-bar-open', root).addEventListener('click', function (ev) {
      ev.stopPropagation();
      try {
        quietly(chrome.runtime.sendMessage({ type: 'RN_OPEN_SIDE_PANEL' }));
      } catch (e) {}
      showToast('已请求展开侧边栏（也可随时点击右上角插件图标）');
    });

    if (state.els.filterPillClear) {
      state.els.filterPillClear.addEventListener('click', function (ev) {
        ev.stopPropagation();
        state.settings.keyword = '';
        afterSelectionChange();
        try {
          quietly(chrome.runtime.sendMessage({ type: 'RN_FILTER_CLEARED' }));
        } catch (e) {}
        showToast('已清空搜索筛选条件');
      });
    }

    $('#rn-bar-stack', root).addEventListener('click', function (ev) {
      ev.stopPropagation();
      openStackView();
    });

    stackOverlay.addEventListener('click', function (ev) {
      if (ev.target === stackOverlay) {
        closeStackView();
      }
    });

    stackState.els.close.addEventListener('click', function (ev) {
      ev.stopPropagation();
      closeStackView();
    });

    stackState.els.autoToggle.addEventListener('change', function () {
      stackState.autoAdvance = !!this.checked;
      try {
        localStorage.setItem('rn:stack_auto_advance', String(stackState.autoAdvance));
      } catch (e) {}
    });

    stackState.els.randomToggle.addEventListener('change', function () {
      stackState.randomMode = !!this.checked;
      try {
        localStorage.setItem('rn:stack_random_mode', String(stackState.randomMode));
      } catch (e) {}
      renderStackCard();
    });

    stackState.els.btnPrev.addEventListener('click', function (ev) {
      ev.stopPropagation();
      prevStackCard();
    });

    stackState.els.btnNext.addEventListener('click', function (ev) {
      ev.stopPropagation();
      nextStackCard('left');
    });

    const stackActionBtn = stackState.els.btnAction || $('#rn-stack-action', root);
    if (stackActionBtn) {
      stackActionBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        executeStackAction(state.settings.mode);
      });
    }

    if (stackState.els.btnUndo) {
      stackState.els.btnUndo.addEventListener('click', function (ev) {
        ev.stopPropagation();
        undoRun({ undoType: 'single', mode: state.settings.mode });
      });
    }

    bindPageEvents();
    refreshPageCards();
    updateSelectionFeedback();
    if (pageTimer) clearInterval(pageTimer);
    pageTimer = setInterval(refreshPageCards, 400);
  }

  function unmount() {
    if (!state.mounted) return;
    try {
      if (state.els && state.els.host && state.els.host.parentNode) {
        state.els.host.parentNode.removeChild(state.els.host);
      }
    } catch (e) { /* 忽略 */ }
    clearPageCards();
    state.mounted = false;
    state.els = null;
    stackState.els = null;
    stackState.open = false;
  }

  /* ============================ 与 Chrome 侧边栏通信 ============================ */

  function fullPublicState() {
    syncActiveModePointers();
    const mode = state.settings.mode;
    const M = C.MODES[mode];
    const vis = visibleCandidates();
    const selKeys = Array.from(state.selected.keys());
    const visSel = vis.filter(function (n) { return state.selected.has(n.id); }).length;

    const uncollectList = (state.modeCache && state.modeCache.uncollect) || [];
    const unlikeList = (state.modeCache && state.modeCache.unlike) || [];

    const formatNote = function (n) {
      const token = n.xsecToken || (state.xsecTokens && state.xsecTokens[n.id]) || '';
      return {
        id: n.id,
        title: n.title,
        author: n.author || '',
        cover: n.cover || '',
        url: C.buildNoteUrl(n.url || n.id, token),
        xsecToken: token,
      };
    };

    return {
      mounted: state.mounted,
      running: state.running,
      scanning: !!state.scanning,
      mode: mode,
      modeLabel: M ? M.label : '',
      candidates: state.candidates.map(formatNote),
      candidatesCount: state.candidates.length,
      selected: selKeys,
      selectedCount: state.selected.size,
      visible: vis.map(formatNote),
      visibleCount: vis.length,
      visibleSelectedCount: visSel,
      cacheCounts: {
        uncollect: uncollectList.length,
        unlike: unlikeList.length,
      },
      stats: {
        ok: state.stats.ok,
        fail: state.stats.fail,
        risk: state.stats.risk,
        total: state.stats.total || 0,
      },
      logs: state.logs.slice(-100),
      processed: {
        uncollect: state.processed.uncollect.slice(),
        unlike: state.processed.unlike.slice(),
      },
      settings: Object.assign({}, state.settings),
      lastLog: state.logs.length ? state.logs[state.logs.length - 1].msg : '',
      lastUndo: (function () {
        const u = C.findUndoTarget(state.history, mode);
        return u ? {
          canUndo: true,
          type: u.type,
          count: u.count,
          noteId: u.noteId,
          batchId: u.batchId,
          title: u.title,
          mode: u.mode,
        } : null;
      })(),
      onProfile: PROFILE_RE.test(location.pathname),
      isOwnNotes: isOwnNotesPage(),
      risk: state.stats.risk,
    };
  }

  function broadcastState() {
    try {
      quietly(chrome.runtime.sendMessage({
        type: 'RN_STATE_UPDATED',
        state: fullPublicState(),
      }));
    } catch (e) { /* 忽略 */ }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('RN_') !== 0) return;

    if (msg.type === 'RN_STATE' || msg.type === 'RN_GET_STATE') {
      syncDomCardsToCandidates();
      sendResponse({ ok: true, state: fullPublicState() });
      return;
    }
    if (msg.type === 'RN_REFRESH_CACHE') {
      abortActiveScan('刷新独立缓存');
      state.modeCache = { uncollect: [], unlike: [] };
      state.modeSelected = { uncollect: new Map(), unlike: new Map() };
      syncActiveModePointers();
      tabTransitionLock = false;
      tabTransitionStaleIds.clear();
      clearPageCards();
      syncDomCardsToCandidates();
      refreshPageCards();
      broadcastState();
      log('已清空所有独立缓存，当前已纯净重载页面卡片', 'ok');
      sendResponse({ ok: true, state: fullPublicState() });
      return;
    }
    if (msg.type === 'RN_ACTION') {
      const action = msg.action;
      if (action === 'start') startRun();
      else if (action === 'stop') requestStop();
      else if (action === 'scan') scanOnly();
      else if (action === 'undo') undoRun(msg);
      else if (action === 'diagnose') diagnose();
      sendResponse({ ok: true, state: fullPublicState() });
      return;
    }
    if (msg.type === 'RN_SET_MODE') {
      setMode(msg.mode);
      if (stackState.open) {
        syncStackListToFilter({
          keyword: msg.keyword,
          tag: msg.tag,
          ids: msg.ids,
        });
      }
      sendResponse({ ok: true, state: fullPublicState() });
      return;
    }
    if (msg.type === 'RN_SYNC_STACK_FILTER') {
      if (typeof msg.keyword === 'string') {
        state.settings.keyword = msg.keyword.slice(0, 200);
      }
      syncStackListToFilter({
        keyword: msg.keyword,
        tag: msg.tag,
        ids: msg.ids,
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'RN_SET_KEYWORD') {
      state.sidepanelConnected = true;
      state.settings.keyword = String(msg.keyword || '').slice(0, 200);
      saveSettings();
      state.anchorId = null;
      afterSelectionChange();
      if (stackState.open) syncStackListToFilter();
      sendResponse({ ok: true, state: fullPublicState() });
      return;
    }
    if (msg.type === 'RN_FILTER_CLEARED') {
      state.settings.keyword = '';
      saveSettings();
      state.anchorId = null;
      afterSelectionChange();
      if (stackState.open) syncStackListToFilter();
      sendResponse({ ok: true, state: fullPublicState() });
      return;
    }
    if (msg.type === 'RN_TOGGLE_SELECTION') {
      const note = noteById(msg.noteId) || pageNoteFor(msg.noteId) || { id: msg.noteId, title: '' };
      toggleSelection(note, !!msg.shiftKey, {
        order: pageCardIds(),
        lookup: function (x) { return pageNoteFor(x) || noteById(x) || { id: x, title: '' }; },
      });
      if (stackState.open) syncStackListToFilter();
      sendResponse({ ok: true, state: fullPublicState() });
      return;
    }
    if (msg.type === 'RN_SELECT_ALL_VISIBLE') {
      if (typeof msg.keyword === 'string') {
        state.settings.keyword = msg.keyword.slice(0, 200);
      }
      selectAllVisible(Array.isArray(msg.ids) ? msg.ids : null);
      if (stackState.open) syncStackListToFilter();
      sendResponse({ ok: true, state: fullPublicState() });
      return;
    }
    if (msg.type === 'RN_INVERT_VISIBLE') {
      invertVisible(Array.isArray(msg.ids) ? msg.ids : null);
      if (stackState.open) syncStackListToFilter();
      sendResponse({ ok: true, state: fullPublicState() });
      return;
    }
    if (msg.type === 'RN_CLEAR_SELECTION') {
      clearSelection();
      if (stackState.open) syncStackListToFilter();
      sendResponse({ ok: true, state: fullPublicState() });
      return;
    }
    if (msg.type === 'RN_UPDATE_SETTINGS') {
      state.settings = C.clampSettings(Object.assign({}, state.settings, msg.settings || {}));
      saveSettings();
      broadcastState();
      sendResponse({ ok: true, state: fullPublicState() });
      return;
    }
    if (msg.type === 'RN_CLEAR_RECORDS') {
      clearRecords();
      sendResponse({ ok: true, state: fullPublicState() });
      return;
    }
    if (msg.type === 'RN_OPEN_STACK_VIEW') {
      const res = openStackView(msg);
      sendResponse({
        ok: !!(res && res.ok),
        count: (res && res.count) || 0,
        reason: (res && res.reason) || '',
        state: fullPublicState(),
      });
      return;
    }
  });

  /* ============================ 生命周期 ============================ */

  let lastKnownUrl = location.href;

  function onUrlChange() {
    if (location.href !== lastKnownUrl) {
      lastKnownUrl = location.href;
      const detected = getPageActualTabType();
      if (detected && detected !== currentScannedTabType) {
        beginTabTransition(detected);
      }
      syncModeWithActiveTab();

      // 切 Tab / URL 变化时，切换至对应模式的独立缓存
      syncActiveModePointers();
      state.anchorId = null;
      clearPageCards();
      broadcastState();

      if (!isOwnNotesPage() && detected) {
        const urlGen = tabSwitchGeneration;
        waitForCards(3000, detected).then(function (success) {
          if (tabSwitchGeneration !== urlGen || !success) return;
          if (syncDomCardsToCandidates()) broadcastState();
          refreshPageCards();
        });
      }
    }
  }

  function tick() {
    const onProfile = PROFILE_RE.test(location.pathname);
    if (onProfile && !state.mounted) {
      mount();
    } else if (!onProfile && state.mounted) {
      unmount();
    }
    if (onProfile && state.mounted) {
      onUrlChange();
      syncModeWithActiveTab();
      if (!isOwnNotesPage() && !tabTransitionLock) {
        if (syncDomCardsToCandidates()) {
          broadcastState();
          if (stackState.open) syncStackListToFilter();
        }
        refreshPageCards();
      }
    }
  }

  window.addEventListener('popstate', onUrlChange);

  (async function boot() {
    await loadStorage();
    updateMyProfileInfo();
    quietly(detectMyUserInfo());
    quietly(syncPageTokens());
    tick();
    syncDomCardsToCandidates();
    broadcastState();
    // SPA 路由跳转不会触发 load，用轮询兜住
    setInterval(tick, 1200);
    if (state.mounted) {
      log('就绪：卡片左上角可直接勾选；或展开 Chrome 原生侧边栏批量操作', 'info');
    }
  })();

  // 挂载至全局便于控制台调试与自检
  globalThis.__rnManager = {
    state: state,
    scan: scanCards,
    start: startRun,
    stop: requestStop,
    diagnose: diagnose,
    candidates: function () { return state.candidates.slice(); },
    visible: function () { return visibleCandidates().slice(); },
    selection: function () { return Array.from(state.selected.keys()); },
    selectAll: selectAllVisible,
    invert: invertVisible,
    clearSelection: clearSelection,
    fullPublicState: fullPublicState,
    stack: {
      open: openStackView,
      close: closeStackView,
      next: nextStackCard,
      prev: prevStackCard,
      execute: executeStackAction,
      state: stackState,
    },
  };
})();
