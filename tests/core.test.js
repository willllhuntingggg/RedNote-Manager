'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/core.js');

test('buildWrite 按模式/阶段映射到正确的接口和字段名', () => {
  assert.deepStrictEqual(C.buildWrite('uncollect', 'do', 'a'.repeat(24)), {
    action: 'uncollect',
    path: '/api/sns/web/v1/note/uncollect',
    method: 'POST',
    body: { note_ids: 'a'.repeat(24) },
  });
  assert.deepStrictEqual(C.buildWrite('uncollect', 'undo', 'b'.repeat(24)).body, { note_id: 'b'.repeat(24) });
  assert.deepStrictEqual(C.buildWrite('unlike', 'do', 'c'.repeat(24)).body, { note_oid: 'c'.repeat(24) });
  assert.deepStrictEqual(C.buildWrite('unlike', 'undo', 'd'.repeat(24)).body, { note_oid: 'd'.repeat(24) });
});

test('buildWrite 拒绝非法笔记 ID 和未知组合', () => {
  assert.throws(() => C.buildWrite('uncollect', 'do', 'not-an-id'), /不合法/);
  assert.throws(() => C.buildWrite('uncollect', 'do', ''), /不合法/);
  assert.throws(() => C.buildWrite('nope', 'do', 'a'.repeat(24)), /未知操作/);
  // 用户 ID 也是 24 位，但 23/25 位必须被拒
  assert.throws(() => C.buildWrite('unlike', 'do', 'a'.repeat(23)), /不合法/);
});

test('extractNoteId 只取笔记 ID，不把用户 ID 当笔记 ID', () => {
  const id = '64f0c1d2e3a4b5c6d7e8f901';
  assert.strictEqual(C.extractNoteId('/explore/' + id), id);
  assert.strictEqual(C.extractNoteId('https://www.xiaohongshu.com/explore/' + id + '?xsec_token=ABC'), id);
  assert.strictEqual(C.extractNoteId('/user/profile/5f1e2d3c4b5a69788796a5b4/' + id), id);
  assert.strictEqual(C.extractNoteId('/user/profile/5f1e2d3c4b5a69788796a5b4'), '');
  assert.strictEqual(C.extractNoteId('/search_result?keyword=abc'), '');
  assert.strictEqual(C.extractNoteId(''), '');
  // 大写十六进制统一小写
  assert.strictEqual(C.extractNoteId('/explore/' + id.toUpperCase()), id);

  // 提取用户 ID
  assert.strictEqual(C.extractUserId('/user/profile/5f1e2d3c4b5a69788796a5b4'), '5f1e2d3c4b5a69788796a5b4');
  assert.strictEqual(C.extractUserId('https://www.xiaohongshu.com/user/profile/5f1e2d3c4b5a69788796a5b4?tab=collect'), '5f1e2d3c4b5a69788796a5b4');

  // 提取 xsec_token 与生成带凭证的完整原文链接
  const testUrl = '/explore/' + id + '?xsec_token=AB1234567890Token&xsec_source=pc_user';
  assert.strictEqual(C.extractXsecToken(testUrl), 'AB1234567890Token');
  assert.strictEqual(C.extractXsecToken('/explore/' + id), '');
  assert.strictEqual(
    C.buildNoteUrl(id, 'AB1234567890Token'),
    'https://www.xiaohongshu.com/explore/' + id + '?xsec_token=AB1234567890Token&xsec_source=pc_user'
  );
  assert.strictEqual(
    C.buildNoteUrl({ id: id, xsecToken: 'AB1234567890Token' }),
    'https://www.xiaohongshu.com/explore/' + id + '?xsec_token=AB1234567890Token&xsec_source=pc_user'
  );
  assert.strictEqual(
    C.buildNoteUrl(testUrl),
    'https://www.xiaohongshu.com/explore/' + id + '?xsec_token=AB1234567890Token&xsec_source=pc_user'
  );

  // 严格实测：真实小红书带 = 结尾的 Base64 凭证，绝不可被错误编码为 %3D 导致鉴权失效
  const realSampleUrl = 'https://www.xiaohongshu.com/explore/66957156000000002501503d?xsec_token=ABQUEHMu1VfxzjQXtXSimxV7WokOA1b5d7lTwH_EykqqM=&xsec_source=pc_user';
  const realToken = 'ABQUEHMu1VfxzjQXtXSimxV7WokOA1b5d7lTwH_EykqqM=';
  assert.strictEqual(C.extractXsecToken(realSampleUrl), realToken);
  assert.strictEqual(C.buildNoteUrl('66957156000000002501503d', realToken), realSampleUrl);
  assert.strictEqual(C.buildNoteUrl(realSampleUrl), realSampleUrl);
  assert.strictEqual(C.buildNoteUrl({ id: '66957156000000002501503d', xsecToken: realToken }), realSampleUrl);
  // 容错：即使传入已误编码为 %3D 的 token，也能自动还原为原版 =
  assert.strictEqual(C.buildNoteUrl('66957156000000002501503d', 'ABQUEHMu1VfxzjQXtXSimxV7WokOA1b5d7lTwH_EykqqM%3D'), realSampleUrl);
});

