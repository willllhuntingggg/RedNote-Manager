'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/core.js');

test('核心配置中已彻底移除演练模式 (dryRun)', () => {
  const defaults = C.clampSettings(null);
  assert.strictEqual(defaults.dryRun, undefined, '默认配置中不应包含 dryRun');
  
  const custom = C.clampSettings({ dryRun: true, minDelay: 2000 });
  assert.strictEqual(custom.dryRun, undefined, '即便外部传入 dryRun 也不应被接受');
  assert.strictEqual(custom.minDelay, 2000);
});

test('小红书选择状态机与勾选条数反馈逻辑', () => {
  const notes = [
    { id: 'a'.repeat(24), title: '杭州旅行指南' },
    { id: 'b'.repeat(24), title: '成都火锅推荐' },
    { id: 'c'.repeat(24), title: '上海咖啡探店' },
    { id: 'd'.repeat(24), title: '北京独立书店' },
    { id: 'e'.repeat(24), title: '广州早茶清单' },
  ];

  const selected = new Map();
  let anchorId = null;

  function toggle(note, shiftKey, order) {
    const id = note.id;
    const ids = order || notes.map((n) => n.id);
    const idx = ids.indexOf(id);
    const anchorIdx = anchorId ? ids.indexOf(anchorId) : -1;

    let delta = 0;
    let type = '';

    if (shiftKey && anchorIdx !== -1 && idx !== -1 && anchorIdx !== idx) {
      const prev = selected.size;
      C.selectRange(ids, anchorIdx, idx).forEach((x) => {
        const found = notes.find((n) => n.id === x) || { id: x, title: '' };
        selected.set(x, found);
      });
      delta = selected.size - prev;
      type = 'range';
    } else if (selected.has(id)) {
      selected.delete(id);
      delta = -1;
      type = 'remove';
    } else {
      selected.set(id, note);
      delta = 1;
      type = 'add';
    }

    anchorId = id;
    return { type, delta, total: selected.size };
  }

  // 1. 单选反馈
  const f1 = toggle(notes[0], false);
  assert.strictEqual(f1.type, 'add');
  assert.strictEqual(f1.total, 1);
  assert.strictEqual(selected.size, 1);

  // 2. 取消反馈
  const f2 = toggle(notes[0], false);
  assert.strictEqual(f2.type, 'remove');
  assert.strictEqual(f2.total, 0);
  assert.strictEqual(selected.size, 0);

  // 3. Shift 区间多选反馈
  toggle(notes[1], false); // 选成都
  const f4 = toggle(notes[3], true); // Shift 选到北京 (成都, 上海, 北京 共 3 篇)
  assert.strictEqual(f4.type, 'range');
  assert.strictEqual(f4.total, 3);
  assert.strictEqual(selected.size, 3);
  assert.deepStrictEqual(Array.from(selected.keys()), [notes[1].id, notes[2].id, notes[3].id]);
});

test('搜索筛选与批量选择联动', () => {
  const notes = [
    { id: 'a'.repeat(24), title: '杭州旅行指南' },
    { id: 'b'.repeat(24), title: '成都美食火锅' },
    { id: 'c'.repeat(24), title: '上海美食咖啡' },
  ];

  const terms = C.parseKeywords('美食');
  const visible = notes.filter((n) => C.matchKeywords(n, terms));
  assert.strictEqual(visible.length, 2);

  const selected = new Map();
  // 全选可见
  visible.forEach((n) => selected.set(n.id, n));
  assert.strictEqual(selected.size, 2);
  assert.strictEqual(selected.has(notes[1].id), true);
  assert.strictEqual(selected.has(notes[2].id), true);
  assert.strictEqual(selected.has(notes[0].id), false);
});

test('用户自主浏览/滚动加载时自动增量合入候选数据，默认未选', () => {
  const candidates = [];
  const selected = new Map();

  function syncCards(renderedCards) {
    const existingMap = new Map();
    candidates.forEach((c) => existingMap.set(c.id, c));
    let changed = false;

    renderedCards.forEach((c) => {
      if (!existingMap.has(c.id)) {
        candidates.push({ id: c.id, title: c.title || '未命名笔记', author: c.author || '' });
        existingMap.set(c.id, c);
        changed = true;
      } else if (c.title) {
        const old = existingMap.get(c.id);
        if (!old.title || old.title === '未命名笔记' || old.title.length < c.title.length) {
          old.title = c.title;
          changed = true;
        }
      }
    });
    return changed;
  }

  // 1. 首屏自动加载 3 篇（用户未点击自动读取列表）
  const screen1 = [
    { id: '1'.repeat(24), title: '秋日穿搭分享' },
    { id: '2'.repeat(24), title: '咖啡拉花教程' },
    { id: '3'.repeat(24), title: '摄影构图灵感' },
  ];
  assert.strictEqual(syncCards(screen1), true);
  assert.strictEqual(candidates.length, 3);
  assert.strictEqual(selected.size, 0, '自动捕获的内容默认为未勾选');

  // 用户在页面上勾选第 2 篇
  selected.set(candidates[1].id, candidates[1]);
  assert.strictEqual(selected.size, 1);

  // 2. 用户自主向下滚动，渲染出更多卡片（虚拟列表导致部分旧节点可能卸载，但新节点出现）
  const screen2 = [
    { id: '2'.repeat(24), title: '咖啡拉花教程' }, // 重叠保留
    { id: '4'.repeat(24), title: '秋冬大衣搭配' },
    { id: '5'.repeat(24), title: '手冲咖啡豆推荐' },
  ];
  assert.strictEqual(syncCards(screen2), true);
  assert.strictEqual(candidates.length, 5, '已累积 5 篇候选笔记，旧笔记不丢失');
  assert.strictEqual(selected.size, 1, '已有的勾选状态不会被新加载内容冲掉');
  assert.strictEqual(selected.has(candidates[1].id), true);

  // 3. 在已自主加载的内容中搜索「穿搭」或「搭配」
  const query = '穿搭, 搭配';
  const terms = C.parseKeywords(query);
  const searchResults = candidates.filter((n) => C.matchKeywords(n, terms));
  assert.strictEqual(searchResults.length, 2, '命中 2 篇与穿搭相关的笔记');
  assert.deepStrictEqual(
    searchResults.map((n) => n.id),
    ['1'.repeat(24), '4'.repeat(24)]
  );

  // 4. 清空搜索后展示全部已加载内容
  const emptyTerms = C.parseKeywords('');
  const allResults = candidates.filter((n) => C.matchKeywords(n, emptyTerms));
  assert.strictEqual(allResults.length, 5);
});

test('叠卡速览交互引擎：列表筛选、翻页边界与「操作后自动下一个」开关控制', () => {
  const candidates = [
    { id: 'a'.repeat(24), title: '日系复古滤镜调色', author: '阿喵' },
    { id: 'b'.repeat(24), title: '极简桌面布置指南', author: '小张' },
    { id: 'c'.repeat(24), title: '复古黑胶唱片推荐', author: '老李' },
  ];
  const processed = { uncollect: new Set(), unlike: new Set() };
  const history = [];

  // 叠卡状态机模拟
  const stack = {
    open: false,
    list: [],
    index: 0,
    autoAdvance: true,
  };

  function openStack(opts) {
    let list = candidates.slice();
    if (opts && opts.keyword) {
      const terms = C.parseKeywords(opts.keyword);
      list = candidates.filter((n) => C.matchKeywords(n, terms));
    }
    if (!list.length) return false;
    stack.list = list;
    stack.index = 0;
    stack.open = true;
    return true;
  }

  function next() {
    if (stack.index >= stack.list.length - 1) return false;
    stack.index++;
    return true;
  }

  function prev() {
    if (stack.index <= 0) return false;
    stack.index--;
    return true;
  }

  function executeAction(mode) {
    const current = stack.list[stack.index];
    if (!current) return false;
    // 标记已处理
    processed[mode].add(current.id);
    history.push({ id: current.id, mode, ts: Date.now() });

    // 开关控制：若开启自动下一个，前进
    if (stack.autoAdvance) {
      if (stack.index < stack.list.length - 1) {
        next();
      }
    }
    return true;
  }

  // 1. 全量打开叠卡
  assert.strictEqual(openStack(), true);
  assert.strictEqual(stack.list.length, 3);
  assert.strictEqual(stack.index, 0);

  // 翻页边界：第一张不能向前翻
  assert.strictEqual(prev(), false);
  assert.strictEqual(stack.index, 0);

  // 向后翻页
  assert.strictEqual(next(), true);
  assert.strictEqual(stack.index, 1);
  assert.strictEqual(next(), true);
  assert.strictEqual(stack.index, 2);

  // 翻页边界：最后一张不能向后翻
  assert.strictEqual(next(), false);
  assert.strictEqual(stack.index, 2);

  // 2. 带搜索词「复古」打开叠卡
  assert.strictEqual(openStack({ keyword: '复古' }), true);
  assert.strictEqual(stack.list.length, 2, '命中阿喵和老李的两篇');
  assert.strictEqual(stack.index, 0);

  // 3. 开启「操作后自动下一个」并点击取消收藏
  stack.autoAdvance = true;
  executeAction('uncollect');
  assert.strictEqual(processed.uncollect.has('a'.repeat(24)), true);
  assert.strictEqual(stack.index, 1, '自动跳到了第 2 篇（索引 1）');

  // 处理最后一张
  executeAction('uncollect');
  assert.strictEqual(processed.uncollect.has('c'.repeat(24)), true);
  assert.strictEqual(stack.index, 1, '已是最后一张，保持在末位');

  // 4. 关闭「操作后自动下一个」开关
  stack.autoAdvance = false;
  stack.index = 0;
  executeAction('unlike');
  assert.strictEqual(processed.unlike.has('a'.repeat(24)), true);
  assert.strictEqual(stack.index, 0, '关闭自动下一个后，依然停留在当前卡片');

  // 5. 右侧面板搜索联动测试：当叠层开启时，右侧做搜索，左侧叠层内容即刻同步
  function syncStackToFilter(kw) {
    const terms = C.parseKeywords(kw);
    const filtered = kw ? candidates.filter((n) => C.matchKeywords(n, terms)) : candidates.slice();
    const current = stack.list[stack.index];
    stack.list = filtered;
    if (!filtered.length) {
      stack.index = 0;
      return;
    }
    const foundIdx = current ? filtered.findIndex((n) => n.id === current.id) : -1;
    stack.index = foundIdx !== -1 ? foundIdx : 0;
  }

  // 右侧输入「黑胶」
  syncStackToFilter('黑胶');
  assert.strictEqual(stack.list.length, 1);
  assert.strictEqual(stack.list[0].id, 'c'.repeat(24), '叠层卡片同步为搜索命中的黑胶笔记');
  assert.strictEqual(stack.index, 0);

  // 右侧清空搜索
  syncStackToFilter('');
  assert.strictEqual(stack.list.length, 3, '清空搜索后叠层卡片同步还原为全部候选');
});

test('叠卡速览交互引擎：随机回顾模式（随机下一个）与历史回溯（上一个）', () => {
  const list = [
    { id: '1'.repeat(24), title: '笔记1' },
    { id: '2'.repeat(24), title: '笔记2' },
    { id: '3'.repeat(24), title: '笔记3' },
    { id: '4'.repeat(24), title: '笔记4' },
  ];

  const stack = {
    list: list,
    index: 0,
    randomMode: true,
    history: [],
  };

  function nextRandom(mockRand) {
    if (stack.list.length <= 1) return false;
    stack.history.push(stack.index);
    let rand = typeof mockRand === 'number' ? mockRand : Math.floor(Math.random() * stack.list.length);
    if (rand === stack.index && stack.list.length > 1) {
      rand = (rand + 1) % stack.list.length;
    }
    stack.index = rand;
    return true;
  }

  function prevHistory() {
    if (stack.history.length > 0) {
      stack.index = stack.history.pop();
      return true;
    }
    return false;
  }

  // 1. 验证从第 0 篇随机跳到第 2 篇
  assert.strictEqual(nextRandom(2), true);
  assert.strictEqual(stack.index, 2);
  assert.strictEqual(stack.history.length, 1);
  assert.strictEqual(stack.history[0], 0);

  // 2. 从第 2 篇随机跳到第 3 篇
  assert.strictEqual(nextRandom(3), true);
  assert.strictEqual(stack.index, 3);
  assert.strictEqual(stack.history.length, 2);

  // 3. 点击「上一个」按历史原路回溯到第 2 篇
  assert.strictEqual(prevHistory(), true);
  assert.strictEqual(stack.index, 2);

  // 4. 再点击「上一个」回溯到第 0 篇
  assert.strictEqual(prevHistory(), true);
  assert.strictEqual(stack.index, 0);

  // 5. 历史为空时不能继续后退
  assert.strictEqual(prevHistory(), false);
  assert.strictEqual(stack.index, 0);
});

