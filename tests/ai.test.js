'use strict';

const test = require('node:test');
const assert = require('node:assert');
const RNAI = require('../src/ai.js');
const C = require('../src/core.js');

test('RNAI cleanJsonText 能够正确提取并清洗各种 Markdown 与杂文字符', () => {
  // 1. 标准 JSON
  assert.strictEqual(RNAI.cleanJsonText('{"status":"ok"}'), '{"status":"ok"}');

  // 2. 带 ```json 代码块
  const fenced = '```json\n{"items":{"note1":{"category":"学习干货","decision":"干货保值"}}}\n```';
  assert.strictEqual(
    RNAI.cleanJsonText(fenced),
    '{"items":{"note1":{"category":"学习干货","decision":"干货保值"}}}'
  );

  // 3. 含有首尾杂乱问候语
  const chatty = 'Here is your analysis result:\n{"items":{"123":{"decision":"时效过期"}}}\nHope this helps!';
  assert.strictEqual(RNAI.cleanJsonText(chatty), '{"items":{"123":{"decision":"时效过期"}}}');

  // 4. 空值兜底
  assert.strictEqual(RNAI.cleanJsonText(null), '{}');
  assert.strictEqual(RNAI.cleanJsonText(''), '{}');
});

test('RNAI cleanApiKey 能够正确清理各种带前缀、引号及隐形字符的密钥', () => {
  // 1. 标准 key
  assert.strictEqual(RNAI.cleanApiKey('sk-1234567890abcdef'), 'sk-1234567890abcdef');
  // 2. 带 Bearer 前缀
  assert.strictEqual(RNAI.cleanApiKey('Bearer sk-1234567890abcdef'), 'sk-1234567890abcdef');
  assert.strictEqual(RNAI.cleanApiKey('bearer  sk-1234567890abcdef'), 'sk-1234567890abcdef');
  // 3. 带双引号、单引号或反引号
  assert.strictEqual(RNAI.cleanApiKey('"sk-1234567890abcdef"'), 'sk-1234567890abcdef');
  assert.strictEqual(RNAI.cleanApiKey("'sk-1234567890abcdef'"), 'sk-1234567890abcdef');
  assert.strictEqual(RNAI.cleanApiKey('`sk-1234567890abcdef`'), 'sk-1234567890abcdef');
  // 4. 带键名前缀 (api_key: sk-... 或 API_KEY=sk-...)
  assert.strictEqual(RNAI.cleanApiKey('api_key: sk-1234567890abcdef'), 'sk-1234567890abcdef');
  assert.strictEqual(RNAI.cleanApiKey('API_KEY = sk-1234567890abcdef'), 'sk-1234567890abcdef');
  assert.strictEqual(RNAI.cleanApiKey('token: sk-1234567890abcdef'), 'sk-1234567890abcdef');
  // 5. 带有全角空格、不可见零宽字符、BOM与制表符/换行符
  assert.strictEqual(RNAI.cleanApiKey('\uFEFF\u200Bsk-1234567890abcdef\u00A0\r\n\t'), 'sk-1234567890abcdef');
  // 6. 空值处理
  assert.strictEqual(RNAI.cleanApiKey(null), '');
  assert.strictEqual(RNAI.cleanApiKey(undefined), '');
  assert.strictEqual(RNAI.cleanApiKey('   '), '');
});

test('RNAI testConnection 与 analyzeNotes 参数与密钥校验', async () => {
  // 空 Key 时 testConnection 必须优雅返回未授权错误，不抛异常
  const resEmpty = await RNAI.testConnection({ apiKey: '' });
  assert.strictEqual(resEmpty.ok, false);
  assert.match(resEmpty.error, /API Key/);

  // 空 Key 时 analyzeNotes 必须抛出明确提示
  await assert.rejects(
    async () => {
      await RNAI.analyzeNotes({ apiKey: ' ' }, [{ id: '1', title: 'test' }]);
    },
    /未配置 DeepSeek API Key/
  );

  // 空笔记数组时直接返回空对象，不发起网络请求
  const resBlank = await RNAI.analyzeNotes({ apiKey: 'sk-test' }, []);
  assert.deepStrictEqual(resBlank, {});
});

test('RNAI DECISION_META 覆盖四个核心决策辅助属性且包含提示说明', () => {
  const meta = RNAI.DECISION_META;
  assert.ok(meta['时效过期']);
  assert.ok(meta['营销广告']);
  assert.ok(meta['干货保值']);
  assert.ok(meta['普通浏览']);

  assert.strictEqual(meta['时效过期'].type, 'warn');
  assert.strictEqual(meta['干货保值'].type, 'safe');
});