test('clampSettings 兜底默认值并夹住危险输入', () => {
  const d = C.clampSettings(null);
  assert.strictEqual(d.dryRun, undefined, '演练模式已被移除');
  assert.strictEqual(d.mode, 'uncollect');

  const evil = C.clampSettings({ minDelay: 0, maxDelay: 1, maxPerRun: 99999, cooldownMs: -5, mode: 'rm-rf' });
  assert.strictEqual(evil.minDelay, 800);
  assert.strictEqual(evil.maxDelay, 800, 'maxDelay 不得低于 minDelay');
  assert.strictEqual(evil.maxPerRun, 200);
  assert.strictEqual(evil.cooldownMs, 0);
  assert.strictEqual(evil.mode, 'uncollect', '非法模式回落到默认');

  const ok = C.clampSettings({ mode: 'unlike', minDelay: 2000, maxDelay: 5000, keyword: '美食 -广告' });
  assert.strictEqual(ok.mode, 'unlike');
  assert.strictEqual(ok.minDelay, 2000);
  assert.strictEqual(ok.keyword, '美食 -广告');

  // 字符串数字（来自 input.value）也要能解析
  assert.strictEqual(C.clampSettings({ maxPerRun: '12' }).maxPerRun, 12);
});

test('isRiskResponse 能识别 461 空壳响应与风控文案', () => {
  assert.strictEqual(C.isRiskResponse({ code: 0, success: true, data: {} }, 461), true);
  assert.strictEqual(C.isRiskResponse({ code: -1 }, 200), true);
  assert.strictEqual(C.isRiskResponse({ code: 461 }, 200), true);
  assert.strictEqual(C.isRiskResponse({ code: 0, msg: '操作太频繁，请稍后再试' }, 200), true);
  assert.strictEqual(C.isRiskResponse({ code: 0, success: true }, 200), false);
  assert.strictEqual(C.isRiskResponse(null, 500), false, '500 是服务端错误，不当风控');
});

test('isSuccess 要求 code===0 且 success 不为 false', () => {
  assert.strictEqual(C.isSuccess({ code: 0, success: true }), true);
  assert.strictEqual(C.isSuccess({ code: 0, success: false }), false);
  assert.strictEqual(C.isSuccess({ code: -7000, msg: '该笔记暂不支持收藏' }), false);
  assert.strictEqual(C.isSuccess(null), false);
});

test('describeError 串出可排查的信息', () => {
  assert.match(C.describeError({ code: -7000, msg: '该笔记暂不支持收藏' }, 200), /code=-7000.*该笔记暂不支持收藏/);
  assert.match(C.describeError(null, 502), /HTTP 502/);
  const s = C.describeError({ code: 0, msg: 'x', message: 'y' }, 200);
  assert.match(s, /code=0/);
  assert.match(s, /message=y/);
});