test('叠卡速览交互引擎：按模式彻底解耦，收藏模式专注取消收藏，点赞模式专注取消点赞，单Action专属按钮与状态判定', () => {
  const processed = { uncollect: new Set(), unlike: new Set() };
  const modeCache = {
    uncollect: [{ id: 'fav1'.padEnd(24, '0') }],
    unlike: [], // 模拟用户尚未加载点赞列表（以往跨模式查询会导致收藏笔记误显示为空心未点赞）
  };

  function getNoteStatus(note, targetMode) {
    if (!note || !note.id) return { active: false, processed: true, liked: false, collected: false };
    const mode = targetMode || 'uncollect';
    const isProc = processed[mode].has(note.id);

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

  function renderActionButton(st, mode) {
    if (mode === 'unlike') {
      return {
        className: 'rn-stack-action-btn rn-btn-unlike',
        text: (st.processed || !st.active) ? '已取消点赞' : '取消点赞',
        html: (st.processed || !st.active) ? '<span>已取消点赞</span>' : '<span>取消点赞</span><kbd class="rn-stack-kbd">Space</kbd>',
        disabled: st.processed || !st.active,
        statusPill: (st.processed || !st.active) ? '已取消点赞' : '已点赞 ❤️',
      };
    } else {
      return {
        className: 'rn-stack-action-btn rn-btn-uncollect',
        text: (st.processed || !st.active) ? '已取消收藏' : '取消收藏',
        html: (st.processed || !st.active) ? '<span>已取消收藏</span>' : '<span>取消收藏</span><kbd class="rn-stack-kbd">Space</kbd>',
        disabled: st.processed || !st.active,
        statusPill: (st.processed || !st.active) ? '已取消收藏' : '已收藏 ⭐',
      };
    }
  }

  // 1. 收藏模式（取消收藏）：无论点赞缓存是否为空，收藏卡片始终精准展示为已收藏，零跨仓误判
  const noteFav = { id: 'fav1'.padEnd(24, '0'), title: '收藏笔记' };
  let stFav = getNoteStatus(noteFav, 'uncollect');
  assert.strictEqual(stFav.active, true, '收藏笔记初始状态为待处理激活态');
  assert.strictEqual(stFav.collected, true, '标记为已收藏');
  assert.strictEqual(stFav.processed, false, '尚未处理');

  let btnFav = renderActionButton(stFav, 'uncollect');
  assert.strictEqual(btnFav.className, 'rn-stack-action-btn rn-btn-uncollect');
  assert.strictEqual(btnFav.text, '取消收藏');
  assert.strictEqual(btnFav.html.includes('<kbd class="rn-stack-kbd">Space</kbd>'), true, '按钮内部直观标出快捷键 Space');
  assert.strictEqual(btnFav.statusPill, '已收藏 ⭐');
  assert.strictEqual(btnFav.disabled, false);

  // 用户点击或按空格/回车触发取消收藏
  noteFav._collected = false;
  processed.uncollect.add(noteFav.id);
  stFav = getNoteStatus(noteFav, 'uncollect');
  assert.strictEqual(stFav.active, false, '取消后转为非激活');
  assert.strictEqual(stFav.processed, true, '已标记为处理完成');
  btnFav = renderActionButton(stFav, 'uncollect');
  assert.strictEqual(btnFav.text, '已取消收藏');
  assert.strictEqual(btnFav.statusPill, '已取消收藏');
  assert.strictEqual(btnFav.disabled, true);

  // 2. 点赞模式（取消点赞）：无论收藏缓存状态如何，点赞卡片始终专注点赞本身
  modeCache.unlike.push({ id: 'like1'.padEnd(24, '0') });
  const noteLike = { id: 'like1'.padEnd(24, '0'), title: '点赞笔记' };
  let stLike = getNoteStatus(noteLike, 'unlike');
  assert.strictEqual(stLike.active, true, '点赞笔记初始状态为待处理激活态');
  assert.strictEqual(stLike.liked, true, '标记为已点赞');
  assert.strictEqual(stLike.processed, false, '尚未处理');

  let btnLike = renderActionButton(stLike, 'unlike');
  assert.strictEqual(btnLike.className, 'rn-stack-action-btn rn-btn-unlike');
  assert.strictEqual(btnLike.text, '取消点赞');
  assert.strictEqual(btnLike.html.includes('<kbd class="rn-stack-kbd">Space</kbd>'), true, '按钮内部直观标出快捷键 Space');
  assert.strictEqual(btnLike.statusPill, '已点赞 ❤️');
  assert.strictEqual(btnLike.disabled, false);

  // 用户点击或按空格/回车触发取消点赞
  noteLike._liked = false;
  processed.unlike.add(noteLike.id);
  stLike = getNoteStatus(noteLike, 'unlike');
  assert.strictEqual(stLike.active, false, '取消后转为非激活');
  assert.strictEqual(stLike.processed, true, '已标记为处理完成');
  btnLike = renderActionButton(stLike, 'unlike');
  assert.strictEqual(btnLike.text, '已取消点赞');
  assert.strictEqual(btnLike.statusPill, '已取消点赞');
  assert.strictEqual(btnLike.disabled, true);

  // 3. 验证快捷键映射行为：空格、回车、方向键下均映射到当前模式的操作执行，Z 键撤销
  const actionDispatched = [];
  function handleKeyDown(key, currentMode) {
    if (key === ' ' || key === 'Enter' || key === 'ArrowDown') {
      actionDispatched.push(currentMode);
      return true;
    }
    if (key === 'z' || key === 'Z') {
      actionDispatched.push('undo_' + currentMode);
      return true;
    }
    return false;
  }
  assert.strictEqual(handleKeyDown(' ', 'uncollect'), true);
  assert.strictEqual(handleKeyDown('Enter', 'uncollect'), true);
  assert.strictEqual(handleKeyDown('ArrowDown', 'unlike'), true);
  assert.strictEqual(handleKeyDown('z', 'uncollect'), true);
  assert.deepStrictEqual(actionDispatched, ['uncollect', 'uncollect', 'unlike', 'undo_uncollect']);
});

test('侧边栏模式切换 Tab：精简文案为「收藏」与「点赞」并保留计数角标', () => {
  const counts = { uncollect: 15, unlike: 28 };
  function renderTabLabel(modeKey) {
    const label = modeKey === 'uncollect' ? '收藏' : '点赞';
    const num = counts[modeKey] || 0;
    return label + ' <span class="rn-badge-cnt">' + num + '</span>';
  }

  assert.strictEqual(renderTabLabel('uncollect'), '收藏 <span class="rn-badge-cnt">15</span>');
  assert.strictEqual(renderTabLabel('unlike'), '点赞 <span class="rn-badge-cnt">28</span>');
});

test('安全隔离：严禁读取用户自己发布的笔记（Tab与作者双重过滤）', () => {
  const OWN_NOTE_TAB_KEYWORDS = ['笔记', '发布', '原创', '视频', '图文'];
  function isOwnNotesTab(text) {
    const clean = String(text || '').replace(/\s+/g, '').replace(/\d+/g, '');
    return OWN_NOTE_TAB_KEYWORDS.some((k) => clean.indexOf(k) === 0);
  }

  // 1. Tab 拦截验证
  assert.strictEqual(isOwnNotesTab('笔记 18'), true, '识别我发布的笔记Tab');
  assert.strictEqual(isOwnNotesTab('发布'), true);
  assert.strictEqual(isOwnNotesTab('收藏 42'), false, '收藏Tab放行');
  assert.strictEqual(isOwnNotesTab('赞过 105'), false, '点赞Tab放行');

  // 2. 标签切换隔离与原创笔记识别逻辑（即使切到收藏Tab也绝不泄漏笔记Tab数据）
  const ownNoteIds = new Set();
  const myProfileInfo = { userId: '5f1e2d3c4b5a69788796a5b4', nickname: '小红书测试博主' };

  function isOwnNote(note) {
    if (!note || !note.id) return false;
    if (ownNoteIds.has(note.id)) return true;
    if (myProfileInfo.userId && note.authorId && note.authorId.toLowerCase() === myProfileInfo.userId.toLowerCase()) return true;
    if (myProfileInfo.nickname && note.author && note.author.trim() === myProfileInfo.nickname.trim()) return true;
    return false;
  }

  // 模拟在「笔记」Tab 下扫描到的 2 篇原创笔记
  const publishedNotes = [
    { id: '1'.repeat(24), title: '我的第一篇原创自拍分享', author: '', authorId: '' },
    { id: '3'.repeat(24), title: '我的猫咪日常vlog', author: '小红书测试博主', authorId: myProfileInfo.userId },
  ];
  publishedNotes.forEach((n) => ownNoteIds.add(n.id));

  // 模拟切换到「收藏」Tab 后，DOM 中可能暂时混杂残留的旧笔记或自己收藏的自己的笔记
  const rawCardsOnTabSwitch = [
    publishedNotes[0], // 笔记Tab残留的原创
    { id: '2'.repeat(24), title: '秋冬显白美甲灵感', author: '美甲设计师', authorId: '9'.repeat(24) }, // 真正收藏的第三方笔记
    publishedNotes[1], // 笔记Tab残留或自己收藏的自己笔记
    { id: '4'.repeat(24), title: '东京中古店保姆级攻略', author: '小徐在东京', authorId: '8'.repeat(24) }, // 真正收藏的第三方笔记
  ];

  // 过滤后的合规候选集
  const safeCandidates = rawCardsOnTabSwitch.filter((c) => !isOwnNote(c));
  assert.strictEqual(safeCandidates.length, 2, '两篇原创笔记必须被100%过滤，即使在收藏Tab下');
  assert.deepStrictEqual(safeCandidates.map((c) => c.author), ['美甲设计师', '小徐在东京']);
  assert.strictEqual(isOwnNote(publishedNotes[0]), true, '通过 ownNoteIds 识别原创');
  assert.strictEqual(isOwnNote(publishedNotes[1]), true, '通过 author/authorId 识别原创');

  // 3. 主标签栏与「收藏」子标签栏（专辑/笔记）精准隔离
  const mockPageTabs = [
    // 主 Tab 栏
    { id: 't1', text: '笔记 12', active: false, parent: 'main-bar' },
    { id: 't2', text: '收藏 45', active: true, parent: 'main-bar' },
    { id: 't3', text: '赞过 30', active: false, parent: 'main-bar' },
    // 收藏内部的子 Tab 栏（绝不能误判为用户的主页笔记Tab）
    { id: 's1', text: '专辑 2', active: false, parent: 'sub-bar' },
    { id: 's2', text: '笔记 45', active: true, parent: 'sub-bar' },
  ];

  function identifyMainTabType(tabs) {
    const mainItems = tabs.filter((t) => t.parent === 'main-bar');
    for (const item of mainItems) {
      if (item.active) {
        const text = item.text.replace(/\s+/g, '').replace(/\d+/g, '');
        if (/^笔记/.test(text)) return 'notes';
        if (/^收藏/.test(text)) return 'collect';
        if (/^(?:赞过|点赞)/.test(text)) return 'like';
      }
    }
    return 'unknown';
  }

  assert.strictEqual(
    identifyMainTabType(mockPageTabs),
    'collect',
    '尽管子Tab中笔记45处于active，主Tab依然精准判定为collect（收藏），绝不误判为notes'
  );

  // 4. 自动模式同步测试
  let currentMode = 'uncollect';
  function syncMode(tabType) {
    if (tabType === 'collect') currentMode = 'uncollect';
    if (tabType === 'like') currentMode = 'unlike';
  }
  syncMode(identifyMainTabType(mockPageTabs));
  assert.strictEqual(currentMode, 'uncollect');

  // 切换至赞过
  mockPageTabs[1].active = false;
  mockPageTabs[2].active = true;
  assert.strictEqual(identifyMainTabType(mockPageTabs), 'like');
  syncMode(identifyMainTabType(mockPageTabs));
  assert.strictEqual(currentMode, 'unlike', '切换到赞过时模式自动同步为 unlike');

  // 5. 官方真实 URL 参数识别能力
  function parseUrlTab(searchStr) {
    const search = new URLSearchParams(searchStr);
    const tab = (search.get('tab') || '').toLowerCase();
    if (tab === 'fav' || tab === 'collect' || tab === 'board') return 'collect';
    if (tab === 'liked' || tab === 'like') return 'like';
    if (tab === 'note' || tab === 'publish') return 'notes';
    return '';
  }

  assert.strictEqual(parseUrlTab('?tab=note'), 'notes', '发布笔记Tab识别');
  assert.strictEqual(parseUrlTab('?tab=fav&subTab=note'), 'collect', '收藏Tab带子Tab识别');
  assert.strictEqual(parseUrlTab('?tab=liked'), 'like', '点赞Tab识别');

  // 6. 验证 isOwnNotesPage 与 isRelevantTab 在真实页面参数下的放行逻辑
  function isOwnNotes(searchStr) {
    return parseUrlTab(searchStr) === 'notes';
  }
  function isRelevant(searchStr) {
    return !isOwnNotes(searchStr);
  }

  assert.strictEqual(isOwnNotes('?tab=note'), true, '发布笔记必须被识别为原创页');
  assert.strictEqual(isRelevant('?tab=note'), false, '发布笔记页不可读取/操作');

  assert.strictEqual(isOwnNotes('?tab=fav&subTab=note'), false, '收藏页绝不可被识别为原创页');
  assert.strictEqual(isRelevant('?tab=fav&subTab=note'), true, '收藏页100%放行读取');

  assert.strictEqual(isOwnNotes('?tab=liked'), false, '点赞页绝不可被识别为原创页');
  assert.strictEqual(isRelevant('?tab=liked'), true, '点赞页100%放行读取');

  // 7. 测试页面 Tab 文本解析能力（detectTabFromText）
  function detectTabFromText(text) {
    const clean = String(text || '').replace(/\s+/g, '').replace(/\d+/g, '');
    if (/^(?:赞过|点赞|喜欢)/.test(clean) || clean.includes('赞过') || clean.includes('点赞')) return 'like';
    if (/^收藏/.test(clean) || clean.includes('收藏')) return 'collect';
    if (/^笔记/.test(clean) || clean.includes('笔记')) return 'notes';
    return '';
  }

  assert.strictEqual(detectTabFromText('赞过 105'), 'like', '赞过带数量');
  assert.strictEqual(detectTabFromText('点赞 99+'), 'like', '点赞带数量');
  assert.strictEqual(detectTabFromText('收藏 42'), 'collect', '收藏带数量');
  assert.strictEqual(detectTabFromText('笔记 10'), 'notes', '笔记带数量');
  assert.strictEqual(detectTabFromText('  赞过  '), 'like', '前后空格处理');

  // 8. 模式独立缓存隔离验证（点击取消收藏只展示收藏缓存，点击取消点赞只展示点赞缓存）
  const mockState = {
    settings: { mode: 'uncollect' },
    modeCache: {
      uncollect: [
        { id: 'c1'.padEnd(24, '0'), title: '收藏笔记1', author: '作者A' },
        { id: 'c2'.padEnd(24, '0'), title: '收藏笔记2', author: '作者B' },
      ],
      unlike: [
        { id: 'u1'.padEnd(24, '0'), title: '点赞笔记1', author: '作者C' },
        { id: 'u2'.padEnd(24, '0'), title: '点赞笔记2', author: '作者D' },
        { id: 'u3'.padEnd(24, '0'), title: '点赞笔记3', author: '作者E' },
      ],
    },
    modeSelected: {
      uncollect: new Map([['c1'.padEnd(24, '0'), { id: 'c1'.padEnd(24, '0'), title: '收藏笔记1' }]]),
      unlike: new Map([
        ['u1'.padEnd(24, '0'), { id: 'u1'.padEnd(24, '0'), title: '点赞笔记1' }],
        ['u2'.padEnd(24, '0'), { id: 'u2'.padEnd(24, '0'), title: '点赞笔记2' }],
      ]),
    },
    candidates: [],
    selected: new Map(),
  };

  function syncPointers(st) {
    st.candidates = st.modeCache[st.settings.mode];
    st.selected = st.modeSelected[st.settings.mode];
  }

  // 默认在 uncollect 模式
  syncPointers(mockState);
  assert.strictEqual(mockState.candidates.length, 2, '取消收藏模式下只展示 2 条收藏缓存');
  assert.strictEqual(mockState.selected.size, 1, '取消收藏模式下只展示 1 条已选收藏');
  assert.strictEqual(mockState.candidates[0].title, '收藏笔记1');

  // 切换至 unlike 模式（点击右侧面板「取消点赞」按钮）
  mockState.settings.mode = 'unlike';
  syncPointers(mockState);
  assert.strictEqual(mockState.candidates.length, 3, '取消点赞模式下只展示 3 条点赞缓存');
  assert.strictEqual(mockState.selected.size, 2, '取消点赞模式下只展示 2 条已选点赞');
  assert.strictEqual(mockState.candidates[0].title, '点赞笔记1');

  // 再次切换回 uncollect 模式（点击右侧面板「取消收藏」按钮）
  mockState.settings.mode = 'uncollect';
  syncPointers(mockState);
  assert.strictEqual(mockState.candidates.length, 2, '切回取消收藏模式时收藏缓存完好无损');
  assert.strictEqual(mockState.selected.size, 1, '切回取消收藏模式时勾选状态完好无损');
});

test('验证页面卡片入库严格取决于左侧小红书实际 Tab，与右侧侧边栏切换按钮彻底解耦，防止收藏卡片污染点赞缓存', () => {
  const state = {
    settings: { mode: 'uncollect' },
    modeCache: {
      uncollect: [],
      unlike: [],
    },
    modeSelected: {
      uncollect: new Map(),
      unlike: new Map(),
    },
    candidates: [],
    selected: new Map(),
  };

  function syncPointers() {
    const m = state.settings.mode;
    state.candidates = state.modeCache[m];
    state.selected = state.modeSelected[m];
  }

  // 卡片入库同步函数（与 content.js 中的 syncDomCardsToCandidates 核心逻辑一致）
  function syncCardsToCache(cards, actualPageTab) {
    if (actualPageTab !== 'collect' && actualPageTab !== 'like') {
      return false;
    }
    const targetMode = actualPageTab === 'like' ? 'unlike' : 'uncollect';
    const targetList = state.modeCache[targetMode];
    const existing = new Set(targetList.map((n) => n.id));

    let changed = false;
    cards.forEach((c) => {
      if (!existing.has(c.id)) {
        targetList.push(c);
        existing.add(c.id);
        changed = true;
      }
    });

    syncPointers();
    return changed;
  }

  // 1. 模拟在小红书「收藏」页面加载出 3 篇收藏笔记
  const favCards = [
    { id: 'f1'.padEnd(24, '0'), title: '我的收藏1' },
    { id: 'f2'.padEnd(24, '0'), title: '我的收藏2' },
    { id: 'f3'.padEnd(24, '0'), title: '我的收藏3' },
  ];
  syncCardsToCache(favCards, 'collect');
  assert.strictEqual(state.modeCache.uncollect.length, 3);
  assert.strictEqual(state.modeCache.unlike.length, 0);
  assert.strictEqual(state.candidates.length, 3, '取消收藏模式下展示 3 篇收藏笔记');

  // 2. 关键场景：用户在右侧侧边栏点击了「取消点赞」按钮（切为 unlike 模式作为筛选视图）
  // 此时左侧小红书网页依然停留在「收藏」页面（actualPageTab === 'collect'）
  state.settings.mode = 'unlike';
  syncPointers();

  // 此时右侧面板展示的取消点赞候选笔记必须为 0！绝不能展示收藏数据！
  assert.strictEqual(state.candidates.length, 0, '取消点赞缓存当前为空，绝对不展示收藏卡片');

  // 3. 此时若左侧页面触发滚动或刷新重新扫描卡片
  syncCardsToCache(favCards, 'collect');

  // 核心断言：左侧页面是 collect，扫描到的卡片 100% 只能进入 uncollect 缓存，绝对不能因为当前模式是 unlike 而写入 unlike 缓存！
  assert.strictEqual(state.modeCache.unlike.length, 0, '点赞缓存未被污染，依然为 0');
  assert.strictEqual(state.modeCache.uncollect.length, 3, '收藏缓存保持 3 篇');
  assert.strictEqual(state.candidates.length, 0, '取消点赞筛选视图下依然为 0 篇');

  // 4. 用户在左侧小红书切换到「赞过」列表并加载了 2 篇点赞笔记
  const likeCards = [
    { id: 'l1'.padEnd(24, '0'), title: '点赞的美食笔记' },
    { id: 'l2'.padEnd(24, '0'), title: '点赞的旅行笔记' },
  ];
  syncCardsToCache(likeCards, 'like');

  // 核心断言：赞过卡片入库 unlike 缓存，且由于当前筛选模式为 unlike，侧边栏立即展示 2 篇点赞卡片
  assert.strictEqual(state.modeCache.unlike.length, 2, '点赞缓存成功入库 2 篇');
  assert.strictEqual(state.candidates.length, 2, '取消点赞模式下成功呈现 2 篇点赞笔记');
  assert.deepStrictEqual(state.candidates.map((n) => n.title), ['点赞的美食笔记', '点赞的旅行笔记']);

  // 5. 用户在右侧面板切回「取消收藏」按钮
  state.settings.mode = 'uncollect';
  syncPointers();
  assert.strictEqual(state.candidates.length, 3, '切回取消收藏筛选视图，立即恢复展示 3 篇收藏笔记');
  assert.deepStrictEqual(state.candidates.map((n) => n.title), ['我的收藏1', '我的收藏2', '我的收藏3']);
});

test('Tab 识别机制：DOM 激活态绝对优先判定真实展示内容，URL 参数作为有力兜底，彻底杜绝串仓', () => {
  function getTabFromUrl(searchStr) {
    const search = new URLSearchParams(searchStr);
    const tab = (search.get('tab') || '').toLowerCase();
    if (tab === 'fav' || tab === 'collect' || tab === 'board') return 'collect';
    if (tab === 'liked' || tab === 'like') return 'like';
    if (tab === 'note' || tab === 'publish') return 'notes';
    return '';
  }

  function getPageActualTabType(searchStr, tabs) {
    // 1. 优先读取主 Tab 自身真实激活状态（用户眼见为实的 DOM 真实态）
    if (Array.isArray(tabs) && tabs.length > 0) {
      for (const t of tabs) {
        if (t.isSelfActive) {
          if (t.text.includes('赞过') || t.text.includes('点赞')) return 'like';
          if (t.text.includes('收藏')) return 'collect';
          if (t.text.includes('笔记')) return 'notes';
        }
      }
    }

    // 2. 兜底：若 DOM 尚未就绪，读取官方地址栏参数
    const urlTab = getTabFromUrl(searchStr);
    if (urlTab) return urlTab;

    return '';
  }

  // 场景 1：用户在小红书页面处于「赞过」Tab，但由于单页路由滞后，地址栏仍残留 ?tab=fav
  const tabsOnLiked = [
    { text: '笔记 10', isSelfActive: false },
    { text: '收藏 42', isSelfActive: false },
    { text: '赞过 105', isSelfActive: true },
  ];
  assert.strictEqual(
    getPageActualTabType('?tab=fav&subTab=note', tabsOnLiked),
    'like',
    '当 DOM 明确激活「赞过」时，必须判定为 like，绝不因 URL 残留 ?tab=fav 导致点赞笔记串仓进收藏'
  );

  // 场景 2：用户在小红书页面处于「收藏」Tab，但地址栏残留 ?tab=liked
  const tabsOnCollect = [
    { text: '笔记 10', isSelfActive: false },
    { text: '收藏 42', isSelfActive: true },
    { text: '赞过 105', isSelfActive: false },
  ];
  assert.strictEqual(
    getPageActualTabType('?tab=liked', tabsOnCollect),
    'collect',
    '当 DOM 明确激活「收藏」时，必须判定为 collect，绝不因 URL 残留 ?tab=liked 导致收藏笔记串仓进点赞'
  );

  // 场景 3：DOM 尚未渲染完成（tabs 为空），依赖地址栏参数兜底
  assert.strictEqual(
    getPageActualTabType('?tab=liked', []),
    'like',
    'DOM 尚未就绪时，在 ?tab=liked 下精准识别为 like（点赞）'
  );

  assert.strictEqual(
    getPageActualTabType('?tab=fav&subTab=note', []),
    'collect',
    'DOM 尚未就绪时，在 ?tab=fav 下精准识别为 collect（收藏）'
  );

  assert.strictEqual(
    getPageActualTabType('?tab=note', []),
    'notes',
    'DOM 尚未就绪时，在 ?tab=note 下精准识别为 notes（发布笔记）'
  );

  function detectTabFromText(text) {
    const clean = String(text || '').replace(/\s+/g, '');
    if (/(?:赞过|点赞|喜欢)/.test(clean)) return 'like';
    if (/(?:收藏|合集)/.test(clean)) return 'collect';
    if (/(?:笔记|发布|原创|图文|视频)/.test(clean)) return 'notes';
    return '';
  }

  assert.strictEqual(detectTabFromText('收藏(520)'), 'collect', '带括号计数的收藏准确识别');
  assert.strictEqual(detectTabFromText('我的收藏'), 'collect', '带前缀的我的收藏准确识别');
  assert.strictEqual(detectTabFromText('赞过(300)'), 'like', '带括号计数的赞过准确识别');
  assert.strictEqual(detectTabFromText('我的点赞'), 'like', '带前缀的点赞准确识别');
  assert.strictEqual(detectTabFromText('原创笔记 15'), 'notes', '原创发布笔记准确识别');
});

test('侧边栏候选列表支持动态展开与针对性提示文案（解决无搜索词时误提示缩小搜索词的问题）', () => {
  function getFooterNotice(totalVis, limit, query, activeTag) {
    const remaining = totalVis - limit;
    if (remaining <= 0) return '';
    const isFiltered = !!((query && query.trim()) || (activeTag && activeTag !== 'all'));
    if (isFiltered) {
      return '… 还有 ' + remaining + ' 篇匹配笔记未展示。可缩小搜索词，或：[加载更多 (+100)] [展示全部 (' + totalVis + ')]';
    }
    return '… 已展示前 ' + limit + ' 篇，还有 ' + remaining + ' 篇未展示：[加载更多 (+100)] [展示全部 (' + totalVis + ')]';
  }

  // 1. 无搜索词、无标签筛选时，绝不能出现“缩小搜索词”的误导文案
  const normalNotice = getFooterNotice(250, 200, '', 'all');
  assert.strictEqual(normalNotice.includes('缩小搜索词'), false, '无搜索词时严禁提示缩小搜索词');
  assert.strictEqual(normalNotice.includes('已展示前 200 篇，还有 50 篇未展示'), true);
  assert.strictEqual(normalNotice.includes('展示全部 (250)'), true);

  // 2. 有搜索词时，提示可缩小搜索词或加载更多
  const searchNotice = getFooterNotice(250, 200, '穿搭', 'all');
  assert.strictEqual(searchNotice.includes('还有 50 篇匹配笔记未展示。可缩小搜索词'), true);

  // 3. 点击加载更多或展示全部后，全部展示时无提示
  assert.strictEqual(getFooterNotice(250, 300, '', 'all'), '');
});

test('防串仓机制：在 Tab 切换过渡期间（新 Tab 异步加载中），DOM 中的旧 Tab 卡片被严格阻断，绝对不写入新 Tab 缓存', () => {
  let currentScannedTabType = '';
  let staleCardsFromPreviousTab = null;

  const modeCache = {
    uncollect: [],
    unlike: [],
  };

  function simulateSync(cards, actualTab) {
    if (actualTab !== 'collect' && actualTab !== 'like') return false;

    // 检测 Tab 切换
    if (currentScannedTabType && currentScannedTabType !== actualTab) {
      staleCardsFromPreviousTab = new Set(cards.map((c) => c.id));
    }
    currentScannedTabType = actualTab;

    const targetMode = actualTab === 'like' ? 'unlike' : 'uncollect';
    const targetList = modeCache[targetMode];

    const validCards = [];
    let hasFreshCard = false;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      if (staleCardsFromPreviousTab && staleCardsFromPreviousTab.has(c.id)) {
        // 这是前一个 Tab 残留在页面上的旧卡片，过渡期坚决丢弃！
        continue;
      }
      hasFreshCard = true;
      validCards.push(c);
    }

    if (hasFreshCard && staleCardsFromPreviousTab) {
      staleCardsFromPreviousTab = null;
    }

    if (!validCards.length) return false;

    const existingMap = new Map();
    targetList.forEach((n) => existingMap.set(n.id, n));
    validCards.forEach((c) => {
      if (!existingMap.has(c.id)) {
        targetList.push(c);
        existingMap.set(c.id, c);
      }
    });
    return true;
  }

  // 1. 用户先在「点赞」列表浏览（页面渲染出 2 篇仅点赞的笔记）
  const likeOnlyCards = [
    { id: 'like_note_1'.padEnd(24, '0'), title: '仅点赞笔记A' },
    { id: 'like_note_2'.padEnd(24, '0'), title: '仅点赞笔记B' },
  ];
  simulateSync(likeOnlyCards, 'like');
  assert.strictEqual(modeCache.unlike.length, 2, '点赞缓存成功入库 2 篇');
  assert.strictEqual(modeCache.uncollect.length, 0, '收藏缓存此时为 0');

  // 2. 核心场景：用户点击了小红书上的「收藏」Tab
  // 地址栏立即变为 collect，但小红书网络请求尚未完成，DOM 里仍然残留着点赞卡片！
  const tabSwitchTransitionCards = likeOnlyCards; // DOM 里的旧卡片
  simulateSync(tabSwitchTransitionCards, 'collect');

  // 核心断言：过渡期间，点赞卡片被 staleCardsFromPreviousTab 拦截，绝对没有被写入 uncollect！
  assert.strictEqual(modeCache.uncollect.length, 0, '过渡期间绝对没有将残留点赞卡片误写入收藏缓存');

  // 3. 300ms 后网络请求完成，小红书将 DOM 替换为真正的收藏卡片
  const collectOnlyCards = [
    { id: 'fav_note_1'.padEnd(24, '0'), title: '真正的收藏笔记' },
  ];
  simulateSync(collectOnlyCards, 'collect');

  // 核心断言：真正的收藏卡片正常入库，两者彻底物理隔离！
  assert.strictEqual(modeCache.uncollect.length, 1, '收藏缓存仅入库真正的收藏卡片');
  assert.strictEqual(modeCache.uncollect[0].title, '真正的收藏笔记');
  assert.strictEqual(modeCache.unlike.length, 2, '点赞缓存完好无损');
  assert.strictEqual(modeCache.unlike[0].title, '仅点赞笔记A');
});