test('AI 标签与关键词联合过滤及筛选命中逻辑', () => {
  const mockCandidates = [
    { id: 'note_1', title: '2023上海迪士尼限时特惠门票抢购攻略', author: '旅游达人' },
    { id: 'note_2', title: 'Python高并发网络编程核心指南精讲', author: '代码极客' },
    { id: 'note_3', title: '好物推荐！这个美白精华亲测绝了赶紧冲', author: '种草小能手' },
    { id: 'note_4', title: '日常日落随拍调色分享', author: '摄影师' },
    { id: 'note_5', title: '2022考研英语真题限时领取已截止', author: '考研学长' },
  ];

  const mockAiTags = {
    note_1: { category: '旅游出行', decision: '时效过期', reason: '2023年限时优惠已过期' },
    note_2: { category: '学习干货', decision: '干货保值', reason: '系统性技术教程' },
    note_3: { category: '美妆穿搭', decision: '营销广告', reason: '产品推广软广' },
    note_4: { category: '生活家居', decision: '普通浏览', reason: '日常分享记录' },
    note_5: { category: '学习干货', decision: '时效过期', reason: '考研资料已截止' },
  };

  function filterVisible(candidates, query, tagFilter) {
    let list = (candidates || []).slice();
    if (query) {
      const terms = C.parseKeywords(query);
      list = list.filter((n) => C.matchKeywords(n, terms));
    }
    if (tagFilter && tagFilter !== 'all') {
      list = list.filter((n) => {
        const info = mockAiTags[n.id];
        if (!info) return false;
        return info.decision === tagFilter || info.category === tagFilter;
      });
    }
    return list;
  }

  // 1. 无标签无关键词：返回全部 5 篇
  assert.strictEqual(filterVisible(mockCandidates, '', 'all').length, 5);

  // 2. 筛选决策标签「时效过期」：命中 note_1 与 note_5
  const expired = filterVisible(mockCandidates, '', '时效过期');
  assert.strictEqual(expired.length, 2);
  assert.deepStrictEqual(expired.map(n => n.id), ['note_1', 'note_5']);

  // 3. 筛选决策标签「干货保值」：命中 note_2
  const useful = filterVisible(mockCandidates, '', '干货保值');
  assert.strictEqual(useful.length, 1);
  assert.strictEqual(useful[0].id, 'note_2');

  // 4. 筛选分类「学习干货」：命中 note_2 与 note_5
  const study = filterVisible(mockCandidates, '', '学习干货');
  assert.strictEqual(study.length, 2);

  // 5. 联合过滤：分类「学习干货」 + 关键词「限时」：精准命中 note_5
  const combined = filterVisible(mockCandidates, '限时', '学习干货');
  assert.strictEqual(combined.length, 1);
  assert.strictEqual(combined[0].id, 'note_5');
});

test('基于 AI 筛选结果支持一键精准全选与反选 (explicitIds)', () => {
  const selected = new Map();
  const allCandidates = new Map([
    ['id_1', { id: 'id_1', title: '过期笔记1' }],
    ['id_2', { id: 'id_2', title: '优质笔记2' }],
    ['id_3', { id: 'id_3', title: '过期笔记3' }],
  ]);

  function selectAllExplicit(ids) {
    ids.forEach(id => {
      const note = allCandidates.get(id);
      if (note) selected.set(id, note);
    });
  }

  function invertExplicit(ids) {
    ids.forEach(id => {
      if (selected.has(id)) selected.delete(id);
      else {
        const note = allCandidates.get(id);
        if (note) selected.set(id, note);
      }
    });
  }

  // 场景：用户点击「⚠️ 时效过期」胶囊，当前可见为 ['id_1', 'id_3']
  const expiredIds = ['id_1', 'id_3'];

  // 点击全选命中：只全选当前筛选的过期笔记，绝不误选优质笔记 id_2
  selectAllExplicit(expiredIds);
  assert.strictEqual(selected.size, 2);
  assert.strictEqual(selected.has('id_1'), true);
  assert.strictEqual(selected.has('id_2'), false);
  assert.strictEqual(selected.has('id_3'), true);

  // 点击反选：取消已选中的过期笔记，重新反转
  invertExplicit(expiredIds);
  assert.strictEqual(selected.size, 0);
});