test('关键词：包含 / 排除 / 空规则', () => {
  const t = C.parseKeywords('美食, 旅行, -广告, -抽奖');
  assert.deepStrictEqual(t.include, ['美食', '旅行']);
  assert.deepStrictEqual(t.exclude, ['广告', '抽奖']);
  assert.deepStrictEqual(C.parseKeywords('').include, []);

  const note = { id: 'a'.repeat(24), title: '周末去杭州吃美食' };
  assert.strictEqual(C.matchKeywords(note, t), true);
  assert.strictEqual(C.matchKeywords({ id: 'x', title: '美食广告' }, t), false, '排除词优先');
  assert.strictEqual(C.matchKeywords({ id: 'x', title: '读书笔记' }, t), false);
  assert.strictEqual(C.matchKeywords({ id: 'x', title: '读书笔记' }, C.parseKeywords('')), true, '无规则放行');
  // 中文逗号、大小写
  assert.deepStrictEqual(C.parseKeywords('A，b').include, ['a', 'b']);
});

test('delayBetween 落在区间内，且偶发长停顿', () => {
  // rnd 恒为 0 → 取区间下界，同时 0 < 0.08 命中长停顿分支（再 +1500ms 下界）
  assert.strictEqual(C.delayBetween(1000, 2000, () => 0), 2500);

  // rnd 恒为 0.5 → 不触发长停顿：1000 + floor(0.5 * 1001) = 1500
  assert.strictEqual(C.delayBetween(1000, 2000, () => 0.5), 1500);

  // 区间上界：0.999 → 1000 + 999 = 1999
  assert.strictEqual(C.delayBetween(1000, 2000, () => 0.999), 1999);

  // 下界保护：传 0 也要被夹到 800
  assert.strictEqual(C.delayBetween(0, 0, () => 0.5), 800);
});

test('shouldCooldown 按条数触发', () => {
  assert.strictEqual(C.shouldCooldown(20, 20), true);
  assert.strictEqual(C.shouldCooldown(19, 20), false);
  assert.strictEqual(C.shouldCooldown(40, 20), true);
  assert.strictEqual(C.shouldCooldown(0, 20), false);
  assert.strictEqual(C.shouldCooldown(5, 0), false);
});

test('summarize / formatDuration 输出人话', () => {
  assert.strictEqual(C.formatDuration(4200), '4 秒');
  assert.strictEqual(C.formatDuration(65000), '1 分 5 秒');
  assert.strictEqual(C.formatDuration(120000), '2 分');
  assert.match(C.summarize({ ok: 10, fail: 2, elapsedMs: 61000 }), /成功 10，失败 2，耗时 1 分 1 秒/);
  assert.match(C.summarize({ ok: 3, risk: true }), /已熔断/);
});

test('dedupeNotes 保留首个并丢弃空项', () => {
  const out = C.dedupeNotes([{ id: 'a', title: '1' }, { id: 'a', title: '2' }, null, { id: '' }, { id: 'b' }]);
  assert.deepStrictEqual(out.map((n) => n.id), ['a', 'b']);
  assert.strictEqual(out[0].title, '1');
});

test('selectRange 做 Shift 区间选择', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepStrictEqual(C.selectRange(ids, 1, 3), ['b', 'c', 'd']);
  assert.deepStrictEqual(C.selectRange(ids, 3, 1), ['b', 'c', 'd'], '反向拖动也应得到同样区间');
  assert.deepStrictEqual(C.selectRange(ids, 0, 0), ['a']);
  assert.deepStrictEqual(C.selectRange(ids, -5, 99), ids, '越界索引夹到边界');
  assert.deepStrictEqual(C.selectRange([], 0, 3), []);
  assert.deepStrictEqual(C.selectRange(ids, 'x', 2), ['a', 'b', 'c'], '非法索引回落为 0');
});

test('matchKeywords 也能匹配作者字段', () => {
  const terms = C.parseKeywords('张三');
  assert.strictEqual(C.matchKeywords({ id: 'x', title: '美食', author: '张三' }, terms), true);
  assert.strictEqual(C.matchKeywords({ id: 'x', title: '美食' }, terms), false);
});