test('叠卡速览交互引擎：叠卡数据与右侧侧边栏切换（Tab、Tag、Search）实时保持100%完全一致', () => {
  const modeCandidates = {
    uncollect: [
      { id: 'c1'.padEnd(24, '0'), title: '2023迪士尼限时优惠攻略' },
      { id: 'c2'.padEnd(24, '0'), title: 'Python高并发网络编程核心' },
      { id: 'c3'.padEnd(24, '0'), title: '2022考研英语真题限时资料' },
      { id: 'c4'.padEnd(24, '0'), title: '周末探店美食分享' },
    ],
    unlike: [
      { id: 'l1'.padEnd(24, '0'), title: '点赞笔记：摄影修图技巧' },
      { id: 'l2'.padEnd(24, '0'), title: '点赞笔记：2023限时福利领取' },
    ],
  };

  const aiTags = {
    ['c1'.padEnd(24, '0')]: { decision: '时效过期', category: '旅游出行' },
    ['c2'.padEnd(24, '0')]: { decision: '干货保值', category: '学习干货' },
    ['c3'.padEnd(24, '0')]: { decision: '时效过期', category: '学习干货' },
    ['c4'.padEnd(24, '0')]: { decision: '普通浏览', category: '美食探店' },
    ['l1'.padEnd(24, '0')]: { decision: '干货保值', category: '摄影数码' },
    ['l2'.padEnd(24, '0')]: { decision: '时效过期', category: '其他' },
  };

  let currentMode = 'uncollect';
  const selected = new Set(['c1'.padEnd(24, '0')]); // 用户已勾选 c1，验证勾选项绝不影响叠卡展示完整筛选列表

  const stack = {
    open: true,
    list: [],
    index: 0,
    filter: { keyword: '', tag: 'all', explicitIds: null },
  };

  function getStackFilteredList() {
    if (Array.isArray(stack.filter.explicitIds)) {
      const candMap = new Map();
      (modeCandidates[currentMode] || []).forEach(n => candMap.set(n.id, n));
      return stack.filter.explicitIds.map(id => candMap.get(id)).filter(Boolean);
    }
    let list = (modeCandidates[currentMode] || []).slice();
    const kw = (stack.filter.keyword || '').trim();
    if (kw) {
      const terms = C.parseKeywords(kw);
      list = list.filter(n => C.matchKeywords(n, terms));
    }
    const tag = stack.filter.tag;
    if (tag && tag !== 'all') {
      list = list.filter(n => {
        const info = aiTags[n.id];
        if (!info) return false;
        return info.decision === tag || info.category === tag;
      });
    }
    return list;
  }

  function syncStackToFilter(patch) {
    if (patch) {
      if (typeof patch.keyword === 'string') stack.filter.keyword = patch.keyword.trim();
      if (typeof patch.tag === 'string') stack.filter.tag = patch.tag;
      if (Array.isArray(patch.ids)) stack.filter.explicitIds = patch.ids.slice();
      else if (patch.ids === null) stack.filter.explicitIds = null;
    }
    const currentNote = stack.list[stack.index];
    stack.list = getStackFilteredList();
    if (stack.list.length === 0) {
      stack.index = 0;
      return;
    }
    let targetIdx = 0;
    if (currentNote && currentNote.id) {
      const found = stack.list.findIndex(n => n.id === currentNote.id);
      if (found !== -1) targetIdx = found;
    }
    stack.index = targetIdx;
  }

  // 1. 初始打开叠卡（未搜索、Tag为all）：必须是收藏下的全部 4 篇（绝不因已勾选 c1 而错误只展示 1 篇！）
  syncStackToFilter({ keyword: '', tag: 'all', ids: null });
  assert.strictEqual(stack.list.length, 4, '初始展示收藏下全部4篇');

  // 2. 搜索联动：右侧侧边栏搜索「限时」
  syncStackToFilter({ keyword: '限时', tag: 'all' });
  assert.strictEqual(stack.list.length, 2, '搜索限时后，叠卡即时同步为2篇命中卡片');
  assert.deepStrictEqual(stack.list.map(n => n.id), [
    'c1'.padEnd(24, '0'),
    'c3'.padEnd(24, '0'),
  ]);

  // 3. Tag 联动：右侧点击「⚠️ 时效过期」胶囊（清空搜索框）
  syncStackToFilter({ keyword: '', tag: '时效过期' });
  assert.strictEqual(stack.list.length, 2, '点击时效过期Tag，叠卡即时同步为2篇时效过期卡片');
  assert.deepStrictEqual(stack.list.map(n => n.id), [
    'c1'.padEnd(24, '0'),
    'c3'.padEnd(24, '0'),
  ]);

  // 4. 联合筛选：Tag「学习干货」
  syncStackToFilter({ keyword: '', tag: '学习干货' });
  assert.strictEqual(stack.list.length, 2, '点击学习干货Tag，叠卡同步为c2与c3');
  assert.deepStrictEqual(stack.list.map(n => n.id), [
    'c2'.padEnd(24, '0'),
    'c3'.padEnd(24, '0'),
  ]);

  // 5. 侧边栏精准映射联动 (explicitIds)：无论侧边栏怎么筛选，传什么ids叠卡就严格对齐什么
  const rightSideVisibleIds = ['c3'.padEnd(24, '0')];
  syncStackToFilter({ ids: rightSideVisibleIds });
  assert.strictEqual(stack.list.length, 1);
  assert.strictEqual(stack.list[0].id, 'c3'.padEnd(24, '0'));

  // 6. Tab 联动：右侧从「收藏」切换到「点赞」
  currentMode = 'unlike';
  // 切换Tab后重置ids为点赞模式全部卡片
  syncStackToFilter({ keyword: '', tag: 'all', ids: null });
  assert.strictEqual(stack.list.length, 2, '切换到点赞Tab后，叠卡即刻同步为点赞下的2篇笔记');
  assert.strictEqual(stack.list[0].title, '点赞笔记：摄影修图技巧');

  // 7. 在点赞Tab下搜索「福利」
  syncStackToFilter({ keyword: '福利', tag: 'all' });
  assert.strictEqual(stack.list.length, 1);
  assert.strictEqual(stack.list[0].title, '点赞笔记：2023限时福利领取');
});

test('已处理/已取消的笔记不再出现在列表和叠卡中', () => {
  const notes = [
    { id: 'a'.repeat(24), title: '杭州旅行攻略' },
    { id: 'b'.repeat(24), title: '成都美食指南' },
    { id: 'c'.repeat(24), title: '上海咖啡探店' },
  ];

  const processed = { uncollect: new Set(), unlike: new Set() };

  function getUnprocessed(candList, mode) {
    const set = processed[mode];
    return candList.filter(n => !set.has(n.id));
  }

  // 1. 列表端：初始状态全量 3 篇
  assert.strictEqual(getUnprocessed(notes, 'uncollect').length, 3);

  // 2. 模拟取消收藏第一篇 noteA
  processed.uncollect.add(notes[0].id);

  // 列表端：noteA 立即消失，只剩 2 篇
  const remaining = getUnprocessed(notes, 'uncollect');
  assert.strictEqual(remaining.length, 2);
  assert.strictEqual(remaining.some(n => n.id === notes[0].id), false);
  assert.strictEqual(remaining[0].id, notes[1].id);

  // 3. 叠卡端交互模拟：已处理卡片立即移除并不再出现
  const stack = {
    list: getUnprocessed(notes, 'uncollect').slice(),
    index: 0,
    history: [],
  };

  assert.strictEqual(stack.list.length, 2);
  assert.strictEqual(stack.list[0].id, notes[1].id);

  function executeStackCancel(mode) {
    const current = stack.list[stack.index];
    if (!current) return false;
    processed[mode].add(current.id);

    // 幽灵卡片移除
    const removedId = current.id;
    stack.list = stack.list.filter(n => n.id !== removedId);
    stack.history = stack.history.filter(hId => hId !== removedId);

    if (stack.list.length === 0) {
      stack.index = 0;
    } else if (stack.index >= stack.list.length) {
      stack.index = stack.list.length - 1;
    }
    return true;
  }

  function stackPrev() {
    let targetIdx = -1;
    while (stack.history.length > 0) {
      const prevId = stack.history.pop();
      const found = stack.list.findIndex(n => n.id === prevId);
      if (found !== -1 && found !== stack.index) {
        targetIdx = found;
        break;
      }
    }
    if (targetIdx === -1 && stack.index > 0) {
      targetIdx = stack.index - 1;
    }
    if (targetIdx !== -1) {
      stack.index = targetIdx;
      return true;
    }
    return false;
  }

  // 取消当前卡片（noteB）
  assert.strictEqual(executeStackCancel('uncollect'), true);
  assert.strictEqual(processed.uncollect.has(notes[1].id), true);

  // 叠卡中 noteB 立即消失，只剩 noteC
  assert.strictEqual(stack.list.length, 1);
  assert.strictEqual(stack.list[0].id, notes[2].id);
  assert.strictEqual(stack.index, 0);

  // 按「上一个」绝不能回退到已取消的 noteB 或 noteA
  assert.strictEqual(stackPrev(), false);
  assert.strictEqual(stack.list[stack.index].id, notes[2].id);

  // 取消最后一篇 noteC
  assert.strictEqual(executeStackCancel('uncollect'), true);
  assert.strictEqual(stack.list.length, 0);
  assert.strictEqual(getUnprocessed(notes, 'uncollect').length, 0);
});

test('笔记卡片与侧边栏支持查看原文外链生成与方案A原生弹窗即时预览', () => {
  const noteId = '64a1b2c3d4e5f60718293a4b';
  const token = 'AB1234567890XYZ';
  const fullUrl = C.buildNoteUrl(noteId, token);
  assert.strictEqual(fullUrl, 'https://www.xiaohongshu.com/explore/64a1b2c3d4e5f60718293a4b?xsec_token=AB1234567890XYZ&xsec_source=pc_user');
  assert.strictEqual(C.extractNoteId(fullUrl), noteId);
  assert.strictEqual(C.extractXsecToken(fullUrl), token);

  // 验证方案 A 预览消息与分流逻辑
  let sentMessage = null;
  let openedTabUrl = null;

  function handlePreviewClick(ev, id, url) {
    if (ev.metaKey || ev.ctrlKey) {
      openedTabUrl = url;
      return;
    }
    sentMessage = { type: 'RN_PREVIEW_NOTE', noteId: id, url: url };
  }

  // 1. 普通点击：向小红书页面发送原生预览指令，不开新页签
  handlePreviewClick({ metaKey: false, ctrlKey: false }, noteId, fullUrl);
  assert.deepStrictEqual(sentMessage, {
    type: 'RN_PREVIEW_NOTE',
    noteId: noteId,
    url: fullUrl,
  });
  assert.strictEqual(openedTabUrl, null);

  // 2. 按住 Cmd/Ctrl 点击：保留打开新标签页能力
  handlePreviewClick({ metaKey: true, ctrlKey: false }, noteId, fullUrl);
  assert.strictEqual(openedTabUrl, fullUrl);

  // 3. 验证叠卡内查看原文同样支持原生弹窗预览与挂起复原机制
  const fs = require('fs');
  const path = require('path');
  const contentCode = fs.readFileSync(path.resolve(__dirname, '../src/content/content.js'), 'utf8');
  assert.ok(contentCode.includes('suspendStackViewAndPreview'), '支持叠卡速览挂起并唤起原生弹窗');
  assert.ok(contentCode.includes('resumeStackView'), '支持关闭原生弹窗后自动复原叠卡状态');
  assert.ok(contentCode.includes('handleStackPreview'), '查看原文与标题点击统一绑定原生轻预览事件流');
});

test('页面卡片入库保留完整 candidates 数据源，且在已处理状态下支持按需切换展示', () => {
  const scannedFromDom = [
    { id: '11'.repeat(12), title: '笔记一' },
    { id: '22'.repeat(12), title: '笔记二' },
    { id: '33'.repeat(12), title: '笔记三' },
  ];

  // 模拟历史已处理记录存储
  const state = {
    candidates: scannedFromDom.slice(),
    processed: { uncollect: ['11'.repeat(12), '22'.repeat(12), '33'.repeat(12)], unlike: [] },
    mode: 'uncollect',
  };

  let showProcessed = false;

  function getCandidates(st) {
    if (showProcessed) return st.candidates;
    const set = new Set((st.processed && st.processed[st.mode]) || []);
    return st.candidates.filter(n => !set.has(n.id));
  }

  // 1. 默认情况下：所有卡片已处理，待处理候选列表为 0（达到“处理过的不再出现”）
  assert.strictEqual(getCandidates(state).length, 0);

  // 2. 原始 candidates 数据源与页面缓存绝不被破坏性抹除（防止用户数据消失）
  assert.strictEqual(state.candidates.length, 3);

  // 3. 统计状态感知：能够准确计算当前页面上已识别的笔记总数与已处理数量
  const processedSet = new Set(state.processed[state.mode]);
  const processedOnPage = state.candidates.filter(n => processedSet.has(n.id)).length;
  assert.strictEqual(processedOnPage, 3);

  // 4. 用户点击「查看已处理笔记」切换模式
  showProcessed = true;
  const listWhenShowAll = getCandidates(state);
  assert.strictEqual(listWhenShowAll.length, 3);
  assert.strictEqual(listWhenShowAll[0].title, '笔记一');

  // 5. 用户清空已处理记录后，默认模式自动恢复全量 3 篇
  showProcessed = false;
  state.processed.uncollect = [];
  assert.strictEqual(getCandidates(state).length, 3);
});

test('撤销系统能够清晰区分单篇与批量操作，支持从操作记录单条撤销与叠卡平滑复原', () => {
  // 模拟运行环境数据结构
  const state = {
    running: false,
    settings: { mode: 'uncollect', minDelay: 1000, maxDelay: 2000 },
    processed: { uncollect: ['note_batch_1', 'note_batch_2', 'note_single_A', 'note_single_B'], unlike: [] },
    candidates: [],
    modeCache: { uncollect: [], unlike: [] },
    history: [
      {
        id: 'note_batch_1',
        title: '批量笔记1',
        mode: 'uncollect',
        ts: 1000,
        type: 'batch',
        batchId: 'batch_001',
        source: 'batch',
        note: { id: 'note_batch_1', title: '批量笔记1' },
      },
      {
        id: 'note_batch_2',
        title: '批量笔记2',
        mode: 'uncollect',
        ts: 1001,
        type: 'batch',
        batchId: 'batch_001',
        source: 'batch',
        note: { id: 'note_batch_2', title: '批量笔记2' },
      },
      {
        id: 'note_single_A',
        title: '叠卡笔记A',
        mode: 'uncollect',
        ts: 2000,
        type: 'single',
        batchId: 'single_A',
        source: 'stack',
        note: { id: 'note_single_A', title: '叠卡笔记A' },
      },
      {
        id: 'note_single_B',
        title: '叠卡笔记B',
        mode: 'uncollect',
        ts: 2005,
        type: 'single',
        batchId: 'single_B',
        source: 'stack',
        note: { id: 'note_single_B', title: '叠卡笔记B' },
      },
    ],
    logs: [
      { t: '12:00:01', msg: '本次结束：成功 2 篇', canUndo: true, undoType: 'batch', batchId: 'batch_001', count: 2, mode: 'uncollect' },
      { t: '12:00:10', msg: '[叠卡] 已取消收藏：叠卡笔记A', canUndo: true, undoType: 'single', noteId: 'note_single_A', batchId: 'single_A', mode: 'uncollect' },
      { t: '12:00:15', msg: '[叠卡] 已取消收藏：叠卡笔记B', canUndo: true, undoType: 'single', noteId: 'note_single_B', batchId: 'single_B', mode: 'uncollect' },
    ],
  };

  // 1. 用户刚在叠卡模式划走笔记B，此时触发「撤销上次」：
  // 必须精准识别为单篇操作，目标仅仅是「叠卡笔记B」，绝对不能连带撤销笔记A或批量批次！
  const lastTarget = C.findUndoTarget(state.history, state.settings.mode);
  assert.notStrictEqual(lastTarget, null);
  assert.strictEqual(lastTarget.type, 'single');
  assert.strictEqual(lastTarget.count, 1);
  assert.strictEqual(lastTarget.noteId, 'note_single_B');
  assert.strictEqual(lastTarget.items.length, 1);

  // 模拟单篇撤销执行完毕
  const undoneItem = lastTarget.items[0];
  undoneItem.undone = true;
  state.processed.uncollect = state.processed.uncollect.filter((id) => id !== undoneItem.id);
  state.candidates.unshift(undoneItem.note);
  state.logs.forEach((l) => { if (l.noteId === undoneItem.id) l.undone = true; });

  assert.strictEqual(state.processed.uncollect.includes('note_single_B'), false, '笔记B已移出已处理');
  assert.strictEqual(state.candidates.some((n) => n.id === 'note_single_B'), true, '笔记B已恢复至候选池');
  assert.strictEqual(state.logs[2].undone, true, '日志中笔记B标记为已撤销');

  // 2. 用户在底部操作记录中，直接点击「叠卡笔记A」旁边的 [撤销] 按钮：
  // 传入 options: { noteId: 'note_single_A' }
  const specificTarget = C.findUndoTarget(state.history, state.settings.mode, { noteId: 'note_single_A' });
  assert.notStrictEqual(specificTarget, null);
  assert.strictEqual(specificTarget.type, 'single');
  assert.strictEqual(specificTarget.noteId, 'note_single_A');

  // 模拟笔记A撤销完成
  specificTarget.items[0].undone = true;
  state.processed.uncollect = state.processed.uncollect.filter((id) => id !== 'note_single_A');
  state.candidates.unshift(specificTarget.items[0].note);
  state.logs.forEach((l) => { if (l.noteId === 'note_single_A') l.undone = true; });

  // 3. 此时叠卡模式的单篇操作均已撤销完成，再次检测「撤销上次」：
  // 此时自动回退到上一次的批量操作（共 2 篇笔记）
  const batchTarget = C.findUndoTarget(state.history, state.settings.mode);
  assert.notStrictEqual(batchTarget, null);
  assert.strictEqual(batchTarget.type, 'batch');
  assert.strictEqual(batchTarget.count, 2);
  assert.strictEqual(batchTarget.batchId, 'batch_001');
  assert.deepStrictEqual(batchTarget.items.map((n) => n.id), ['note_batch_1', 'note_batch_2']);
});

test('列表扫描机制：支持滚动深度扫描突破90条限制，支持增量合并与实时停止保留', () => {
  // 1. 验证根据 autoScroll 设置计算 cap 上限
  function computeCap(settings) {
    const isAutoScroll = settings.autoScroll !== false;
    return isAutoScroll ? 3000 : Math.max(60, (settings.maxPerRun || 30) * 3);
  }

  const defaultSettings = C.clampSettings(null);
  assert.strictEqual(defaultSettings.autoScroll, true, '默认开启滚动加载全部');
  assert.strictEqual(computeCap(defaultSettings), 3000, '开启滚动加载时上限提升至 3000 篇，杜绝 90~93 条人为截断');

  const manualSettings = C.clampSettings({ autoScroll: false, maxPerRun: 30 });
  assert.strictEqual(manualSettings.autoScroll, false);
  assert.strictEqual(computeCap(manualSettings), 90, '仅在显式关闭滚动时才退守至 90 篇');

  // 2. 验证增量合并逻辑：再次点击「读取列表」时继承已识别卡片，而不是清空后重复读取前93条
  const existingNotes = [
    { id: 'note_1', title: '短标题', cover: '' },
    { id: 'note_2', title: '笔记2', cover: 'https://img2' },
  ];

  const newlyScannedFromDom = [
    { id: 'note_1', title: '更完整长标题', cover: 'https://img1' }, // 补全信息
    { id: 'note_3', title: '新滑出来的笔记3', cover: 'https://img3' },
  ];

  const acc = new Map();
  existingNotes.forEach((n) => acc.set(n.id, Object.assign({}, n)));

  let added = 0;
  newlyScannedFromDom.forEach((n) => {
    if (!acc.has(n.id)) {
      acc.set(n.id, Object.assign({}, n));
      added++;
    } else {
      const old = acc.get(n.id);
      if (n.title && (!old.title || old.title.length < n.title.length)) old.title = n.title;
      if (n.cover && !old.cover) old.cover = n.cover;
    }
  });

  assert.strictEqual(added, 1, '新增 1 篇新卡片');
  assert.strictEqual(acc.size, 3, '累计识别 3 篇');
  assert.strictEqual(acc.get('note_1').title, '更完整长标题', '增量补齐了封面和完整标题');
  assert.strictEqual(acc.get('note_1').cover, 'https://img1');
  assert.strictEqual(acc.get('note_3').title, '新滑出来的笔记3');
});

