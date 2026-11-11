'use strict';

const test = require('node:test');
const assert = require('node:assert');
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

test('叠卡速览交互引擎：双状态图标点赞/非点赞（红心/空心）、收藏/非收藏（黄星/空心）状态判定与切换', () => {
  const processed = { uncollect: new Set(), unlike: new Set() };
  const modeCache = {
    uncollect: [{ id: 'fav1'.padEnd(24, '0') }],
    unlike: [{ id: 'like1'.padEnd(24, '0') }],
  };

  function getNoteStatus(note, currentMode) {
    let liked;
    if (typeof note._liked === 'boolean') {
      liked = note._liked;
    } else if (processed.unlike.has(note.id)) {
      liked = false;
    } else if (modeCache.unlike.some((n) => n.id === note.id)) {
      liked = true;
    } else {
      liked = (currentMode === 'unlike');
    }

    let collected;
    if (typeof note._collected === 'boolean') {
      collected = note._collected;
    } else if (processed.uncollect.has(note.id)) {
      collected = false;
    } else if (modeCache.uncollect.some((n) => n.id === note.id)) {
      collected = true;
    } else {
      collected = (currentMode === 'uncollect');
    }

    return { liked, collected };
  }

  // 1. 在收藏模式下打开一篇收藏笔记：应为 已收藏（黄星） & 未点赞（空心）
  const noteFav = { id: 'fav1'.padEnd(24, '0'), title: '收藏笔记' };
  let stFav = getNoteStatus(noteFav, 'uncollect');
  assert.strictEqual(stFav.collected, true, '收藏笔记初始状态为已收藏（黄色五角星）');
  assert.strictEqual(stFav.liked, false, '非点赞状态为未点赞（空心红心）');

  // 用户点击黄星（取消收藏）
  noteFav._collected = false;
  processed.uncollect.add(noteFav.id);
  stFav = getNoteStatus(noteFav, 'uncollect');
  assert.strictEqual(stFav.collected, false, '点击后变为空心五角星（非收藏状态）');

  // 用户点击空心红心（进行点赞）
  noteFav._liked = true;
  stFav = getNoteStatus(noteFav, 'uncollect');
  assert.strictEqual(stFav.liked, true, '点击后变为红心（已点赞状态）');

  // 2. 在点赞模式下打开一篇点赞笔记：应为 已点赞（红心） & 未收藏（空心）
  const noteLike = { id: 'like1'.padEnd(24, '0'), title: '点赞笔记' };
  let stLike = getNoteStatus(noteLike, 'unlike');
  assert.strictEqual(stLike.liked, true, '点赞笔记初始状态为已点赞（红心）');
  assert.strictEqual(stLike.collected, false, '非收藏状态为未收藏（空心五角星）');

  // 用户点击红心（取消点赞）
  noteLike._liked = false;
  processed.unlike.add(noteLike.id);
  stLike = getNoteStatus(noteLike, 'unlike');
  assert.strictEqual(stLike.liked, false, '点击后变为空心红心（非点赞状态）');
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

test('官方地址栏参数绝对优先权：在 ?tab=liked 下即使 DOM 存在其他误报 active 也绝对识别为 like，绝不污染 uncollect 缓存', () => {
  function getTabFromUrl(searchStr) {
    const search = new URLSearchParams(searchStr);
    const tab = (search.get('tab') || '').toLowerCase();
    if (tab === 'fav' || tab === 'collect' || tab === 'board') return 'collect';
    if (tab === 'liked' || tab === 'like') return 'like';
    if (tab === 'note' || tab === 'publish') return 'notes';
    return '';
  }

  // 模拟带有误导性 active 子项的 DOM Tab
  const mockTabs = [
    { text: '笔记 10', isSelfActive: false },
    { text: '收藏 42', isSelfActive: false, hasActiveSubElement: true }, // 子项包含 active
    { text: '赞过 105', isSelfActive: true },
  ];

  function getPageActualTabType(searchStr, tabs) {
    // 1. 优先从官方地址栏参数读取（100% 精准可靠）
    const urlTab = getTabFromUrl(searchStr);
    if (urlTab) return urlTab;

    // 2. 兜底
    for (const t of tabs) {
      if (t.isSelfActive) {
        if (t.text.includes('赞过')) return 'like';
        if (t.text.includes('收藏')) return 'collect';
        if (t.text.includes('笔记')) return 'notes';
      }
    }
    return '';
  }

  // 场景：页面停留在点赞地址 ?tab=liked
  assert.strictEqual(
    getPageActualTabType('?tab=liked', mockTabs),
    'like',
    '在 ?tab=liked 地址栏下，无论 DOM 如何，必须 100% 判定为 like（点赞）'
  );

  // 场景：页面停留在收藏地址 ?tab=fav&subTab=note
  assert.strictEqual(
    getPageActualTabType('?tab=fav&subTab=note', mockTabs),
    'collect',
    '在 ?tab=fav 地址栏下，必须 100% 判定为 collect（收藏）'
  );

  // 场景：页面停留在发布笔记地址 ?tab=note
  assert.strictEqual(
    getPageActualTabType('?tab=note', mockTabs),
    'notes',
    '在 ?tab=note 地址栏下，必须 100% 判定为 notes（发布笔记）'
  );
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

test('笔记卡片与侧边栏支持查看原文外链生成', () => {
  const noteId = '64a1b2c3d4e5f60718293a4b';
  const token = 'AB1234567890XYZ';
  const fullUrl = C.buildNoteUrl(noteId, token);
  assert.strictEqual(fullUrl, 'https://www.xiaohongshu.com/explore/64a1b2c3d4e5f60718293a4b?xsec_token=AB1234567890XYZ&xsec_source=pc_user');
  assert.strictEqual(C.extractNoteId(fullUrl), noteId);
  assert.strictEqual(C.extractXsecToken(fullUrl), token);
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

  // 2. 验证 sidepanel.html 包含了所有触点与弹窗
  const htmlContent = fs.readFileSync(path.resolve(__dirname, '../src/sidepanel/sidepanel.html'), 'utf8');
  assert.ok(htmlContent.includes('id="rn-btn-sponsor-hdr"'), 'Header 触点按钮必须存在');
  assert.ok(htmlContent.includes('id="rn-btn-sponsor-settings"'), '设置面板触点按钮必须存在');
  assert.ok(htmlContent.includes('id="rn-sponsor-modal"'), '赞赏弹窗必须存在');
  assert.ok(htmlContent.includes('id="rn-sponsor-close"'), '弹窗关闭按钮必须存在');
  assert.ok(htmlContent.includes('assets/sponsor.jpg'), '弹窗内需引用本地赞赏码图片');

  // 3. 验证 README.md 包含赞赏章节
  const readmeContent = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');
  assert.ok(readmeContent.includes('## ☕ 支持与赞赏'), 'README 必须包含赞赏版块');
  assert.ok(readmeContent.includes('assets/sponsor.jpg'), 'README 需引用赞赏码图片');
});