test('findUndoTarget 能够清晰区分单篇撤销与批量撤销', () => {
  // 1. 空历史
  assert.strictEqual(C.findUndoTarget([], 'uncollect'), null);

  // 2. 模拟场景：先批量取消 3 篇，随后在叠卡模式逐篇划走/取消 2 篇
  const history = [
    { id: '111111111111111111111111', title: '批量笔记1', mode: 'uncollect', type: 'batch', batchId: 'batch_01', ts: 1000 },
    { id: '222222222222222222222222', title: '批量笔记2', mode: 'uncollect', type: 'batch', batchId: 'batch_01', ts: 1001 },
    { id: '333333333333333333333333', title: '批量笔记3', mode: 'uncollect', type: 'batch', batchId: 'batch_01', ts: 1002 },
    { id: '444444444444444444444444', title: '叠卡笔记A', mode: 'uncollect', type: 'single', batchId: 'single_A', ts: 2000 },
    { id: '555555555555555555555555', title: '叠卡笔记B', mode: 'uncollect', type: 'single', batchId: 'single_B', ts: 2010 },
  ];

  // 默认撤销上次：必须只撤销最后一条叠卡笔记B，绝对不能把前后的批量一并撤销！
  const t1 = C.findUndoTarget(history, 'uncollect');
  assert.notStrictEqual(t1, null);
  assert.strictEqual(t1.type, 'single');
  assert.strictEqual(t1.count, 1);
  assert.strictEqual(t1.noteId, '555555555555555555555555');
  assert.strictEqual(t1.items.length, 1);
  assert.strictEqual(t1.items[0].id, '555555555555555555555555');

  // 模拟笔记B被撤销
  history[4].undone = true;

  // 再次撤销上次：必须只撤销叠卡笔记A（仍然是单篇），不触及批量！
  const t2 = C.findUndoTarget(history, 'uncollect');
  assert.notStrictEqual(t2, null);
  assert.strictEqual(t2.type, 'single');
  assert.strictEqual(t2.count, 1);
  assert.strictEqual(t2.noteId, '444444444444444444444444');

  // 模拟笔记A被撤销
  history[3].undone = true;

  // 再次撤销上次：此时叠卡单篇均已撤销，撤销目标回退到上一次的批量操作（共 3 篇）
  const t3 = C.findUndoTarget(history, 'uncollect');
  assert.notStrictEqual(t3, null);
  assert.strictEqual(t3.type, 'batch');
  assert.strictEqual(t3.count, 3);
  assert.strictEqual(t3.batchId, 'batch_01');
  assert.deepStrictEqual(t3.items.map((n) => n.id), [
    '111111111111111111111111',
    '222222222222222222222222',
    '333333333333333333333333',
  ]);

  // 3. 显式指定 noteId（例如在操作记录列表某行点击撤销）
  const tSpecific = C.findUndoTarget(history, 'uncollect', { noteId: '222222222222222222222222' });
  assert.notStrictEqual(tSpecific, null);
  assert.strictEqual(tSpecific.type, 'single');
  assert.strictEqual(tSpecific.count, 1);
  assert.strictEqual(tSpecific.noteId, '222222222222222222222222');

  // 4. 显式指定 batchId
  const tBatch = C.findUndoTarget(history, 'uncollect', { batchId: 'batch_01' });
  assert.notStrictEqual(tBatch, null);
  assert.strictEqual(tBatch.type, 'batch');
  assert.strictEqual(tBatch.count, 3);

  // 5. 模式隔离测试：unlike 历史不被 uncollect 查询误读取
  const mixedHistory = [
    { id: '666666666666666666666666', title: '赞过的笔记', mode: 'unlike', type: 'single', ts: 3000 },
  ];
  assert.strictEqual(C.findUndoTarget(mixedHistory, 'uncollect'), null);
  const tLike = C.findUndoTarget(mixedHistory, 'unlike');
  assert.notStrictEqual(tLike, null);
  assert.strictEqual(tLike.mode, 'unlike');

  // 6. 老旧历史兜底（无 type 无 batchId 字段）
  const legacyHistory = [
    { id: '777777777777777777777777', title: '老版本笔记', mode: 'uncollect', ts: 500 },
  ];
  const tLegacy = C.findUndoTarget(legacyHistory, 'uncollect');
  assert.notStrictEqual(tLegacy, null);
  assert.strictEqual(tLegacy.type, 'single');
  assert.strictEqual(tLegacy.noteId, '777777777777777777777777');
});