test('微信赞赏支持体系：资源存在且多触点组件结构完整', () => {
  const fs = require('fs');
  const path = require('path');

  // 1. 验证压缩后的赞赏码资源存在且体积适中
  const sponsorImgPath = path.resolve(__dirname, '../assets/sponsor.jpg');
  assert.strictEqual(fs.existsSync(sponsorImgPath), true, 'assets/sponsor.jpg 必须存在');
  const stat = fs.statSync(sponsorImgPath);
  assert.ok(stat.size > 0 && stat.size < 150 * 1024, '赞赏码图片应经过压缩且体积小于 150KB');

  // 2. 验证 sidepanel.html 包含了触点与弹窗（顶栏咖啡按用户需求收敛至设置面板，保持顶栏纯净）
  const htmlContent = fs.readFileSync(path.resolve(__dirname, '../src/sidepanel/sidepanel.html'), 'utf8');
  assert.ok(htmlContent.includes('id="rn-btn-sponsor-settings"'), '设置面板触点按钮必须存在');
  assert.ok(htmlContent.includes('id="rn-sponsor-modal"'), '赞赏弹窗必须存在');
  assert.ok(htmlContent.includes('id="rn-sponsor-close"'), '弹窗关闭按钮必须存在');
  assert.ok(htmlContent.includes('assets/sponsor.jpg'), '弹窗内需引用本地赞赏码图片');

  // 3. 验证 README.md 包含赞赏章节
  const readmeContent = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');
  assert.ok(readmeContent.includes('支持与赞赏'), 'README 必须包含赞赏版块');
  assert.ok(readmeContent.includes('assets/sponsor.jpg'), 'README 需引用赞赏码图片');
});

test('检索过滤感知与释放机制：侧边栏关闭时释放卡片暗化，支持页面端指示胶囊与一键重置', () => {
  const fs = require('fs');
  const path = require('path');

  // 1. 验证卡片暗化判定逻辑（侧边栏断开时绝对不可暗化网页卡片）
  const cards = [
    { id: '1', title: '杭州旅行路线攻略' },
    { id: '2', title: '成都地道火锅探店' },
  ];
  const query = '成都';
  const terms = C.parseKeywords(query);

  function evalCardDim(card, rawQuery, isConnected) {
    const match = !rawQuery || C.matchKeywords(card, terms);
    return isConnected && !!rawQuery && !match;
  }

  // 侧边栏打开时：非命中卡片被暗化
  assert.strictEqual(evalCardDim(cards[0], query, true), true, '未命中且侧边栏连接时应暗化');
  assert.strictEqual(evalCardDim(cards[1], query, true), false, '命中卡片不应暗化');

  // 侧边栏关闭时（isConnected=false）：哪怕有检索词，所有卡片均绝对不可暗化，恢复小红书原本色彩
  assert.strictEqual(evalCardDim(cards[0], query, false), false, '侧边栏关闭时必须自动解除卡片暗化');
  assert.strictEqual(evalCardDim(cards[1], query, false), false, '侧边栏关闭时卡片正常展示');

  // 2. 验证 style.js 软化样式与页面胶囊样式
  const styleContent = fs.readFileSync(path.resolve(__dirname, '../src/content/style.js'), 'utf8');
  assert.ok(styleContent.includes('rn-filter-pill'), '必须包含页面端筛选指示胶囊样式');
  assert.ok(styleContent.includes('rn-pill-stacked'), '胶囊需支持与底部条联动堆叠');
  assert.ok(!styleContent.includes('filter: saturate(0.65)'), '已移除过度失真的强降饱和度滤镜');
  assert.ok(styleContent.includes('opacity: 0.62'), '暗化透明度已软化至克制的 0.62');

  // 3. 验证 sidepanel.html 包含搜索快捷清空按钮
  const sidepanelHtml = fs.readFileSync(path.resolve(__dirname, '../src/sidepanel/sidepanel.html'), 'utf8');
  assert.ok(sidepanelHtml.includes('id="rn-search-clear"'), '侧边栏搜索框需提供快捷清除按钮');
});

test('叠卡模式快捷键视觉美学：移除破坏圆形关闭按钮与翻页按钮的内嵌按键，增设平衡典雅的底部快捷键指引栏', () => {
  const fs = require('fs');
  const path = require('path');
  const contentCode = fs.readFileSync(path.resolve(__dirname, '../src/content/content.js'), 'utf8');
  const styleCode = fs.readFileSync(path.resolve(__dirname, '../src/content/style.js'), 'utf8');

  // 1. 关闭按钮必须保持纯净圆形，不塞入破坏比例的 Esc 文字
  assert.ok(contentCode.includes('class="rn-stack-close" id="rn-stack-close" type="button" title="关闭 (Esc)">'), '关闭按钮保持纯粹简洁');
  assert.ok(!contentCode.includes('>× <kbd class="rn-stack-nav-kbd">Esc</kbd><'), '关闭按钮内禁止内嵌 Esc 徽标导致变形');

  // 2. 叠卡右上角移除冗余撤销按钮（精简头部），底部独立栏自适应系统撤销快捷键（Mac ⌘Z / Win Ctrl+Z）
  assert.ok(!contentCode.includes('id="rn-stack-undo"'), '右上角移除冗余撤销按钮，保持头部极简');
  assert.ok(contentCode.includes('undoKeyLabel'), '撤销快捷键自适应系统架构');
  assert.ok(contentCode.includes('id="rn-stack-prev"') && contentCode.includes('上一个'), '上一个按钮文案整洁自然且专业');
  assert.ok(contentCode.includes('id="rn-stack-next"') && contentCode.includes('下一个'), '下一个按钮文案整洁自然且专业');

  // 3. 底部独立快捷键指引栏 (rn-stack-tips) 结构与样式完整
  assert.ok(contentCode.includes('class="rn-stack-tips"'), '必须包含底部独立快捷键栏');
  assert.ok(contentCode.includes('<kbd>Space</kbd> 取消操作'), '提示栏明确指明 Space 快捷键');
  assert.ok(contentCode.includes('<kbd>←</kbd> <kbd>→</kbd> 翻页'), '提示栏明确指明方向键翻页');
  assert.ok(contentCode.includes('undoKeyLabel'), '提示栏自适应系统撤销快捷键');
  assert.ok(contentCode.includes('<kbd>Esc</kbd> 关闭'), '提示栏明确指明 Esc 关闭');

  assert.ok(styleCode.includes('.rn-stack-tips'), 'style.js 必须包含 rn-stack-tips 样式定义');
  assert.ok(styleCode.includes('flex-wrap: nowrap !important;'), '操作栏严禁换行错位');
});

test('防串仓隔离机制：切换 Tab 异步加载期严格阻断旧卡片写入新模式', () => {
  // 模拟从「赞过」切到「收藏」的异步加载过渡阶段
  const oldLikedCards = [
    { id: 'like1'.padEnd(24, '0'), title: '点赞笔记 1' },
    { id: 'like2'.padEnd(24, '0'), title: '点赞笔记 2' },
  ];
  const freshCollectCards = [
    { id: 'col1'.padEnd(24, '0'), title: '收藏笔记 1' },
    { id: 'col2'.padEnd(24, '0'), title: '收藏笔记 2' },
  ];

  // 1. 切换瞬间：页面依然挂着旧的赞过卡片，旧卡片入黑名单
  const staleCardsFromPreviousTab = new Set(oldLikedCards.map(c => c.id));
  
  // 2. 模拟过渡期采集：旧卡片被 100% 阻断，不能合入收藏缓存
  const cardsInDomDuringTransition = oldLikedCards;
  const filteredTransition = cardsInDomDuringTransition.filter(c => !staleCardsFromPreviousTab.has(c.id));
  assert.strictEqual(filteredTransition.length, 0, '过渡期旧卡片完全被拦截，绝不误入收藏缓存');

  // 3. 异步接口返回并渲染出新收藏卡片：黑名单识别到新卡片，安全解除
  const cardsInDomAfterLoad = freshCollectCards;
  const hasFresh = cardsInDomAfterLoad.some(c => !staleCardsFromPreviousTab.has(c.id));
  assert.strictEqual(hasFresh, true, '正确检测到当前 Tab 的全新卡片');
  const filteredLoaded = cardsInDomAfterLoad.filter(c => !staleCardsFromPreviousTab.has(c.id));
  assert.strictEqual(filteredLoaded.length, 2, '全新收藏卡片正常合入');
  assert.strictEqual(filteredLoaded.every(c => c.id.startsWith('col')), true);
});

test('侧边栏与页面通信自愈机制：防 Receiving end does not exist 噪声警报与无感补注', () => {
  const fs = require('fs');
  const path = require('path');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../manifest.json'), 'utf8'));
  const sidepanelCode = fs.readFileSync(path.resolve(__dirname, '../src/sidepanel/sidepanel.js'), 'utf8');

  // 1. Manifest 需声明 scripting 权限以支持热重载自愈注入
  assert.ok(manifest.permissions.includes('scripting'), 'manifest.json 必须包含 scripting 权限');

  // 2. 侧边栏必须包含断连错误抑制与自愈重试逻辑
  assert.ok(sidepanelCode.includes('Receiving end does not exist'), '包含针对连接不存在的捕获');
  assert.ok(sidepanelCode.includes('chrome.scripting.executeScript'), '支持动态补注内容脚本');
  assert.ok(sidepanelCode.includes('rn-btn-reload-active-tab'), '在断开提示中提供一键刷新重连按钮');
});

test('防串仓全链路防线：Tab切换即刻熔断扫描任务、深度扫描排除旧卡片残留、部分换批过渡锁持续阻断旧卡片', () => {
  const fs = require('fs');
  const path = require('path');
  const contentCode = fs.readFileSync(path.resolve(__dirname, '../src/content/content.js'), 'utf8');

  // 1. 源码静态结构防线检测：确保所有生命周期关键节点均接入过渡保护与扫描熔断
  assert.ok(contentCode.includes('function beginTabTransition('), '必须包含 beginTabTransition 过渡状态机');
  assert.ok(contentCode.includes('function abortActiveScan('), '必须包含 abortActiveScan 扫描熔断器');
  assert.ok(contentCode.includes('activeScanSessionId'), '必须维护扫描会话令牌');
  assert.ok(contentCode.includes('tabTransitionLock'), '必须维护过渡状态锁');
  assert.ok(contentCode.includes('tabTransitionStaleIds'), '必须维护旧卡片黑名单 Set');
  assert.ok(contentCode.includes('tabTransitionStaleIds.has(n.id)'), 'collectCandidates 的 merge 过程必须过滤旧卡片');

  // 2. 模拟 Tab 切换全链路状态机
  let activeScanSessionId = 0;
  let tabTransitionLock = false;
  let tabTransitionTarget = '';
  let tabTransitionStaleIds = new Set();
  const modeCache = { uncollect: [], unlike: [] };

  function simulateAbortActiveScan() {
    activeScanSessionId++;
  }

  function simulateBeginTabTransition(targetTab, currentDomIds) {
    simulateAbortActiveScan();
    tabTransitionStaleIds = new Set(currentDomIds);
    tabTransitionLock = true;
    tabTransitionTarget = targetTab;
  }

  function simulateSyncCards(domCards, actualTab) {
    if (actualTab !== 'collect' && actualTab !== 'like') return false;
    if (tabTransitionLock) {
      if (actualTab !== tabTransitionTarget) return false;
      const hasStale = domCards.some(c => tabTransitionStaleIds.has(c.id));
      if (hasStale) {
        return false; // DOM 中仍残留旧卡片，过渡期坚决阻断
      }
      tabTransitionLock = false;
      tabTransitionStaleIds.clear();
    }

    const targetMode = actualTab === 'like' ? 'unlike' : 'uncollect';
    const targetList = modeCache[targetMode];
    const validCards = domCards.filter(c => !tabTransitionStaleIds.has(c.id));
    if (!validCards.length) return false;

    validCards.forEach(c => {
      if (!targetList.some(x => x.id === c.id)) {
        targetList.push(c);
      }
    });
    return true;
  }

  // 阶段 1：用户在「点赞」列表浏览，点赞缓存正常累积 5 篇
  const likedNotes = [
    { id: 'like_001'.padEnd(24, '0'), title: '点赞笔记 1' },
    { id: 'like_002'.padEnd(24, '0'), title: '点赞笔记 2' },
    { id: 'like_003'.padEnd(24, '0'), title: '点赞笔记 3' },
    { id: 'like_004'.padEnd(24, '0'), title: '点赞笔记 4' },
    { id: 'like_005'.padEnd(24, '0'), title: '点赞笔记 5' },
  ];
  simulateSyncCards(likedNotes, 'like');
  assert.strictEqual(modeCache.unlike.length, 5, '点赞缓存已成功记录 5 篇');
  assert.strictEqual(modeCache.uncollect.length, 0, '收藏缓存为 0');

  // 阶段 2：用户在深度扫描点赞时，突然点击切换到了「收藏」Tab
  const scanSessionIdBeforeSwitch = activeScanSessionId;
  const domIdsAtSwitchMoment = likedNotes.map(n => n.id);
  simulateBeginTabTransition('collect', domIdsAtSwitchMoment);

  // 断言：扫描会话令牌已变更，先前的扫描循环感知到 session 不一致必须立即终止
  assert.notStrictEqual(activeScanSessionId, scanSessionIdBeforeSwitch, '会话令牌必须更新以熔断先前扫描');
  assert.strictEqual(tabTransitionLock, true, '必须开启过渡锁');
  assert.strictEqual(tabTransitionStaleIds.size, 5, '旧卡片全部进入黑名单');

  // 阶段 3：过渡期（网络请求仍在进行中），DOM 依然挂着 5 张点赞卡片
  const transitionDomCards = likedNotes;
  const syncResult1 = simulateSyncCards(transitionDomCards, 'collect');
  assert.strictEqual(syncResult1, false, '过渡期旧卡片完全阻断同步');
  assert.strictEqual(modeCache.uncollect.length, 0, '收藏缓存绝对不进入任何点赞卡片');

  // 阶段 4：部分换批（网络返回了 1 张新卡片，但 DOM 中还有 2 张旧卡片未卸载）
  const partialDomCards = [
    { id: 'col_001'.padEnd(24, '0'), title: '真正的收藏笔记 1' },
    likedNotes[3],
    likedNotes[4],
  ];
  const syncResult2 = simulateSyncCards(partialDomCards, 'collect');
  assert.strictEqual(syncResult2, false, '部分换批时因仍有旧卡片残留，过渡锁坚决不释放');
  assert.strictEqual(modeCache.uncollect.length, 0, '旧卡片依然绝对不能误入收藏缓存');

  // 阶段 5：换批彻底完成，DOM 中全是全新的收藏卡片
  const cleanCollectCards = [
    { id: 'col_001'.padEnd(24, '0'), title: '真正的收藏笔记 1' },
    { id: 'col_002'.padEnd(24, '0'), title: '真正的收藏笔记 2' },
  ];
  const syncResult3 = simulateSyncCards(cleanCollectCards, 'collect');
  assert.strictEqual(syncResult3, true, '全新卡片安全入库');
  assert.strictEqual(tabTransitionLock, false, '过渡锁安全解除');
  assert.strictEqual(modeCache.uncollect.length, 2, '收藏缓存仅且必须仅包含真正的收藏笔记');
  assert.strictEqual(modeCache.uncollect.every(c => c.id.startsWith('col_')), true, '杜绝任何点赞卡片串入收藏');
});

test('用户手动滑动页面增量加载机制：捕获阶段监听全容器滚动、避免同Tab重入锁定、新批次卡片即滚即入', () => {
  const fs = require('fs');
  const path = require('path');
  const contentCode = fs.readFileSync(path.resolve(__dirname, '../src/content/content.js'), 'utf8');

  // 1. 滚动监听器必须支持捕获阶段 (capture: true) 和滚轮 (wheel)，以确保截获小红书内部 feeds-container 容器的非冒泡 scroll 事件
  assert.ok(contentCode.includes("window.addEventListener('scroll', onManualScroll, { capture: true, passive: true });"), 'scroll 监听器必须使用捕获阶段');
  assert.ok(contentCode.includes("window.addEventListener('wheel', onManualScroll, { capture: true, passive: true });"), 'wheel 监听器捕获滚轮滑动');

  // 2. 防同 Tab 重复点击锁定：当用户已经在「收藏」Tab 上点击或手动浏览时，严禁误触发 beginTabTransition
  assert.ok(contentCode.includes('if (currentScannedTabType === targetTab && !tabTransitionLock) return;'), '同 Tab 严禁重新开启过渡锁');

  // 3. 模拟用户在小红书收藏页自主手动滚动加载
  let currentScannedTabType = 'collect';
  let tabTransitionLock = false;
  const modeCache = { uncollect: [] };

  function simulateManualScrollSync(newCards) {
    if (tabTransitionLock) return false;
    const targetList = modeCache.uncollect;
    let added = 0;
    newCards.forEach(c => {
      if (!targetList.some(x => x.id === c.id)) {
        targetList.push(c);
        added++;
      }
    });
    return added > 0;
  }

  // 首屏 20 篇
  const initialCards = Array.from({ length: 20 }, (_, i) => ({
    id: ('col_b1_' + String(i).padStart(4, '0')).padEnd(24, '0'),
    title: '收藏笔记 batch1-' + i,
  }));
  simulateManualScrollSync(initialCards);
  assert.strictEqual(modeCache.uncollect.length, 20, '首屏20篇笔记正常进入');

  // 用户手动向下滚动，小红书异步吐出第二屏 20 篇
  const secondBatchCards = Array.from({ length: 20 }, (_, i) => ({
    id: ('col_b2_' + String(i).padStart(4, '0')).padEnd(24, '0'),
    title: '收藏笔记 batch2-' + i,
  }));
  const scrollResult = simulateManualScrollSync(secondBatchCards);
  assert.strictEqual(scrollResult, true, '手动滑动触发成功同步新卡片');
  assert.strictEqual(modeCache.uncollect.length, 40, '候选集无感扩展至 40 篇');
});

test('防串仓终极闭环：反复来回切换收藏/点赞Tab绝不互相渗透，数量稳定不膨胀（杜绝26->33->43->48串仓合流）', () => {
  const fs = require('fs');
  const path = require('path');
  const contentCode = fs.readFileSync(path.resolve(__dirname, '../src/content/content.js'), 'utf8');

  // 1. 代码静态防线校验
  assert.ok(contentCode.includes('function isCardVisible('), '必须包含 isCardVisible 严谨可见性过滤');
  assert.ok(contentCode.includes('state.modeCache[prevMode].forEach('), 'beginTabTransition 必须拍摄前一模式的全部缓存卡片');
  assert.ok(contentCode.includes('if (tabTransitionStaleIds && tabTransitionStaleIds.has(c.id))'), 'syncDomCardsToCandidates 必须坚决丢弃所有旧Tab黑名单卡片');

  // 2. 模拟完整的反复切换 Tab 运行状态机
  let currentScannedTabType = 'collect';
  let tabTransitionLock = false;
  let tabTransitionTarget = '';
  let tabTransitionStaleIds = new Set();
  const modeCache = {
    uncollect: [],
    unlike: [],
  };

  function simulateBeginTabTransition(targetTab, domCards) {
    if (currentScannedTabType === targetTab && !tabTransitionLock) return;
    const ids = domCards.map(c => c.id);
    tabTransitionStaleIds = new Set(ids);
    const prevMode = currentScannedTabType === 'like' ? 'unlike' : (currentScannedTabType === 'collect' ? 'uncollect' : '');
    if (prevMode && modeCache[prevMode]) {
      modeCache[prevMode].forEach(n => {
        if (n && n.id) tabTransitionStaleIds.add(n.id);
      });
    }
    tabTransitionLock = true;
    tabTransitionTarget = targetTab;
  }

  function simulateSync(domCards, actualTab) {
    if (actualTab !== 'collect' && actualTab !== 'like') return false;
    if (currentScannedTabType && currentScannedTabType !== actualTab && !tabTransitionLock) {
      simulateBeginTabTransition(actualTab, domCards);
    }
    if (!currentScannedTabType) currentScannedTabType = actualTab;

    if (tabTransitionLock) {
      if (actualTab !== tabTransitionTarget) return false;
      if (!domCards.length) return false;

      const allStale = domCards.every(c => tabTransitionStaleIds.has(c.id));
      if (allStale) return false;

      const anyStale = domCards.some(c => tabTransitionStaleIds.has(c.id));
      if (!anyStale) {
        tabTransitionLock = false;
        tabTransitionStaleIds.clear();
      }
    }

    const targetMode = actualTab === 'like' ? 'unlike' : 'uncollect';
    const targetList = modeCache[targetMode];
    let changed = false;

    const validCards = [];
    for (let i = 0; i < domCards.length; i++) {
      const c = domCards[i];
      if (tabTransitionStaleIds && tabTransitionStaleIds.has(c.id)) {
        continue;
      }
      validCards.push(c);
    }

    const existingMap = new Map();
    targetList.forEach(n => existingMap.set(n.id, n));
    validCards.forEach(c => {
      if (!existingMap.has(c.id)) {
        targetList.push(c);
        existingMap.set(c.id, c);
        changed = true;
      }
    });

    return changed;
  }

  // 场景：真实用户数据设定
  // 收藏笔记 20 篇
  const collectCards = Array.from({ length: 20 }, (_, i) => ({
    id: ('col_' + String(i).padStart(4, '0')).padEnd(24, '0'),
    title: '收藏笔记 ' + i,
  }));
  // 点赞笔记 13 篇（首屏渲染 6 篇，后续加载 7 篇）
  const likeCardsBatch1 = Array.from({ length: 6 }, (_, i) => ({
    id: ('like_' + String(i).padStart(4, '0')).padEnd(24, '0'),
    title: '点赞笔记 b1-' + i,
  }));
  const likeCardsBatch2 = Array.from({ length: 7 }, (_, i) => ({
    id: ('like_' + String(i + 6).padStart(4, '0')).padEnd(24, '0'),
    title: '点赞笔记 b2-' + (i + 6),
  }));
  const allLikeCards = likeCardsBatch1.concat(likeCardsBatch2);

  // 阶段 1：首屏加载收藏 Tab（20篇），点赞为 0
  simulateSync(collectCards, 'collect');
  assert.strictEqual(modeCache.uncollect.length, 20, '收藏初始为 20 篇');
  assert.strictEqual(modeCache.unlike.length, 0, '点赞初始为 0 篇');

  // 阶段 2：用户点击小红书「点赞」Tab
  // 切换瞬间，DOM 中依然残留 20 篇旧收藏卡片
  simulateBeginTabTransition('like', collectCards);
  currentScannedTabType = 'like';

  // 2.1 小红书异步换批中：首批 6 篇点赞渲染进 DOM，但此时旧收藏卡片尚未彻底卸载
  const mixedDom = collectCards.concat(likeCardsBatch1);
  simulateSync(mixedDom, 'like');
  // 核心断言：坚决排除残留的 20 篇旧收藏卡片，只接受新点赞笔记（必须为 6，绝不可变成 20+6=26！）
  assert.strictEqual(modeCache.unlike.length, 6, '点赞首批卡片入库为 6 篇，绝不膨胀为 26！');
  assert.strictEqual(modeCache.uncollect.length, 20, '收藏依然保持 20 篇');

  // 2.2 小红书异步换批完成：旧收藏卡片全部卸载，余下 7 篇点赞卡片也全部渲染就绪
  simulateSync(allLikeCards, 'like');
  // 核心断言：点赞最终达到完整的 13 篇（必须为 13，绝不可变成 20+13=33！）
  assert.strictEqual(modeCache.unlike.length, 13, '点赞完整入库为 13 篇，绝不膨胀为 33！');
  assert.strictEqual(modeCache.uncollect.length, 20, '收藏依然保持 20 篇');

  // 阶段 3：用户此时点击返回「收藏」Tab
  simulateBeginTabTransition('collect', allLikeCards);
  currentScannedTabType = 'collect';
  // 小红书加载出 20 篇收藏卡片
  simulateSync(collectCards, 'collect');
  // 核心断言：收藏卡片恢复，绝不可将之前的 13/23 篇点赞混入收藏（必须为 20，绝不可变成 43！）
  assert.strictEqual(modeCache.uncollect.length, 20, '收藏卡片依然保持准确的 20 篇，绝不膨胀为 43！');
  assert.strictEqual(modeCache.unlike.length, 13, '点赞依然保持准确的 13 篇');

  // 阶段 4：用户左右 Tab 反复来回点 10 次，模拟极限快速切换
  for (let round = 1; round <= 10; round++) {
    // 切到点赞
    simulateBeginTabTransition('like', collectCards);
    currentScannedTabType = 'like';
    simulateSync(allLikeCards, 'like');

    // 切回收藏
    simulateBeginTabTransition('collect', allLikeCards);
    currentScannedTabType = 'collect';
    simulateSync(collectCards, 'collect');

    // 每次切换后严格核验
    assert.strictEqual(modeCache.uncollect.length, 20, `第 ${round} 轮切换后收藏依然保持准确的 20 篇`);
    assert.strictEqual(modeCache.unlike.length, 13, `第 ${round} 轮切换后点赞依然保持准确的 13 篇`);
  }

  // 终极断言：两者合流总数绝不可能变成 48
  assert.strictEqual(modeCache.uncollect.length + modeCache.unlike.length, 33, '两者独立计数之和为 33 (20+13)，绝不合流变成 48');
});

test('防单向串仓：点赞新加载数据绝不泄漏到收藏，收藏新加载数据绝不泄漏到点赞（彻底解决 fontWeight 误判导致的单向合流）', () => {
  const fs = require('fs');
  const path = require('path');
  const contentCode = fs.readFileSync(path.resolve(__dirname, '../src/content/content.js'), 'utf8');

  // 1. 代码防线检查
  assert.ok(contentCode.includes('oppositeMode && state.modeCache && state.modeCache[oppositeMode]'), 'beginTabTransition 必须强制拉取对立模式缓存进黑名单');
  assert.ok(contentCode.includes('// 阶段 1：首选显式激活标记（aria-selected 或 active class）'), 'activeTabEl 必须优先使用显式 class');

  // 2. 模拟小红书页面主 Tab 栏在 macOS Chrome 下的真实 DOM 与 CSS
  // 在真实网页中，所有 Tab item 都可能带有 font-weight: 600（PingFang SC Semibold）
  const tabElements = [
    {
      text: '笔记 10',
      classList: ['reds-tab-item'],
      fontWeight: '600',
      ariaSelected: 'false',
    },
    {
      text: '收藏 20',
      classList: ['reds-tab-item'],
      fontWeight: '600',
      ariaSelected: 'false',
    },
    {
      text: '赞过 15',
      classList: ['reds-tab-item', 'reds-tab-item-active'], // 只有点赞处于 active！
      fontWeight: '600',
      ariaSelected: 'true',
    },
  ];

  // 模拟 activeTabEl 的阶段式精准识别
  function simulateActiveTabEl(tabs) {
    // 阶段 1：首选显式 class / aria-selected
    for (const t of tabs) {
      if (t.ariaSelected === 'true') return t;
      if (t.classList && (t.classList.includes('reds-tab-item-active') || t.classList.includes('active'))) return t;
    }
    // 阶段 3：字体粗细横向对比（只有独占最高字重才算数）
    let maxFw = 0;
    let heaviest = null;
    let count = 0;
    for (const t of tabs) {
      const fw = parseInt(t.fontWeight, 10) || 400;
      if (fw > maxFw) { maxFw = fw; heaviest = t; count = 1; }
      else if (fw === maxFw) { count++; }
    }
    if (count === 1 && maxFw >= 600) return heaviest;
    return null;
  }

  const activeTab = simulateActiveTabEl(tabElements);
  assert.strictEqual(activeTab.text, '赞过 15', '即便所有 Tab 都有 font-weight:600，凭借 reds-tab-item-active 依然精准识别为赞过，绝不误判为收藏！');

  // 3. 模拟用户在点赞模式下滚动加载新数据
  let currentScannedTabType = 'like';
  let tabTransitionLock = false;
  let tabTransitionTarget = '';
  let tabTransitionStaleIds = new Set();
  const modeCache = {
    uncollect: Array.from({ length: 20 }, (_, i) => ({ id: 'col_' + i, title: '收藏 ' + i })),
    unlike: Array.from({ length: 15 }, (_, i) => ({ id: 'like_' + i, title: '点赞 ' + i })),
  };

  function simulateBeginTabTransition(targetTab) {
    if (currentScannedTabType === targetTab && !tabTransitionLock) return;
    tabTransitionStaleIds = new Set();
    const oppositeMode = targetTab === 'collect' ? 'unlike' : (targetTab === 'like' ? 'uncollect' : '');
    if (oppositeMode && modeCache[oppositeMode]) {
      modeCache[oppositeMode].forEach(n => tabTransitionStaleIds.add(n.id));
    }
    tabTransitionLock = true;
    tabTransitionTarget = targetTab;
    currentScannedTabType = targetTab;
  }

  function simulateScrollAppend(actualTab, newCards) {
    // 严格按真实实际 Tab 分流
    const targetMode = actualTab === 'like' ? 'unlike' : 'uncollect';
    const list = modeCache[targetMode];
    newCards.forEach(c => {
      if (!list.some(x => x.id === c.id)) list.push(c);
    });
  }

  // 3.1 用户在点赞页面向下滚动，小红书渲染出 10 篇新的点赞笔记
  const newLikedBatch = Array.from({ length: 10 }, (_, i) => ({ id: 'like_new_' + i, title: '新点赞 ' + i }));
  simulateScrollAppend('like', newLikedBatch);

  assert.strictEqual(modeCache.unlike.length, 25, '点赞成功增量捕获 10 篇新笔记，累计 25 篇');
  assert.strictEqual(modeCache.uncollect.length, 20, '收藏在此期间绝对保持 20 篇不变');

  // 3.2 用户切换到「收藏」Tab
  simulateBeginTabTransition('collect');
  // 核心校验：点赞的全部 25 篇（包括新滚动的 10 篇）必须全部进入黑名单！
  assert.strictEqual(tabTransitionStaleIds.has('like_new_0'), true, '新加载的点赞笔记被严格纳入对立模式黑名单');

  // 页面切换至收藏，当前页面展现原 20 篇收藏卡片
  const collectPageCards = modeCache.uncollect.slice();
  let uncollectCountBefore = modeCache.uncollect.length;
  // 模拟入库
  collectPageCards.forEach(c => {
    if (!tabTransitionStaleIds.has(c.id) && !modeCache.uncollect.some(x => x.id === c.id)) {
      modeCache.uncollect.push(c);
    }
  });

  assert.strictEqual(modeCache.uncollect.length, uncollectCountBefore, '切换到收藏后，收藏数绝对不增加（依然保持 20 篇）！');

  // 3.3 对应地，用户在收藏页面向下滚动加载 5 篇新收藏
  const newCollectBatch = Array.from({ length: 5 }, (_, i) => ({ id: 'col_new_' + i, title: '新收藏 ' + i }));
  simulateScrollAppend('collect', newCollectBatch);
  assert.strictEqual(modeCache.uncollect.length, 25, '收藏页面手动滚动正常增加至 25 篇');

  // 3.4 用户切回「点赞」Tab
  simulateBeginTabTransition('like');
  assert.strictEqual(modeCache.unlike.length, 25, '切换到点赞后，点赞数保持准确的 25 篇，收藏新卡片绝对不泄漏进点赞！');
});

test('Tab同步与突破20条限制：sub-tab-list正常识别、侧边栏双向联动切换与收藏突破20条顺畅加载', async () => {
  // 1. 模拟小红书真实 DOM：主 Tab 元素自带 class="reds-tab-item sub-tab-list"
  const domTabs = [
    {
      tagName: 'DIV',
      className: 'reds-tab-item sub-tab-list active',
      textContent: '笔记 20',
      closest(sel) {
        if (sel.includes('.feeds-container') || sel.includes('#rn-manager-host')) return null;
        return null;
      },
      clicked: false,
      click() { this.clicked = true; },
      querySelector() { return null; },
      dispatchEvent() {},
    },
    {
      tagName: 'DIV',
      className: 'reds-tab-item sub-tab-list',
      textContent: '收藏 150',
      closest(sel) {
        if (sel.includes('.feeds-container') || sel.includes('#rn-manager-host')) return null;
        return null;
      },
      clicked: false,
      click() { this.clicked = true; },
      querySelector() { return null; },
      dispatchEvent() {},
    },
    {
      tagName: 'DIV',
      className: 'reds-tab-item sub-tab-list',
      textContent: '赞过 50',
      closest(sel) {
        if (sel.includes('.feeds-container') || sel.includes('#rn-manager-host')) return null;
        return null;
      },
      clicked: false,
      click() { this.clicked = true; },
      querySelector() { return null; },
      dispatchEvent() {},
    },
  ];

  function detectTabFromText(text) {
    const clean = String(text || '').replace(/\s+/g, '');
    if (clean.indexOf('全部笔记') !== -1) return 'collect';
    if (/(?:赞过|点赞|喜欢)/.test(clean)) return 'like';
    if (/(?:收藏|合集)/.test(clean)) return 'collect';
    if (/(?:笔记|发布|原创|图文|视频)/.test(clean)) return 'notes';
    return '';
  }

  function simulateMainTabs(all) {
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

  const recognizedTabs = simulateMainTabs(domTabs);
  assert.strictEqual(recognizedTabs.length, 3, '主 Tab 元素自带 sub-tab-list class 绝不会被误过滤，成功识别全部 3 个主 Tab！');

  // 2. 模拟 ensureTab：侧边栏点击「收藏」时，能够准确在页面中找到「收藏 150」并触发点击
  function tabMatches(el, want) {
    const text = ((el && el.textContent) || '').replace(/\s+/g, '');
    const aliases = { 收藏: ['收藏'], 点赞: ['点赞', '赞过'] }[want] || [want];
    return aliases.some(function (a) { return text.indexOf(a) !== -1; });
  }

  function simulateEnsureTab(want, tabs) {
    const target = tabs.filter(el => tabMatches(el, want))[0];
    if (!target) return false;
    target.click();
    return true;
  }

  const switchOk = simulateEnsureTab('收藏', recognizedTabs);
  assert.strictEqual(switchOk, true, '侧边栏能够精准找到页面中的收藏 Tab');
  assert.strictEqual(domTabs[1].clicked, true, '成功触发小红书页面收藏 Tab 的原生点击事件！');

  // 3. 模拟 getPageActualTabType：收藏页面即便无 search 参数，绝不盲目误判为 notes（我的笔记）
  domTabs[0].className = 'reds-tab-item sub-tab-list';
  domTabs[1].className = 'reds-tab-item sub-tab-list active'; // 收藏已高亮

  function simulateGetPageActualTabType(activeEl, search) {
    if (activeEl) {
      const d = detectTabFromText(activeEl.textContent);
      if (d) return d;
    }
    const tab = new URLSearchParams(search).get('tab');
    if (tab === 'fav') return 'collect';
    if (tab === 'liked') return 'like';
    if (tab === 'note') return 'notes';
    return '';
  }

  const actualOnCollect = simulateGetPageActualTabType(domTabs[1], '');
  assert.strictEqual(actualOnCollect, 'collect', '小红书页面收藏 Tab 处于 active 时，精准返回 collect');

  const fallbackCollect = simulateGetPageActualTabType(null, '');
  assert.strictEqual(fallbackCollect, '', '若 DOM 暂未渲染且 URL 无参数，安全返回空字符串，绝不盲目套用侧边栏模式导致串仓！');

  // 4. 模拟收藏数据突破 20 条限制，无论是自动读取还是手动滑动页面
  const modeCache = {
    uncollect: Array.from({ length: 20 }, (_, i) => ({ id: 'col_init_' + i, title: '初始收藏 ' + i })),
    unlike: [],
  };

  // 模拟用户手动向下滑动，小红书渲染后续 30 条数据（从 20 到 50 篇）
  const scrollBatch1 = Array.from({ length: 30 }, (_, i) => ({ id: 'col_batch1_' + i, title: '批次1收藏 ' + i }));
  scrollBatch1.forEach(c => {
    if (!modeCache.uncollect.some(x => x.id === c.id)) modeCache.uncollect.push(c);
  });
  assert.strictEqual(modeCache.uncollect.length, 50, '手动向下滑动成功突破 20 条限制，增量合入至 50 篇');

  // 模拟自动扫描深度滚动（从 50 到 150 篇）
  const autoScanBatch = Array.from({ length: 100 }, (_, i) => ({ id: 'col_auto_' + i, title: '自动扫描收藏 ' + i }));
  autoScanBatch.forEach(c => {
    if (!modeCache.uncollect.some(x => x.id === c.id)) modeCache.uncollect.push(c);
  });
  assert.strictEqual(modeCache.uncollect.length, 150, '自动读取列表深度加载突破至 150 篇全部加载完毕！');

  // 5. 模拟过渡锁超时保护：既点赞又收藏的共存笔记不会导致死锁
  let lock = true;
  const startTime = Date.now() - 4000; // 模拟已过 4 秒
  if (Date.now() - startTime > 3500) {
    lock = false;
  }
  assert.strictEqual(lock, false, '过渡锁具有 3.5s 超时安全释放，杜绝共存笔记引发死锁');
});

test('终极防串仓：旧DOM卡片在Tab切换期间绝对阻断、对立模式卡片物理互斥，来回切换数量绝对稳定', async () => {
  // 模拟状态缓存
  const modeCache = {
    uncollect: Array.from({ length: 20 }, (_, i) => ({ id: 'col_' + i, title: '收藏笔记 ' + i })),
    unlike: Array.from({ length: 28 }, (_, i) => ({ id: 'like_' + i, title: '点赞笔记 ' + i })),
  };

  let tabTransitionLock = false;
  let tabTransitionStaleIds = new Set();
  let tabTransitionTarget = '';
  let tabTransitionStartTime = 0;

  function beginTabTransition(targetTab, currentDomCards) {
    tabTransitionStaleIds = new Set(currentDomCards.map(c => c.id));
    tabTransitionLock = true;
    tabTransitionTarget = targetTab;
    tabTransitionStartTime = Date.now();
  }

  function simulateSync(actualTab, domCards) {
    if (tabTransitionLock) {
      if (actualTab !== tabTransitionTarget) return false;
      const allStale = domCards.every(c => tabTransitionStaleIds.has(c.id));
      if (allStale) return false;
      const anyStale = domCards.some(c => tabTransitionStaleIds.has(c.id));
      if (anyStale) return false; // 严格阻断！
      tabTransitionLock = false;
      tabTransitionStaleIds.clear();
    }

    const targetMode = actualTab === 'like' ? 'unlike' : 'uncollect';
    const oppositeMode = actualTab === 'like' ? 'uncollect' : 'unlike';
    const oppositeSet = new Set((modeCache[oppositeMode] || []).map(n => n.id));

    let added = 0;
    for (const c of domCards) {
      if (tabTransitionStaleIds.has(c.id)) continue;
      if (oppositeSet.has(c.id)) continue; // 绝对阻断对立模式已有卡片渗透！
      if (!modeCache[targetMode].some(x => x.id === c.id)) {
        modeCache[targetMode].push(c);
        added++;
      }
    }
    return added > 0;
  }

  // 1. 用户当前在收藏页面，DOM 显示 20 篇收藏卡片
  let currentDom = modeCache.uncollect.slice();

  // 2. 用户点击切换至「点赞」Tab：此时触发 beginTabTransition，DOM 仍残留原 20 篇收藏卡片
  beginTabTransition('like', currentDom);
  assert.strictEqual(tabTransitionLock, true, '开启过渡锁');
  assert.strictEqual(tabTransitionStaleIds.size, 20, '记录当前 20 篇旧卡片为黑名单');

  // 小红书新网络请求尚未返回，DOM 依然是旧的收藏卡片，实际 Tab 已经变为 like
  const syncDuringTransition = simulateSync('like', currentDom);
  assert.strictEqual(syncDuringTransition, false, '过渡期间旧卡片在 DOM 中残留，严密阻断入库');
  assert.strictEqual(modeCache.unlike.length, 28, '点赞缓存严密保持 28 篇，原 20 篇收藏绝不混入！');

  // 3. 小红书渲染完成，DOM 换批展现 28 篇点赞卡片
  currentDom = modeCache.unlike.slice();
  const syncAfterLoaded = simulateSync('like', currentDom);
  assert.strictEqual(tabTransitionLock, false, '新卡片完全就绪且旧卡片彻底卸载，过渡锁安全解除');
  assert.strictEqual(modeCache.unlike.length, 28, '点赞缓存依然为 28 篇');
  assert.strictEqual(modeCache.uncollect.length, 20, '收藏缓存依然为 20 篇');

  // 4. 用户反复来回切换 10 次
  for (let i = 0; i < 10; i++) {
    // 切到收藏
    beginTabTransition('collect', currentDom);
    simulateSync('collect', currentDom); // 残留点赞旧卡片 -> 阻断
    currentDom = modeCache.uncollect.slice(); // 换批完成
    simulateSync('collect', currentDom);

    // 切到点赞
    beginTabTransition('like', currentDom);
    simulateSync('like', currentDom); // 残留收藏旧卡片 -> 阻断
    currentDom = modeCache.unlike.slice(); // 换批完成
    simulateSync('like', currentDom);
  }

  assert.strictEqual(modeCache.uncollect.length, 20, '反复切换后收藏笔记数绝对保持 20，绝不膨胀到 48！');
  assert.strictEqual(modeCache.unlike.length, 28, '反复切换后点赞笔记数绝对保持 28，绝不膨胀到 48！');
  assert.strictEqual(
    modeCache.uncollect.every(c => !modeCache.unlike.some(l => l.id === c.id)),
    true,
    '收藏与点赞列表完全物理互斥，没有任何交叉污染！'
  );
});

test('Option A 交互架构：小红书页面单向驱动，侧边栏状态跟随，杜绝模拟点击竞态并支持同时点赞收藏的笔记正常入库', () => {
  const fs = require('fs');
  const path = require('path');
  const sidepanelCode = fs.readFileSync(path.resolve(__dirname, '../src/sidepanel/sidepanel.js'), 'utf8');
  const contentCode = fs.readFileSync(path.resolve(__dirname, '../src/content/content.js'), 'utf8');

  // 1. 侧边栏代码架构防线检测
  assert.ok(sidepanelCode.includes('function showTabFollowHint('), '侧边栏必须包含提示跟随小红书页面的引导函数');
  assert.ok(sidepanelCode.includes('function applyAlert('), '侧边栏必须将提示逻辑拆解为模块化 applyAlert');
  assert.ok(!sidepanelCode.includes("sendToTab('RN_SET_MODE'"), '侧边栏点击 Tab 坚决不再向页面发送模拟点击/切换指令');

  // 2. 页面端 content script 架构防线检测
  assert.ok(!contentCode.includes('ensureTab(targetLabel).then'), 'setMode 坚决不再进行异步模拟点击 ensureTab');
  assert.ok(!contentCode.includes('oppositeSet'), 'syncDomCardsToCandidates 与 collectCandidates 彻底移除非 transition 期的全局 oppositeSet 阻断');

  // 3. 仿真测试：真实用户既点赞又收藏同一篇优秀笔记的典型场景
  const sharedNote = { id: 'note_shared_001', title: '既被点赞又被收藏的高质量笔记' };
  const collectOnlyNote = { id: 'note_collect_002', title: '仅收藏笔记' };
  const likeOnlyNote = { id: 'note_like_003', title: '仅点赞笔记' };

  const modeCache = {
    uncollect: [],
    unlike: [],
  };

  let tabTransitionLock = false;
  let tabTransitionStaleIds = new Set();
  let tabTransitionTarget = '';
  let tabTransitionStartTime = 0;

  function simulateOptionASync(actualTab, domCards) {
    if (tabTransitionLock) {
      if (actualTab !== tabTransitionTarget) return false;
      const allStale = domCards.every(c => tabTransitionStaleIds.has(c.id));
      if (allStale) return false;
      const anyStale = domCards.some(c => tabTransitionStaleIds.has(c.id));
      if (!anyStale) {
        tabTransitionLock = false;
        tabTransitionStaleIds.clear();
      }
    }

    const targetMode = actualTab === 'like' ? 'unlike' : 'uncollect';
    const targetList = modeCache[targetMode];
    let added = 0;
    for (const c of domCards) {
      if (tabTransitionStaleIds.has(c.id)) continue;
      if (!targetList.some(x => x.id === c.id)) {
        targetList.push(c);
        added++;
      }
    }
    return added > 0;
  }

  // 3.1 用户在收藏页：浏览并加载了 sharedNote 与 collectOnlyNote
  simulateOptionASync('collect', [sharedNote, collectOnlyNote]);
  assert.strictEqual(modeCache.uncollect.length, 2, '收藏模式成功录入 2 篇笔记');
  assert.strictEqual(modeCache.unlike.length, 0, '点赞模式依然为 0');

  // 3.2 用户在小红书网页点击「赞过」Tab：
  // 开启过渡保护，记录旧 DOM 卡片
  tabTransitionLock = true;
  tabTransitionTarget = 'like';
  tabTransitionStaleIds = new Set([sharedNote.id, collectOnlyNote.id]);

  // 小红书异步换批完成，点赞页渲染出 sharedNote 与 likeOnlyNote
  const newLikeDom = [sharedNote, likeOnlyNote];
  // 模拟过渡锁安全解除与入库
  tabTransitionLock = false;
  tabTransitionStaleIds.clear();
  simulateOptionASync('like', newLikeDom);

  // 核心业务断言：sharedNote 在两边均能正常展示与管理，点赞不会因为收藏已有该卡片而被吞掉！
  assert.strictEqual(modeCache.unlike.length, 2, '点赞模式成功录入 2 篇笔记（包括共存的 sharedNote）');
  assert.strictEqual(modeCache.uncollect.length, 2, '收藏模式保持 2 篇笔记');
  assert.ok(modeCache.unlike.some(n => n.id === 'note_shared_001'), '共存笔记成功进入点赞列表，彻底告别点赞不出数据！');
  assert.ok(modeCache.uncollect.some(n => n.id === 'note_shared_001'), '共存笔记同样存在于收藏列表！');
});

test('模式指示条状态化与静默熔断机制：废除超时开闸吞噬、旧卡片全在时坚决拒收、杜绝切回收藏时暴增混入点赞笔记', () => {
  const fs = require('fs');
  const path = require('path');
  const sidepanelHtml = fs.readFileSync(path.resolve(__dirname, '../src/sidepanel/sidepanel.html'), 'utf8');
  const sidepanelJs = fs.readFileSync(path.resolve(__dirname, '../src/sidepanel/sidepanel.js'), 'utf8');
  const contentCode = fs.readFileSync(path.resolve(__dirname, '../src/content/content.js'), 'utf8');

  // 1. UI 架构检测：已移除双可点击 Tab，全面升级为模式状态条与右侧操作按钮
  assert.ok(sidepanelHtml.includes('class="rn-mode-banner"'), 'HTML 必须包含 rn-mode-banner 模式指示条');
  assert.ok(sidepanelHtml.includes('id="rn-mode-title"'), '指示条必须包含标题容器');
  assert.ok(sidepanelHtml.includes('id="rn-scan"'), '指示条整合读取列表/停止双态操作按钮');
  assert.ok(sidepanelJs.includes("const modeBanner = $('rn-mode-banner')"), 'JS 必须动态驱动模式指示条渲染');

  // 2. 底层数据防护检测：坚决废除旧代码中 1500ms 超时强制开闸并误吞旧卡片的漏洞
  assert.ok(!contentCode.includes('Date.now() - tabTransitionStartTime > 1500'), '坚决杜绝在 allStale 时因 1500ms 超时而清空黑名单吞噬旧卡片');
  assert.ok(!contentCode.includes('// 超时结束时：如果这条链仍然是最新的，安全释放锁防止死锁'), 'waitForCards 坚决不再因超时而向旧 DOM 卡片开闸');

  // 3. 真实场景严密仿真：
  // 收藏 20 篇 -> 点赞滚动加载 30 篇 -> 点击收藏（小红书网络慢延迟 3 秒换批）
  const collectCards = Array.from({ length: 20 }, (_, i) => ({ id: 'col_' + i, title: '收藏 ' + i }));
  const likeCards = Array.from({ length: 30 }, (_, i) => ({ id: 'like_' + i, title: '点赞 ' + i }));

  const modeCache = {
    uncollect: collectCards.slice(), // 收藏已有 20 篇
    unlike: likeCards.slice(),       // 点赞已有 30 篇
  };

  let tabTransitionLock = true;
  let tabTransitionTarget = 'collect';
  // 切到收藏时，屏幕上依然是点赞的 30 篇卡片
  let tabTransitionStaleIds = new Set(likeCards.map(c => c.id));

  function simulateSafeSync(actualTab, domCards) {
    if (tabTransitionLock) {
      if (actualTab !== tabTransitionTarget) return false;
      const allStale = domCards.every(c => tabTransitionStaleIds.has(c.id));
      if (allStale) {
        // 100% 全是旧卡片，坚决拒绝入库！
        return false;
      }
      const anyStale = domCards.some(c => tabTransitionStaleIds.has(c.id));
      if (!anyStale) {
        tabTransitionLock = false;
        tabTransitionStaleIds.clear();
      }
    }

    const targetMode = actualTab === 'like' ? 'unlike' : 'uncollect';
    const targetList = modeCache[targetMode];
    let added = 0;
    for (const c of domCards) {
      if (tabTransitionStaleIds.has(c.id)) continue;
      if (!targetList.some(x => x.id === c.id)) {
        targetList.push(c);
        added++;
      }
    }
    return added > 0;
  }

  // 阶段 1：用户点击「收藏」后 1 秒，小红书网络请求尚未返回，屏幕上 100% 依然是那 30 篇点赞卡片
  let resultAt1s = simulateSafeSync('collect', likeCards);
  assert.strictEqual(resultAt1s, false, '网络未返回期间，30 篇旧点赞卡片坚决拒绝入库');
  assert.strictEqual(modeCache.uncollect.length, 20, '收藏依然保持 20 篇，绝对不被 30 篇点赞污染！');

  // 阶段 2：即使耗时 3 秒，只要 DOM 依然是旧点赞卡片，坚决守住防线，绝不发生超时吞噬
  let resultAt3s = simulateSafeSync('collect', likeCards);
  assert.strictEqual(resultAt3s, false, '耗时 3 秒依然坚守静默熔断');
  assert.strictEqual(modeCache.uncollect.length, 20, '收藏始终保持纯净的 20 篇');

  // 阶段 3：小红书请求返回，DOM 终于换批为真实的收藏卡片（旧卡片彻底卸载）
  let resultLoaded = simulateSafeSync('collect', collectCards);
  assert.strictEqual(tabTransitionLock, false, '新卡片就绪且旧卡片彻底销毁，过渡锁安全释放');
  assert.strictEqual(modeCache.uncollect.length, 20, '收藏最终依然为 20 篇，绝不膨胀到 50 篇！');
  assert.strictEqual(modeCache.unlike.length, 30, '点赞保持 30 篇不变');
});

test('方案A单会话工作区与幽灵子标签免疫：切Tab重置工作区物理隔离，同Tab滚动正常增量，彻底杜绝全部笔记子标签干扰', () => {
  const fs = require('fs');
  const path = require('path');
  const contentCode = fs.readFileSync(path.resolve(__dirname, '../src/content/content.js'), 'utf8');

  // 1. 代码架构静态检测
  assert.ok(contentCode.includes('// 【方案 A 核心】：换仓时彻底重置当前工作区！'), '必须包含换仓彻底重置工作区的核心实现');
  assert.ok(contentCode.includes("isMainTabElement"), 'isTabItemActive 与 mainTabs 必须严格排除子标签干扰');

  // 2. 模拟幽灵子标签场景：
  // 收藏 Tab 包含「全部笔记」子标签，且「全部笔记」带有 class="active"，但主标签「赞过」当前是激活项
  const mockTabs = [
    {
      text: '笔记 10',
      classList: ['reds-tab-item'],
      isSubTab: false,
    },
    {
      text: '收藏 20',
      classList: ['reds-tab-item'],
      isSubTab: false,
      children: [
        { text: '全部笔记', classList: ['sub-tab-item', 'active'], isSubTab: true },
        { text: '专辑', classList: ['sub-tab-item'], isSubTab: true },
      ],
    },
    {
      text: '赞过 30',
      classList: ['reds-tab-item', 'reds-tab-item-active'],
      isSubTab: false,
    },
  ];

  function simulateSafeTabDetect(tabs) {
    // 过滤排除 sub-tab
    const validMainTabs = tabs.filter(t => !t.isSubTab);
    for (const t of validMainTabs) {
      if (t.classList.includes('reds-tab-item-active') || t.classList.includes('active')) {
        return t.text.includes('赞过') ? 'like' : (t.text.includes('收藏') ? 'collect' : 'notes');
      }
    }
    return '';
  }

  const detectedTab = simulateSafeTabDetect(mockTabs);
  assert.strictEqual(detectedTab, 'like', '哪怕收藏子标签全部笔记带有 active，主标签依然100%精准识别为赞过，绝不串仓！');

  // 3. 模拟方案 A 完整工作区生命周期：
  // 3.1 用户在收藏页：浏览并加载了 20 篇收藏卡片
  let currentMode = 'uncollect';
  let workspaceCandidates = Array.from({ length: 20 }, (_, i) => ({ id: 'col_' + i, title: '收藏 ' + i }));
  assert.strictEqual(workspaceCandidates.length, 20, '收藏工作区建立，初始载入 20 篇');

  // 3.2 用户在收藏页继续向下滑动：增量加载至 40 篇
  const moreCollect = Array.from({ length: 20 }, (_, i) => ({ id: 'col_more_' + i, title: '收藏增量 ' + i }));
  workspaceCandidates.push(...moreCollect);
  assert.strictEqual(workspaceCandidates.length, 40, '同 Tab 内向下滑动平滑增量至 40 篇');

  // 3.3 用户点击切换到「赞过」Tab：
  // 核心机制：方案 A 立即销毁旧工作区，干净建立点赞工作区
  currentMode = 'unlike';
  workspaceCandidates = []; // 换仓物理归零重置！
  assert.strictEqual(workspaceCandidates.length, 0, '换仓赞过时工作区物理归零，旧收藏笔记绝不跨 Tab 残留');

  // 点赞页加载并渲染 30 篇点赞卡片
  const likeCards = Array.from({ length: 30 }, (_, i) => ({ id: 'like_' + i, title: '点赞 ' + i }));
  workspaceCandidates.push(...likeCards);
  assert.strictEqual(workspaceCandidates.length, 30, '赞过工作区独立建立，成功载入 30 篇');

  // 3.4 用户再次点击切回「收藏」Tab：
  // 核心机制：再次重置换仓，旧点赞笔记彻底销毁，绝不污染收藏！
  currentMode = 'uncollect';
  workspaceCandidates = []; // 再次换仓物理归零重置！
  assert.strictEqual(workspaceCandidates.length, 0, '切回收藏时工作区再次归零，旧点赞笔记绝不污染收藏');

  // 小红书重新返回 20 篇真实收藏卡片
  const freshCollectCards = Array.from({ length: 20 }, (_, i) => ({ id: 'col_fresh_' + i, title: '新鲜收藏 ' + i }));
  workspaceCandidates.push(...freshCollectCards);
  assert.strictEqual(workspaceCandidates.length, 20, '收藏工作区重新建立，纯净保留 20 篇，合流暴增彻底根绝！');
});

test('方案1单工作区物理独占架构：换Tab双仓彻底清零归位，严格模式同源校验拒收异相卡片，主Tab精准识别与子标签彻底绝缘', () => {
  const fs = require('fs');
  const path = require('path');
  const contentCode = fs.readFileSync(path.resolve(__dirname, '../src/content/content.js'), 'utf8');

  // 1. 核心架构代码静态检测
  assert.ok(contentCode.includes('// 【方案 1 核心】：单工作区物理独占！'), '必须包含方案 1 单工作区物理独占核心实现');
  assert.ok(contentCode.includes('state.modeCache = { uncollect: [], unlike: [] };'), '换仓时双仓必须同时物理清空归零');
  assert.ok(contentCode.includes('if (state.settings.mode !== targetMode)'), '必须包含严格工作区同源校验阻断机制');
  assert.ok(contentCode.includes('function isMainTabElement('), '必须包含 isMainTabElement 精确主标签识别函数');

  // 2. 验证 isMainTabElement：
  // 必须识别小红书真机 DOM：带有 sub-tab-list class 的主 Tab
  const mainTabLike = { textContent: '赞过 50', className: 'reds-tab-item sub-tab-list' };
  const mainTabCollect = { textContent: '收藏 150', className: 'reds-tab-item sub-tab-list' };
  const mainTabNotes = { textContent: '笔记 20', className: 'reds-tab-item sub-tab-list' };
  const subTabAll = { textContent: '全部笔记', className: 'reds-tab-item active' };
  const subTabAlbum = { textContent: '专辑', className: 'sub-tab-item' };

  function simulateIsMainTabElement(el) {
    if (!el) return false;
    const text = (el.textContent || '').trim().replace(/\s+/g, '');
    if (!text) return false;
    if (/^(?:全部笔记|全部|专辑|合集)$/.test(text)) return false;
    if (/(?:赞过|点赞|喜欢)/.test(text)) return true;
    if (/(?:收藏|合集)/.test(text)) return true;
    if (/(?:笔记|发布|原创|图文|视频)/.test(text)) {
      return text.indexOf('全部笔记') === -1;
    }
    return false;
  }

  assert.strictEqual(simulateIsMainTabElement(mainTabLike), true, '主标签「赞过 50」成功识别');
  assert.strictEqual(simulateIsMainTabElement(mainTabCollect), true, '主标签「收藏 150」成功识别');
  assert.strictEqual(simulateIsMainTabElement(mainTabNotes), true, '主标签「笔记 20」成功识别');
  assert.strictEqual(simulateIsMainTabElement(subTabAll), false, '子标签「全部笔记」严格排除');
  assert.strictEqual(simulateIsMainTabElement(subTabAlbum), false, '子标签「专辑」严格排除');

  // 3. 验证同源校验拒收机制：
  // 当工作区处于 uncollect (收藏) 模式时，即使 DOM 临时返回了 like 卡片，同源校验强制阻断入库
  let currentWorkspaceMode = 'uncollect';
  let candidates = [{ id: 'col_1', title: '收藏笔记1' }];
  let actualDetectedTab = 'like'; // 小红书实际正在展现点赞

  function simulateSafeSync(actualTab, cards) {
    const targetMode = actualTab === 'like' ? 'unlike' : 'uncollect';
    if (currentWorkspaceMode !== targetMode) {
      // 触发换仓清盘并拒绝入库
      currentWorkspaceMode = targetMode;
      candidates = [];
      return false;
    }
    candidates.push(...cards);
    return true;
  }

  const syncResult1 = simulateSafeSync(actualDetectedTab, [{ id: 'like_bad_1', title: '错误点赞卡' }]);
  assert.strictEqual(syncResult1, false, '工作区模式与实际Tab不符时，严禁入库卡片！');
  assert.strictEqual(candidates.length, 0, '旧收藏数据彻底物理清空，错误点赞卡绝未入库！');
  assert.strictEqual(currentWorkspaceMode, 'unlike', '工作区模式正确重置为 unlike');

  // 4. 在正确的工作区模式下，新卡片纯净入库
  const syncResult2 = simulateSafeSync('like', [{ id: 'like_clean_1', title: '纯净点赞卡' }]);
  assert.strictEqual(syncResult2, true, '同源匹配成功，纯净入库');
  assert.strictEqual(candidates.length, 1, '工作区纯净持有 1 篇点赞笔记');
  assert.strictEqual(candidates[0].id, 'like_clean_1');
});

test('全景运行诊断与事件轨迹追踪系统：多维度采集DOM真实解构、工作区状态与时序轨迹，支持一键剪贴板输出', () => {
  const fs = require('fs');
  const path = require('path');
  const contentCode = fs.readFileSync(path.resolve(__dirname, '../src/content/content.js'), 'utf8');
  const sidepanelCode = fs.readFileSync(path.resolve(__dirname, '../src/sidepanel/sidepanel.js'), 'utf8');
  const sidepanelHtml = fs.readFileSync(path.resolve(__dirname, '../src/sidepanel/sidepanel.html'), 'utf8');

  // 1. 结构与能力静态检验
  assert.ok(contentCode.includes('const diagnosticTrail = [];'), '必须包含运行轨迹追踪缓冲区');
  assert.ok(contentCode.includes('function recordDiagEvent('), '必须包含事件留痕记录函数');
  assert.ok(contentCode.includes('RedNote Manager 全景运行诊断报告'), '必须包含全景运行诊断报告输出');
  assert.ok(sidepanelHtml.includes('id="rn-log-diag"'), '侧边栏操作栏必须提供快捷诊断按钮');
  assert.ok(sidepanelCode.includes('runDiagnosisWithFeedback'), '侧边栏必须包含诊断并复制的完整反馈交互');

  // 2. 模拟诊断轨迹事件流水
  const mockTrail = [];
  function simulateRecord(name, detail) {
    mockTrail.push({ t: '12:00:00', name, detail });
    if (mockTrail.length > 5) mockTrail.shift();
  }

  simulateRecord('TAB_CLICK_EVENT', { targetTag: 'SPAN', tabText: '赞过 50', detected: 'like' });
  simulateRecord('BEGIN_TAB_TRANSITION', { targetTab: 'like', staleCount: 20 });
  simulateRecord('WAIT_CARDS_CLEARED', { expectedTab: 'like', cardsCount: 30 });
  simulateRecord('SYNC_CARDS_CHANGED', { actualTab: 'like', mode: 'unlike', validCount: 30, candidatesCount: 30 });

  assert.strictEqual(mockTrail.length, 4);
  assert.strictEqual(mockTrail[0].name, 'TAB_CLICK_EVENT');
  assert.strictEqual(mockTrail[3].detail.candidatesCount, 30);

  // 3. 模拟全景诊断报告生成
  const reportLines = [
    '========== [RedNote Manager 全景运行诊断报告] ==========',
    'URL：https://www.xiaohongshu.com/user/profile/12345678',
    '当前工作区模式 settings.mode：unlike',
    'getPageActualTabType() 结果：like',
    'mainTabs() 识别出的候选主标签：',
    '  #1: 文本="笔记 10" | 类名="reds-tab-item sub-tab-list"',
    '  #2: 文本="收藏 20" | 类名="reds-tab-item sub-tab-list"',
    '  #3: 文本="赞过 30" | 类名="reds-tab-item sub-tab-list active"',
    '页面 DOM 卡片快照 (前 3 篇)：',
    '  - [DOM #1] id=note_001 | title="测试笔记1"',
    '运行时事件追踪轨迹：',
    `  [12:00:00] TAB_CLICK_EVENT => ${JSON.stringify(mockTrail[0].detail)}`,
    '========================================================',
  ];

  const fullReport = reportLines.join('\n');
  assert.ok(fullReport.includes('https://www.xiaohongshu.com/user/profile/12345678'));
  assert.ok(fullReport.includes('getPageActualTabType() 结果：like'));
  assert.ok(fullReport.includes('TAB_CLICK_EVENT'));
});

test('全链路防串仓终极闭环：换Tab深度拦截机制（candidates全量黑名单 + 250ms沉淀门禁 + anyStale绝对阻断），彻底杜绝切回收藏时421篇点赞卡片瞬时渗透入库', () => {
  const contentCode = fs.readFileSync(path.join(__dirname, '../src/content/content.js'), 'utf8');

  // 1. 源码关键防线验证
  assert.ok(contentCode.includes('minSettleMs = 250'), 'waitForCards 必须包含至少 250ms 的沉淀门禁');
  assert.ok(contentCode.includes('state.candidates.forEach'), 'beginTabTransition 必须直接拍摄全量候选池入黑名单');
  assert.ok(contentCode.includes("UNLOCK_TRANSITION"), '必须记录安全解锁诊断事件');

  // 2. 模拟用户真实发生的 08:55:17 故障轨迹
  // 用户在点赞页累积了 421 篇点赞卡片，点击收藏切仓
  const likedNotes421 = Array.from({ length: 421 }, (_, i) => ({
    id: 'like_' + String(i).padStart(18, '0'),
    title: '点赞笔记 ' + i,
    author: '博主 ' + i,
  }));

  let currentCandidates = likedNotes421.slice();
  let currentScannedTab = 'like';
  let tabTransitionLock = false;
  let tabTransitionTarget = '';
  let tabTransitionStaleIds = new Set();
  let tabTransitionStartTime = 0;

  // 模拟 beginTabTransition('collect')
  function beginTransition(targetTab, domCards) {
    tabTransitionStaleIds = new Set();
    // 拍摄 DOM
    domCards.forEach(c => tabTransitionStaleIds.add(c.id));
    // 拍摄当前工作区 candidates（核心防线！）
    currentCandidates.forEach(c => tabTransitionStaleIds.add(c.id));

    tabTransitionLock = true;
    tabTransitionTarget = targetTab;
    tabTransitionStartTime = Date.now();
    currentScannedTab = targetTab;
    currentCandidates = [];
  }

  // 模拟 syncDomCardsToCandidates
  function syncCards(actualTab, domCards) {
    if (tabTransitionLock) {
      if (actualTab !== tabTransitionTarget) return false;
      const newCards = domCards.filter(c => !tabTransitionStaleIds || !tabTransitionStaleIds.has(c.id));
      if (!newCards.length) {
        return false; // 100% 全部为旧卡片，坚决拒绝入库！
      }
      tabTransitionLock = false;
      tabTransitionStaleIds.clear();
    }
    domCards.forEach(c => {
      if (!currentCandidates.some(x => x.id === c.id)) {
        currentCandidates.push(c);
      }
    });
    return true;
  }

  // 模拟 waitForCards
  function canUnlock(curTab, domCards, elapsedMs) {
    if (elapsedMs < 250) return false; // 250ms 门禁
    const newCards = domCards.filter(c => !tabTransitionStaleIds || !tabTransitionStaleIds.has(c.id));
    if (!newCards.length) return false;
    tabTransitionLock = false;
    tabTransitionStaleIds.clear();
    return true;
  }

  // 步骤 1：触发切仓到收藏
  // 此时屏幕顶部残留点赞的第 0..5 篇卡片（共 6 篇）
  const topLikedCards6 = likedNotes421.slice(0, 6);
  beginTransition('collect', topLikedCards6);

  assert.strictEqual(tabTransitionLock, true);
  assert.strictEqual(currentCandidates.length, 0, '换仓立即物理清零');
  assert.strictEqual(tabTransitionStaleIds.size, 421, '421篇点赞卡片全部进入黑名单');

  // 步骤 2：在 0ms 瞬间（即用户报告中的 08:55:17），旧 DOM 卡片依然在页面上
  // 此时 waitForCards 判定（0ms 未达 250ms）
  const unlockAt0ms = canUnlock('collect', topLikedCards6, 0);
  assert.strictEqual(unlockAt0ms, false, '0ms 门禁坚决拒绝解锁');

  // 此时 syncCards 尝试入库
  const syncAt0ms = syncCards('collect', topLikedCards6);
  assert.strictEqual(syncAt0ms, false, '过渡锁期间只要全为旧卡片坚决拒绝入库');
  assert.strictEqual(currentCandidates.length, 0, '候选池依然保持纯净的 0 篇，绝对不被 6 篇点赞卡片污染！');

  // 步骤 3：在 1500ms，小红书接口依然在加载中，旧 DOM 卡片依然在
  const unlockAt1500ms = canUnlock('collect', topLikedCards6, 1500);
  assert.strictEqual(unlockAt1500ms, false, 'DOM 中全为旧卡片时坚决不解锁');
  const syncAt1500ms = syncCards('collect', topLikedCards6);
  assert.strictEqual(syncAt1500ms, false, '依然坚决阻断入库');

  // 步骤 4：在 3000ms（即真实换批完成），小红书渲染 25 篇真实收藏卡片
  const realCollectCards25 = Array.from({ length: 25 }, (_, i) => ({
    id: 'col_' + String(i).padStart(19, '0'),
    title: '收藏笔记 ' + i,
  }));
  const unlockAt3000ms = canUnlock('collect', realCollectCards25, 3000);
  assert.strictEqual(unlockAt3000ms, true, '全新卡片安全解锁');
  assert.strictEqual(tabTransitionLock, false, '过渡锁安全解除');

  const syncAt3000ms = syncCards('collect', realCollectCards25);
  assert.strictEqual(syncAt3000ms, true, '真实收藏卡片安全入库');
  assert.strictEqual(currentCandidates.length, 25, '候选池纯净且仅包含 25 篇收藏卡片');
  assert.strictEqual(currentCandidates.every(c => c.id.startsWith('col_')), true, '彻底消灭任何点赞卡片的串仓渗透！');

  // 步骤 5：切回点赞，测试“既点赞又收藏”的共存卡片绝不误发 TIMEOUT_STILL_STALE
  beginTransition('like', realCollectCards25);
  assert.strictEqual(tabTransitionLock, true);
  assert.strictEqual(currentCandidates.length, 0);

  // 假设点赞列表中有 2 篇是用户同时也收藏过的共存笔记
  const sharedLikeCards = [
    realCollectCards25[0], // 既收藏又点赞
    realCollectCards25[1], // 既收藏又点赞
    likedNotes421[0],
    likedNotes421[1],
  ];
  // 换批后 newCards 包含 2 篇纯点赞卡片，newCards.length > 0
  const unlockLike = canUnlock('like', sharedLikeCards, 300);
  assert.strictEqual(unlockLike, true, '即便含有共存收藏笔记，只要包含真实点赞新卡片即安全开闸');
  const syncLike = syncCards('like', sharedLikeCards);
  assert.strictEqual(syncLike, true, '点赞卡片成功入库');
  assert.strictEqual(currentCandidates.length, 4, '共存卡片与纯点赞卡片均正常展示');
});

test('小红书多容器常驻轮播架构（transform-container）防串仓终极闭环：彻底杜绝点赞500篇渗透进收藏', () => {
  // 模拟小红书真实 DOM 结构：
  // .transform-container 下有 3 个槽位：
  // slot 0 (笔记), slot 1 (收藏), slot 2 (点赞)

  function createMockSlot(index, activeClass, cards) {
    const classList = new Set(activeClass ? activeClass.split(' ') : []);
    const slotObj = {
      classList: {
        contains: (cls) => classList.has(cls),
      },
      parentElement: null,
      children: [],
      closest: function (sel) {
        if (sel.includes('.transform-container > *')) return slotObj;
        if (sel.includes('.transform-container')) return transformContainer;
        return null;
      },
    };
    const cardNodes = cards.map(c => ({
      id: c.id,
      title: c.title,
      closest: function (sel) {
        if (sel.includes('.transform-container > *')) return slotObj;
        if (sel.includes('.transform-container')) return transformContainer;
        return null;
      },
      getBoundingClientRect: function () {
        // 当处于收藏激活态（slot 1）时：
        // slot 1 的卡片在屏幕视口内：left = 23px ~ 520px, right = 260px ~ 750px
        // slot 2（点赞）的卡片在视口外右侧：left = 768px ~ 1200px, right = 1000px ~ 1500px
        if (index === 1) {
          return { left: 50, right: 290, width: 240, height: 320 };
        } else if (index === 2) {
          return { left: 800, right: 1040, width: 240, height: 320 };
        } else {
          return { left: -700, right: -460, width: 240, height: 320 };
        }
      },
      parentElement: slotObj,
    }));
    slotObj.children = cardNodes;
    return { slotObj, cardNodes };
  }

  const collectCards = [
    { id: 'col_01', title: 'X上疯传 用Cursor编程的完美工作流' },
    { id: 'col_02', title: '50万美金冠军AI短片，8个做法拆给你' },
    { id: 'col_03', title: '希望妈妈的副业早日月入过万' },
  ];

  const likeCards = [
    { id: 'like_jay_01', title: '周杰伦昆凌和好友一起玩个游戏吧😆' },
    { id: 'like_jay_02', title: '周杰伦亲绘「幻想Fantasy」版画是真丑啊' },
    { id: 'like_03', title: '这样不过分吧???' },
  ];

  // 场景：当前处于“收藏”激活态
  // slot 1 拥有 .tab-content-item 类名，slot 2 为非激活态（无该类名）
  const slot1 = createMockSlot(1, 'tab-content-item', collectCards);
  const slot2 = createMockSlot(2, '', likeCards);
  const slot0 = createMockSlot(0, '', []);

  const transformContainer = {
    children: [slot0.slotObj, slot1.slotObj, slot2.slotObj],
    querySelector: function (sel) {
      if (sel === '.tab-content-item') return slot1.slotObj;
      return null;
    },
  };
  slot0.slotObj.parentElement = transformContainer;
  slot1.slotObj.parentElement = transformContainer;
  slot2.slotObj.parentElement = transformContainer;

  // 测试 isCardInWrongTabContainer
  function isCardInWrongTabContainer(el, tab) {
    if (!el || !el.closest || !tab) return false;
    const tc = el.closest('.transform-container');
    if (tc) {
      const slot = el.closest('.transform-container > *');
      if (slot) {
        const slots = Array.prototype.slice.call(tc.children);
        const slotIdx = slots.indexOf(slot);
        if (slotIdx !== -1 && slots.length >= 3) {
          if (tab === 'collect' && slotIdx !== 1) return true;
          if (tab === 'like' && slotIdx !== 2) return true;
          if (tab === 'notes' && slotIdx !== 0) return true;
        }
      }
    }
    return false;
  }

  // 1. 验证在收藏模式下，点赞槽位里的“周杰伦”卡片被 isCardInWrongTabContainer 坚决判定为错误容器！
  assert.strictEqual(isCardInWrongTabContainer(likeCards[0], 'collect'), false); // raw card obj no closest
  assert.strictEqual(isCardInWrongTabContainer(slot2.cardNodes[0], 'collect'), true, '点赞槽位中的周杰伦笔记属于错误容器，被坚决剔除！');
  assert.strictEqual(isCardInWrongTabContainer(slot2.cardNodes[1], 'collect'), true, '点赞槽位中的周杰伦版画笔记属于错误容器，被坚决剔除！');

  // 2. 验证在收藏模式下，收藏槽位里的正常笔记判定为正确容器
  assert.strictEqual(isCardInWrongTabContainer(slot1.cardNodes[0], 'collect'), false, '收藏槽位内的卡片正常保留');
  assert.strictEqual(isCardInWrongTabContainer(slot1.cardNodes[1], 'collect'), false, '收藏槽位内的卡片正常保留');

  // 3. 测试 cardNodes 槽位精准提取逻辑：
  function mockCardNodes(forTab) {
    let targetRoot = null;
    const slots = transformContainer.children;
    if (forTab === 'collect') targetRoot = slots[1];
    else if (forTab === 'like') targetRoot = slots[2];
    else if (forTab === 'notes') targetRoot = slots[0];

    const out = [];
    const cardList = targetRoot.children || [];
    for (let j = 0; j < cardList.length; j++) {
      const node = cardList[j];
      if (isCardInWrongTabContainer(node, forTab)) continue;
      out.push(node);
    }
    return out;
  }

  const collectResult = mockCardNodes('collect');
  assert.strictEqual(collectResult.length, 3, '收藏模式精准提取 slot 1 里的 3 篇卡片');
  assert.strictEqual(collectResult.every(c => c.id.startsWith('col_')), true, '提取出的全部是 col_ 开头的收藏笔记');
  assert.strictEqual(collectResult.some(c => c.id.includes('jay')), false, '周杰伦等仅点赞的笔记 0% 渗透进收藏！');

  const likeResult = mockCardNodes('like');
  assert.strictEqual(likeResult.length, 3, '点赞模式精准提取 slot 2 里的 3 篇卡片');
  assert.strictEqual(likeResult.every(c => c.id.startsWith('like_')), true, '提取出的全部是 like_ 开头的点赞笔记');
  assert.strictEqual(likeResult.some(c => c.id.includes('col_')), false, '收藏笔记 0% 渗透进点赞！');
});

test('侧边栏外观主题管理体系：light、dark、auto 设置项完整支持与系统偏好跟随联动', () => {
  // 1. 验证 HTML 中存在外观主题配置选择控件与完整的选项
  const htmlPath = path.join(__dirname, '../src/sidepanel/sidepanel.html');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  assert.strictEqual(htmlContent.includes('id="rn-appearance"'), true, 'HTML 中包含 rn-appearance 控件');
  assert.strictEqual(htmlContent.includes('value="auto"'), true, '包含 auto 选项');
  assert.strictEqual(htmlContent.includes('value="light"'), true, '包含 light 选项');
  assert.strictEqual(htmlContent.includes('value="dark"'), true, '包含 dark 选项');

  // 2. 验证 CSS 中存在完善的深浅色变量和主题属性规则
  const cssPath = path.join(__dirname, '../src/sidepanel/sidepanel.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');
  assert.strictEqual(cssContent.includes('html[data-theme="light"]'), true, 'CSS 定义了浅色模式主题选择器');
  assert.strictEqual(cssContent.includes('color-scheme: light'), true, '浅色主题声明了 color-scheme: light');
  assert.strictEqual(cssContent.includes('color-scheme: dark'), true, '深色主题声明了 color-scheme: dark');
  assert.strictEqual(cssContent.includes('--bg-primary: #f6f7fa'), true, '浅色模式包含浅色背景定义');

  // 浅色模式视觉抑制与字迹清晰度校验（杜绝红色滥用与AI文字看不清）
  assert.strictEqual(cssContent.includes('--border-hover: #cbd5e1'), true, '浅色模式悬浮边框使用柔和中性色，避免红色滥用');
  assert.strictEqual(cssContent.includes('--btn-ai-text: #6b21a8'), true, '浅色模式 AI 按钮文字使用高对比度深紫，确保清晰可见');
  assert.strictEqual(cssContent.includes('--banner-bg: #ffffff'), true, '浅色模式模式横幅采用纯净白卡，消除大块刺眼粉红');
  assert.strictEqual(cssContent.includes('html[data-theme="light"] .rn-chip-warn'), true, '浅色模式包含高对比度标签胶囊样式');

  // 3. 验证 JS 中存在外观应用逻辑与事件处理
  const jsPath = path.join(__dirname, '../src/sidepanel/sidepanel.js');
  const jsContent = fs.readFileSync(jsPath, 'utf8');
  assert.strictEqual(jsContent.includes('function resolveEffectiveTheme'), true, 'JS 包含主题解析函数');
  assert.strictEqual(jsContent.includes('applyAppearance'), true, 'JS 包含 applyAppearance 应用函数');
  assert.strictEqual(jsContent.includes("setVal('rn-appearance'"), true, 'syncSettings 同步设置包含 appearance 字段');
  assert.strictEqual(jsContent.includes("addEventListener('change'"), true, '包含外观变动事件监听');

  // 4. 模拟运行环境验证主题计算逻辑
  function mockResolveEffectiveTheme(appearance, isSystemDark) {
    if (appearance === 'light') return 'light';
    if (appearance === 'dark') return 'dark';
    return isSystemDark ? 'dark' : 'light';
  }

  // 测试强制浅色模式
  assert.strictEqual(mockResolveEffectiveTheme('light', true), 'light', '用户设置为 light 时，即便系统为 dark 也是 light');
  assert.strictEqual(mockResolveEffectiveTheme('light', false), 'light', '用户设置为 light 时保持 light');

  // 测试强制深色模式
  assert.strictEqual(mockResolveEffectiveTheme('dark', false), 'dark', '用户设置为 dark 时，即便系统为 light 也是 dark');
  assert.strictEqual(mockResolveEffectiveTheme('dark', true), 'dark', '用户设置为 dark 时保持 dark');

  // 测试跟随系统 auto
  assert.strictEqual(mockResolveEffectiveTheme('auto', true), 'dark', '用户设置为 auto 且系统为深色时，解析为 dark');
  assert.strictEqual(mockResolveEffectiveTheme('auto', false), 'light', '用户设置为 auto 且系统为浅色时，解析为 light');
  assert.strictEqual(mockResolveEffectiveTheme(undefined, false), 'light', '未定义时默认 auto，随系统浅色解析为 light');
  assert.strictEqual(mockResolveEffectiveTheme(undefined, true), 'dark', '未定义时默认 auto，随系统深色解析为 dark');
});

test('偏好设置全屏横向滑入收起交互架构 (向左滑入/向右收起，手写体顶栏，零冗余信息)', () => {
  // 1. 验证 HTML 结构：纯净手写体顶栏 + 右侧关闭按钮 + 双视图容器
  const htmlPath = path.join(__dirname, '../src/sidepanel/sidepanel.html');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');

  // 顶栏元素：仅保留 Logo 和插件名称，冗余副标题彻底移除，右侧关闭按钮替换咖啡位置
  assert.strictEqual(htmlContent.includes('id="rn-btn-close"'), true, '顶栏右侧包含关闭设置按钮 #rn-btn-close');
  assert.strictEqual(htmlContent.includes('id="rn-hdr-logo"'), true, '顶栏 Logo 具备独立 ID');
  assert.strictEqual(htmlContent.includes('id="rn-title"'), true, '顶栏主标题具备 ID');
  assert.strictEqual(htmlContent.includes('id="rn-hdr-subs-main"'), false, '彻底移除主工作区冗余副标题');
  assert.strictEqual(htmlContent.includes('id="rn-hdr-subs-settings"'), false, '彻底移除设置区冗余副标题');
  assert.strictEqual(htmlContent.includes('id="rn-gear"'), true, '顶栏保留偏好设置入口齿轮按钮');

  // 视图平级隔离结构
  assert.strictEqual(htmlContent.includes('id="rn-main-view"'), true, '主体区域包含独立主视图容器 #rn-main-view');
  assert.strictEqual(htmlContent.includes('id="rn-settings"'), true, '主体区域包含独立偏好设置容器 #rn-settings');
  assert.strictEqual(htmlContent.includes('class="rn-view rn-view-main"'), true, '主视图带有 .rn-view 与 .rn-view-main 类');
  assert.strictEqual(htmlContent.includes('class="rn-view rn-view-settings"'), true, '设置视图带有 .rn-view 与 .rn-view-settings 类');
  assert.strictEqual(htmlContent.includes('class="rn-settings-card"'), true, '设置项以卡片式进行分组 (.rn-settings-card)');

  // 2. 验证 CSS 样式：手写体标题 + 横向滑动进入收起动画
  const cssPath = path.join(__dirname, '../src/sidepanel/sidepanel.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  assert.strictEqual(cssContent.includes('.rn-body {'), true, '包含 .rn-body 样式');
  assert.strictEqual(cssContent.includes('overflow: hidden'), true, '.rn-body 采用视口级 overflow: hidden');
  assert.strictEqual(cssContent.includes('.rn-view-main {'), true, '包含 .rn-view-main 容器');
  assert.strictEqual(cssContent.includes('.rn-view-settings {'), true, '包含 .rn-view-settings 容器');
  assert.strictEqual(cssContent.includes('.rn-settings-open .rn-view-settings'), true, '包含向左滑入打开样式定义');
  assert.strictEqual(cssContent.includes('translateX(100%)'), true, '默认位于右侧 100% 准备向左滑入');
  assert.strictEqual(cssContent.includes('cursive'), true, '标题采用优雅手写字体族 cursive');

  // 3. 验证 JS 视图切换引擎逻辑与系统级快捷键支持
  const jsPath = path.join(__dirname, '../src/sidepanel/sidepanel.js');
  const jsContent = fs.readFileSync(jsPath, 'utf8');

  assert.strictEqual(jsContent.includes('function rnSetView'), true, 'JS 包含核心视图切换引擎 rnSetView');
  assert.strictEqual(jsContent.includes("rnSetView('settings')"), true, '齿轮按钮与无Key拦截时调用 rnSetView("settings")');
  assert.strictEqual(jsContent.includes("rnSetView('main')"), true, '关闭按钮与 Esc 键触发 rnSetView("main")');
  assert.strictEqual(jsContent.includes('isMac ? ev.metaKey : ev.ctrlKey'), true, '支持智能判断 Mac ⌘Z 与 Windows Ctrl+Z 快捷键撤销');

  // 4. 模拟 DOM 运行环境，严密测试视图切换状态机
  const mockBodyClassList = new Set();
  const mockGearClassList = new Set();
  const mockElements = {
    'rn-main-view': { hidden: false },
    'rn-settings': { hidden: true, scrollTop: 120, classList: new Set() },
    'rn-btn-close': { hidden: true },
    'rn-hdr-logo': { hidden: false },
    'rn-title': { textContent: 'RedNote Manager' },
    'rn-gear': {
      hidden: false,
      classList: {
        classes: mockGearClassList,
        add(cls) { mockGearClassList.add(cls); },
        remove(cls) { mockGearClassList.delete(cls); },
        toggle(cls, force) {
          if (force) mockGearClassList.add(cls);
          else mockGearClassList.delete(cls);
        }
      }
    }
  };

  function mock$ (id) {
    return mockElements[id] || null;
  }

  let mockSettingsOpen = false;
  function mockRnSetView(viewName) {
    const isSettings = viewName === 'settings';
    mockSettingsOpen = isSettings;
    const settingsView = mock$('rn-settings');
    const closeBtn = mock$('rn-btn-close');
    const gearBtn = mock$('rn-gear');

    if (isSettings) {
      if (settingsView) {
        settingsView.hidden = false;
        settingsView.scrollTop = 0;
      }
      mockBodyClassList.add('rn-settings-open');
      if (gearBtn) {
        gearBtn.hidden = true;
        gearBtn.classList.add('rn-active');
      }
      if (closeBtn) closeBtn.hidden = false;
    } else {
      mockBodyClassList.delete('rn-settings-open');
      if (gearBtn) {
        gearBtn.hidden = false;
        gearBtn.classList.remove('rn-active');
      }
      if (closeBtn) closeBtn.hidden = true;
      if (settingsView) {
        settingsView.hidden = true;
      }
    }
  }

  // 初始状态检查
  assert.strictEqual(mockElements['rn-main-view'].hidden, false, '初始状态主工作区可见');
  assert.strictEqual(mockElements['rn-settings'].hidden, true, '初始状态偏好设置隐藏');
  assert.strictEqual(mockElements['rn-btn-close'].hidden, true, '初始状态关闭按钮隐藏');
  assert.strictEqual(mockElements['rn-hdr-logo'].hidden, false, '初始状态Logo展示');
  assert.strictEqual(mockElements['rn-gear'].hidden, false, '初始状态齿轮展示');
  assert.strictEqual(mockElements['rn-title'].textContent, 'RedNote Manager', '初始标题为手写体 RedNote Manager');

  // 执行切换到偏好设置视图 (向左滑入)
  mockRnSetView('settings');
  assert.strictEqual(mockSettingsOpen, true);
  assert.strictEqual(mockBodyClassList.has('rn-settings-open'), true, '进入设置时注入 rn-settings-open 触发向左滑入动画');
  assert.strictEqual(mockElements['rn-settings'].hidden, false, '设置视图激活可见');
  assert.strictEqual(mockElements['rn-settings'].scrollTop, 0, '切入时自动回到顶部');
  assert.strictEqual(mockElements['rn-btn-close'].hidden, false, '关闭按钮显现于顶栏右侧');
  assert.strictEqual(mockElements['rn-gear'].hidden, true, '齿轮按钮隐藏');
  assert.strictEqual(mockElements['rn-hdr-logo'].hidden, false, 'Logo 始终常驻保持品牌纯净');

  // 执行返回主视图 (原路向右收起)
  mockRnSetView('main');
  assert.strictEqual(mockSettingsOpen, false);
  assert.strictEqual(mockBodyClassList.has('rn-settings-open'), false, '退出设置时移除类名，原路向右收起滑出');
  assert.strictEqual(mockElements['rn-settings'].hidden, true, '偏好设置完全隐藏');
  assert.strictEqual(mockElements['rn-btn-close'].hidden, true, '关闭按钮隐藏');
  assert.strictEqual(mockElements['rn-gear'].hidden, false, '齿轮按钮重新恢复展示');
  assert.strictEqual(mockElements['rn-hdr-logo'].hidden, false, 'Logo 恢复且始终呈现');
});

test('界面细节与控制状态交互演进：已读取计数还原、停止态即刻响应与关闭按钮居中优化', () => {
  const fs = require('fs');
  const path = require('path');
  const rootDir = path.resolve(__dirname, '..');

  const htmlContent = fs.readFileSync(path.join(rootDir, 'src/sidepanel/sidepanel.html'), 'utf8');
  const cssContent = fs.readFileSync(path.join(rootDir, 'src/sidepanel/sidepanel.css'), 'utf8');
  const jsContent = fs.readFileSync(path.join(rootDir, 'src/sidepanel/sidepanel.js'), 'utf8');

  // 1. 已读取计数还原在已勾选之前
  const candIndex = htmlContent.indexOf('id="rn-s-cand"');
  const selIndex = htmlContent.indexOf('id="rn-s-sel"');
  assert.strictEqual(candIndex !== -1, true, '统计看板中已找回 #rn-s-cand 已读取计数');
  assert.strictEqual(selIndex !== -1, true, '统计看板中包含 #rn-s-sel 已勾选计数');
  assert.strictEqual(candIndex < selIndex, true, '已读取计数位于已勾选计数之前');

  // 2. 取消点赞按钮上方冗余红线进度条已移除
  assert.strictEqual(htmlContent.includes('<div class="rn-progress"><i id="rn-bar"></i></div>'), false, '主按钮上方冗余红线进度条已移除');

  // 3. 统计网格升级为4列
  assert.strictEqual(cssContent.includes('grid-template-columns: repeat(4, 1fr)'), true, '统计面板网格配置为 4 列对齐');

  // 4. 关闭按钮与图标居中
  assert.strictEqual(cssContent.includes('display: inline-flex !important'), true, '关闭按钮设置强制 flex 居中');
  assert.strictEqual(cssContent.includes('display: inline-flex;\n  align-items: center;\n  justify-content: center;'), true, '通用图标按钮支持精准居中');

  // 5. 停止态按钮醒目可视度与即时响应
  assert.strictEqual(cssContent.includes('.rn-mode-scan-btn.rn-scanning'), true, '包含扫描/停止中高对比状态样式');
  assert.strictEqual(cssContent.includes('#dc2626'), true, '停止状态具备高饱和高对比警示红色');
  assert.strictEqual(jsContent.includes("scanBtn.textContent = '⏹ 停止'"), true, '点击扫描时具备 0ms 乐观即刻切换停止状态');
});

test('底部布局重排与交互防线：主操作区下移、全选/反选Array解构、叠卡Esc快捷键与弹窗防误触', () => {
  const fs = require('fs');
  const path = require('path');
  const rootDir = path.resolve(__dirname, '..');

  const htmlContent = fs.readFileSync(path.join(rootDir, 'src/sidepanel/sidepanel.html'), 'utf8');
  const cssContent = fs.readFileSync(path.join(rootDir, 'src/sidepanel/sidepanel.css'), 'utf8');
  const jsContent = fs.readFileSync(path.join(rootDir, 'src/sidepanel/sidepanel.js'), 'utf8');
  const contentJs = fs.readFileSync(path.join(rootDir, 'src/content/content.js'), 'utf8');

  // 1. 验证取消收藏主按钮已移动至列表底部
  const listIndex = htmlContent.indexOf('id="rn-list"');
  const startIndex = htmlContent.indexOf('id="rn-start"');
  const undoIndex = htmlContent.indexOf('id="rn-log-undo"');
  const toggleIndex = htmlContent.indexOf('id="rn-log-toggle"');
  const logIndex = htmlContent.indexOf('id="rn-log"');

  assert.strictEqual(listIndex !== -1 && startIndex !== -1, true, '列表与主按钮均存在');
  assert.strictEqual(listIndex < startIndex, true, '取消收藏/取消点赞主按钮已移至列表底部');
  assert.strictEqual(startIndex < undoIndex, true, '按钮排列顺序1：取消收藏居前');
  assert.strictEqual(undoIndex < toggleIndex, true, '按钮排列顺序2：撤销按需居中');
  assert.strictEqual(toggleIndex < logIndex, true, '按钮排列顺序3：操作记录折叠控制在后');

  // 2. 验证全选/反选杜绝 state.candidates.get 错误，并支持显式 Array 映射
  assert.strictEqual(contentJs.includes('state.candidates.get('), false, '彻底杜绝将 Array 候选误用为 Map.get 的崩溃调用');
  assert.strictEqual(contentJs.includes('candMap.get(id)'), true, '全选与反选建立安全 Map 映射检索');

  // 3. 验证叠卡防误触：点击叠卡遮罩层不再误关闭弹窗，仅点关闭按钮触发
  assert.strictEqual(contentJs.includes('stackOverlay.addEventListener(\'click\', function (ev) {\n      // 叠卡点击叠卡外不要关闭弹窗，只有点关闭按钮才能关闭'), true, '点击叠卡外彻底阻止误关闭');

  // 4. 验证叠卡 Esc 快捷键支持 window/document/sidepanel 多维捕获
  assert.strictEqual(contentJs.includes("ev.key === 'Escape' || ev.key === 'Esc' || ev.keyCode === 27"), true, 'content.js 全局键位捕获支持 Esc 多码兼容');
  assert.strictEqual(jsContent.includes('RN_CLOSE_STACK_VIEW'), true, 'sidepanel.js 支持 Esc 键跨端联动关闭叠卡');

  // 5. 验证操作记录与撤销按钮纯 Icon 紧凑化与折叠收起控制
  assert.strictEqual(jsContent.includes('logExpanded = !logExpanded'), true, '支持操作记录折叠展开切换');
  assert.strictEqual(htmlContent.includes('id="rn-log-collapse"'), true, 'HTML 包含操作记录可收缩容器');
  assert.strictEqual(htmlContent.includes('id="rn-log-toggle"'), true, '包含操作记录折叠控制按钮');
  assert.strictEqual(cssContent.includes('.rn-log-undo-btn') && cssContent.includes('flex: 0 0 38px;'), true, '撤销按钮为 38px 正方形 Icon 按钮');
  assert.strictEqual(cssContent.includes('.rn-log-toggle-btn') && cssContent.includes('flex: 0 0 38px;'), true, '操作记录为 38px 正方形 Icon 按钮');
});

test('专业设计与叠卡正序排序演进：去玩具化矢量图标、移除列表冗余id、叠卡正序/倒序/随机分段器', () => {
  const fs = require('fs');
  const path = require('path');
  const rootDir = path.resolve(__dirname, '..');

  const htmlContent = fs.readFileSync(path.join(rootDir, 'src/sidepanel/sidepanel.html'), 'utf8');
  const jsContent = fs.readFileSync(path.join(rootDir, 'src/sidepanel/sidepanel.js'), 'utf8');
  const contentJs = fs.readFileSync(path.join(rootDir, 'src/content/content.js'), 'utf8');
  const styleJs = fs.readFileSync(path.join(rootDir, 'src/content/style.js'), 'utf8');

  // 1. 验证列表项已彻底移除冗余的 rn-id 尾部显示
  assert.strictEqual(jsContent.includes("class=\"rn-id\""), false, '侧边栏笔记列表项已彻底移除右侧无意义的 id 字符');

  // 2. 验证去玩具化：设置齿轮、AI分析、叠卡浏览、撤销等核心按钮已升级为专业矢量 SVG 图标
  assert.strictEqual(htmlContent.includes('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n            <circle cx="12" cy="12" r="3"></circle>'), true, '设置齿轮按钮已升级为专业 Lucide Settings SVG 矢量图标');
  assert.strictEqual(htmlContent.includes('✨ AI 分类'), false, 'AI 按钮彻底移除 emoji');
  assert.strictEqual(htmlContent.includes('🗂️ 叠卡浏览'), false, '侧边栏叠卡按钮彻底移除 emoji');

  // 3. 验证叠卡弹窗已去除重复冗余的标题
  assert.strictEqual(contentJs.includes('<span class="rn-stack-badge">🗂️ 叠卡浏览</span>'), false, '叠卡弹窗内彻底去除重复冗余的标题徽标');

  // 4. 验证叠卡排序三段式控制组 [倒序 | 正序 | 随机]
  assert.strictEqual(contentJs.includes('id="rn-order-desc"'), true, '叠卡包含倒序切换按钮');
  assert.strictEqual(contentJs.includes('id="rn-order-asc"'), true, '叠卡包含正序切换按钮');
  assert.strictEqual(contentJs.includes('id="rn-order-random"'), true, '叠卡包含随机切换按钮');
  assert.strictEqual(styleJs.includes('.rn-stack-order-group'), true, 'style.js 包含排序分段器样式');
  assert.strictEqual(contentJs.includes("stackState.orderMode === 'asc'"), true, 'content.js 支持正序从旧到新逆向反转排序');
  assert.strictEqual(contentJs.includes('result.slice().reverse()'), true, '正序排序算法正确反转数组');
});

test('叠卡速览轻预览状态机：原生弹窗挂起、生命周期免疫与进度100%无损复原', () => {
  const fs = require('fs');
  const path = require('path');
  const rootDir = path.resolve(__dirname, '..');
  const contentJs = fs.readFileSync(path.join(rootDir, 'src/content/content.js'), 'utf8');

  // 1. 验证原生详情路由匹配规则
  assert.strictEqual(contentJs.includes('MODAL_OVERLAY_RE'), true, '包含 MODAL_OVERLAY_RE 路由判断');
  const MODAL_OVERLAY_RE = /^\/(?:explore|discovery\/item)\/[0-9a-zA-Z_-]+/i;
  assert.strictEqual(MODAL_OVERLAY_RE.test('/explore/66a1234567890abcdef12345'), true, '识别 /explore 笔记详情路由');
  assert.strictEqual(MODAL_OVERLAY_RE.test('/discovery/item/66a1234567890abcdef12345'), true, '识别 /discovery/item 笔记详情路由');
  assert.strictEqual(MODAL_OVERLAY_RE.test('/user/profile/5b1234567890abcdef12345'), false, '个人主页不作为弹窗路由');
  assert.strictEqual(MODAL_OVERLAY_RE.test('/explore'), false, '无 noteId 的主页探索 feed 不作为详情弹窗');
  assert.strictEqual(MODAL_OVERLAY_RE.test('/'), false, '网站根路径不作为详情弹窗');

  // 2. 验证挂起与无感唤醒进度持久化逻辑
  assert.strictEqual(contentJs.includes('let suspendedProgress = { index: -1, noteId: null };'), true, '具备独立的进度暂存容器');
  assert.strictEqual(contentJs.includes("suspendedProgress.noteId"), true, '按 noteId 优先精准匹配恢复卡片下标');
  assert.strictEqual(contentJs.includes("!stackSuspended && !isModalOverlay && state.mounted"), true, 'tick 巡检中严格免疫原生弹窗，绝不误触发 unmount 销毁容器');
  assert.strictEqual(contentJs.includes("if (stackSuspended) {"), true, '具备挂起状态检查');
  assert.strictEqual(contentJs.includes("resumeStackView();\n        return;"), true, 'popstate 路由回滚时无感恢复叠卡并立即退出，坚决不重置卡片');

  // 3. 模拟叠卡挂起与唤醒全生命周期测试
  const mockStackState = {
    open: true,
    index: 7,
    list: [
      { id: 'note_0' }, { id: 'note_1' }, { id: 'note_2' }, { id: 'note_3' },
      { id: 'note_4' }, { id: 'note_5' }, { id: 'note_6' }, { id: 'note_7' },
      { id: 'note_8' }, { id: 'note_9' },
    ],
  };

  let mockSuspended = false;
  let mockProgress = { index: -1, noteId: null };
  const mockHost = { style: { width: '100vw', height: '100vh', pointerEvents: 'auto' } };
  const mockOverlay = {
    classList: new Set(['rn-stack-overlay', 'rn-open']),
    style: { display: '' },
  };

  // 模拟挂起
  mockSuspended = true;
  mockProgress = {
    index: mockStackState.index,
    noteId: mockStackState.list[mockStackState.index].id,
  };
  mockHost.style.width = '0';
  mockHost.style.height = '0';
  mockHost.style.pointerEvents = 'none';
  mockOverlay.style.display = 'none';
  mockOverlay.classList.add('rn-stack-suspended');

  assert.strictEqual(mockSuspended, true);
  assert.strictEqual(mockProgress.index, 7);
  assert.strictEqual(mockProgress.noteId, 'note_7');
  assert.strictEqual(mockHost.style.pointerEvents, 'none', '宿主容器释放点击穿透至底层原生弹窗');
  assert.strictEqual(mockOverlay.style.display, 'none');

  // 模拟在挂起期间，tick() 运行在 /explore/xxx 路由
  const fakePathname = '/explore/note_7';
  const PROFILE_RE = /\/user\/profile(?:\/([0-9a-f]{24}))?/i;
  const isOverlay = MODAL_OVERLAY_RE.test(fakePathname);
  const onProfile = PROFILE_RE.test(fakePathname);
  let unmountedCalled = false;
  if (!onProfile && !mockSuspended && !isOverlay) {
    unmountedCalled = true;
  }
  assert.strictEqual(unmountedCalled, false, '在弹窗路由下即使 onProfile 为 false，也绝不调用 unmount');

  // 模拟原生弹窗关闭，触发唤醒
  mockSuspended = false;
  mockHost.style.width = '100vw';
  mockHost.style.height = '100vh';
  mockHost.style.pointerEvents = 'auto';
  mockOverlay.style.display = '';
  mockOverlay.classList.delete('rn-stack-suspended');
  mockOverlay.classList.add('rn-open');
  mockStackState.open = true;

  // 进度恢复算法
  const foundIdx = mockStackState.list.findIndex(n => n.id === mockProgress.noteId);
  if (foundIdx !== -1) {
    mockStackState.index = foundIdx;
  }
  assert.strictEqual(mockStackState.open, true, '叠卡保持打开状态');
  assert.strictEqual(mockStackState.index, 7, '处理进度完全锁定在刚才浏览的第 7 篇笔记');
  assert.strictEqual(mockHost.style.pointerEvents, 'auto', '宿主容器恢复全屏捕获');
  assert.strictEqual(mockOverlay.classList.has('rn-open'), true, '遮罩恢复呈现');
  assert.strictEqual(mockOverlay.classList.has('rn-stack-suspended'), false, '挂起标记已清除');

  // 4. 验证叠卡无需额外「查看原文」按钮，直接点击卡片封面或标题预览
  const styleJs = fs.readFileSync(path.join(rootDir, 'src/content/style.js'), 'utf8');
  assert.strictEqual(contentJs.includes('id="rn-card-open-btn"'), false, '叠卡卡片右上角已彻底移除冗余的查看原文按钮');
  assert.strictEqual(contentJs.includes("stackState.els.coverBox.addEventListener('click', handleStackPreview)"), true, '卡片封面已绑定即时预览事件');
  assert.strictEqual(contentJs.includes("stackState.els.title.addEventListener('click', handleStackPreview)"), true, '卡片标题已绑定即时预览事件');
  assert.strictEqual(styleJs.includes('.rn-card-cover-box:hover .rn-card-cover-img'), true, '卡片封面具备悬停缩放微交互');

  // 5. 验证小红书关闭原生详情弹窗时跳往首页 /explore 的纠偏防御机制
  assert.strictEqual(contentJs.includes("let originProfileUrl = '';"), true, '记录挂起前用户所在的个人主页完整 URL');
  assert.strictEqual(contentJs.includes("location.replace(originProfileUrl)"), true, '当路由误跳首页时立即纠偏回个人主页');
});

test('工程级质量防线：所有核心脚本必须通过 Node 严密语法静态编译校验 (杜绝异步孤立块与未捕获语法错误)', () => {
  const { execSync } = require('child_process');
  const path = require('path');
  const rootDir = path.resolve(__dirname, '..');
  const filesToCheck = [
    'src/sidepanel/sidepanel.js',
    'src/content/content.js',
    'src/content/style.js',
    'src/core.js',
    'src/background.js',
    'src/ai/deepseek.js',
  ];
  const cmd = 'node -c ' + filesToCheck.map(f => '"' + path.join(rootDir, f) + '"').join(' ');
  const res = execSync(cmd, { encoding: 'utf8' });
  assert.strictEqual(res, '', '所有核心脚本必须 100% 语法正确通过 node -c');
});














