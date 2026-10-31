'use strict';
/*
 * 搜索 + 勾选/区间选择 的端到端测试
 * ---------------------------------------------------------------
 * 覆盖用户要求的两件事：
 *   1. 对「已读取（缓存）的候选」做搜索，并对搜索结果批量处理
 *   2. 手动勾选 + Shift 区间选择，且执行范围严格等于勾选集合
 */
const fs = require('fs');
const path = require('path');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.error('这个测试需要 jsdom：npm i -D jsdom');
  process.exit(1);
}

const ROOT = process.argv[2] || path.resolve(__dirname, '../..');
const UID = '5f1e2d3c4b5a69788796a5b4';

const NOTES = [
  { id: 'a1b2c3d4e5f60718293a4b01', title: '杭州这家咖啡馆很好喝' },
  { id: 'a1b2c3d4e5f60718293a4b02', title: '成都火锅探店' },
  { id: 'a1b2c3d4e5f60718293a4b03', title: '上海看展记录' },
  { id: 'a1b2c3d4e5f60718293a4b04', title: '北京书店清单' },
  { id: 'a1b2c3d4e5f60718293a4b05', title: '广州糖水铺' },
];

const cardsHtml = NOTES.map(
  (n, i) =>
    `<section class="note-item"><a class="cover" href="/explore/${n.id}?xsec_token=x"><img alt="备${i}"></a>` +
    `<div class="footer"><div class="title"><span>${n.title}</span></div></div></section>`
).join('');

function makeApp() {
  const html = `<!doctype html><html><body><div class="user-page">
    <div class="user-info"><button>编辑资料</button></div>
    <div class="tab-bar">
      <div class="reds-tab-item sub-tab-list active">笔记 20</div>
      <div class="reds-tab-item sub-tab-list">收藏 5</div>
    </div>
    <div class="feeds-container">${cardsHtml}</div></div></body></html>`;

  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', (e) => { if (!/scroll/.test(e.message)) errors.push(e.message); });

  const dom = new JSDOM(html, {
    url: `https://www.xiaohongshu.com/user/profile/${UID}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const win = dom.window;
  const store = {};
  const listeners = [];
  const calls = [];

  win.chrome = {
    storage: {
      local: {
        get: (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (store[k] !== undefined) out[k] = store[k]; });
          return Promise.resolve(out);
        },
        set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
      },
    },
    runtime: { onMessage: { addListener: (f) => listeners.push(f) }, sendMessage: () => Promise.resolve() },
  };

  function reply(msg, extra) {
    win.dispatchEvent(new win.MessageEvent('message', {
      data: Object.assign({ source: 'RN_BRIDGE', id: msg.id, ok: true }, extra),
      source: win,
      origin: win.location.origin,
    }));
  }
  win.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || m.source !== 'RN_UI') return;
    if (m.kind === 'ping') return reply(m, { signer: true, me: UID });
    if (m.kind === 'me') return reply(m, { me: UID });
    if (m.kind === 'call') { calls.push(m); return reply(m, { status: 200, payload: { code: 0, success: true } }); }
  });

  win.document.querySelectorAll('.reds-tab-item').forEach((t) => {
    t.addEventListener('click', () => {
      win.document.querySelectorAll('.reds-tab-item').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
    });
  });
  win.confirm = () => true;

  for (const r of ['src/core.js', 'src/content/style.js', 'src/content/content.js']) {
    win.eval(fs.readFileSync(path.join(ROOT, r), 'utf8'));
  }

  const shadow = () => win.document.getElementById('rn-manager-host').shadowRoot;
  const state = () => win.__rnManager.state;

  return {
    win,
    store,
    calls,
    errors,
    shadow,
    state,
    action: (a) => listeners.forEach((fn) => fn({ type: 'RN_ACTION', action: a }, {}, () => {})),
    rows: () => Array.from(shadow().querySelectorAll('.rn-item')),
    text: (sel) => (shadow().querySelector(sel) || {}).textContent || '',
    click: (sel) => shadow().querySelector(sel).click(),
    clickRow: (idx) => {
      const row = shadow().querySelectorAll('.rn-item')[idx];
      row.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    },
    shiftClickRow: (idx) => {
      const row = shadow().querySelectorAll('.rn-item')[idx];
      row.dispatchEvent(new win.MouseEvent('click', { bubbles: true, shiftKey: true }));
    },
    type: (text) => {
      const q = shadow().querySelector('#rn-q');
      q.value = text;
      q.dispatchEvent(new win.Event('input', { bubbles: true }));
    },
    selectedIds: () => Array.from(state().selected.keys()),
    logs: () => state().logs.map((l) => l.kind + ' ' + l.msg).join('\n'),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(step); }
  return false;
};

/** action('start') 是异步的，先等它真正进入 running，再等它结束 */
async function runToEnd(app, timeout = 30000) {
  app.action('start');
  await wait(500);
  const done = await waitFor(() => app.state().running === false, timeout);
  if (!done) throw new Error('运行超时');
  await wait(300);
}

const failures = [];
function check(cond, name, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !detail ? '' : ' — ' + detail));
  if (!cond) failures.push(name);
}

(async () => {
  const app = makeApp();
  await wait(300);

  app.action('scan');
  const scanned = await waitFor(() => app.state().candidates.length === NOTES.length, 15000);
  check(scanned, '扫描到 ' + NOTES.length + ' 篇候选（实际 ' + app.state().candidates.length + '）');
  check(app.state().selected.size === 0, '扫描后默认不勾选任何笔记');

  /* ---------- 1. 搜索（只过滤显示，不触发任何请求） ---------- */
  console.log('\n## 搜索');
  check(app.rows().length === 5, '初始列表 5 行（实际 ' + app.rows().length + '）');
  check(app.text('#rn-hit') === '5/5', '命中计数 5/5（实际 ' + app.text('#rn-hit') + '）');

  app.type('咖啡');
  check(app.rows().length === 1, '搜「咖啡」只剩 1 行（实际 ' + app.rows().length + '）');
  check(app.text('#rn-hit') === '1/5', '命中计数 1/5（实际 ' + app.text('#rn-hit') + '）');
  check(app.rows()[0].textContent.indexOf('杭州') !== -1, '筛出的是「杭州咖啡馆」');

  app.type('成都 上海');
  check(app.rows().length === 2, '多关键词取并集：2 行（实际 ' + app.rows().length + '）');

  app.type('火锅 -成都');
  check(app.rows().length === 0, '排除词生效：0 行（实际 ' + app.rows().length + '）');
  check(/没有匹配/.test(app.shadow().querySelector('#rn-list').textContent), '空结果有提示');

  app.type('b04');
  check(app.rows().length === 1, '按 id 片段搜索：1 行（实际 ' + app.rows().length + '）');
  app.type('');
  check(app.rows().length === 5, '清空搜索恢复 5 行');

  /* ---------- 2. 手动勾选 / Shift 区间 / 反选 ---------- */
  console.log('\n## 手动勾选与区间选择');
  app.clickRow(1);
  check(app.state().selected.size === 1, '点击第 2 行勾选 1 篇（实际 ' + app.state().selected.size + '）');
  check(app.rows()[1].classList.contains('rn-sel'), '第 2 行显示选中态');
  check(app.text('#rn-s-sel') === '1', '已勾选计数为 1');
  check(app.text('#rn-sel-count').indexOf('已选 1') === 0, '工具条显示已选 1');
  app.clickRow(1);
  check(app.state().selected.size === 0, '再点一次取消勾选');

  app.clickRow(0);
  app.shiftClickRow(3);
  check(app.state().selected.size === 4, 'Shift 区间选中 0–3 共 4 篇（实际 ' + app.state().selected.size + '）');
  check(
    JSON.stringify(app.selectedIds().slice().sort()) === JSON.stringify(NOTES.slice(0, 4).map((n) => n.id).sort()),
    '区间选中的 id 正确'
  );

  app.click('#rn-sel-invert');
  check(app.state().selected.size === 1, '反选后剩 1 篇（5 可见 - 4 已选）');
  check(app.selectedIds()[0] === NOTES[4].id, '反选留下的是第 5 行');

  /* ---------- 3. 只执行勾选的子集 ---------- */
  console.log('\n## 只执行勾选的子集');
  app.click('#rn-sel-clear');
  app.clickRow(3); // 北京书店
  app.clickRow(4); // 广州糖水铺
  check(app.state().selected.size === 2, '手动勾选 2 篇');
  check(app.text('#rn-start').indexOf('2 篇') !== -1, '开始按钮显示 2 篇（实际「' + app.text('#rn-start') + '」）');

  app.state().settings.minDelay = 800;
  app.state().settings.maxDelay = 800;
  app.state().settings.maxPerRun = 10;
  app.calls.length = 0;
  await runToEnd(app);

  check(app.calls.length === 2, '只发 2 次请求（实际 ' + app.calls.length + '）');
  const called = app.calls.map((c) => c.body.note_ids).sort();
  check(
    JSON.stringify(called) === JSON.stringify([NOTES[3].id, NOTES[4].id].sort()),
    '只处理了勾选的两条：' + called.join(',')
  );
  check(app.state().selected.size === 0, '处理成功后自动取消勾选');

  /* ---------- 4. 已处理行不可再选 ---------- */
  check(app.rows().filter((r) => r.classList.contains('rn-done')).length === 2, '2 行显示为已处理');
  const before = app.state().selected.size;
  app.clickRow(3);
  check(app.state().selected.size === before, '点击已处理行不会改变勾选');

  /* ---------- 5. 搜索 → 全选命中 → 批量处理 ---------- */
  console.log('\n## 搜索结果批量处理');
  app.type('上海');
  check(app.rows().length === 1, '搜「上海」剩 1 行');
  app.click('#rn-sel-all');
  check(app.state().selected.size === 1, '「全选命中」只选中命中的 1 篇（实际 ' + app.state().selected.size + '）');
  check(app.text('#rn-start').indexOf('1 篇') !== -1, '开始按钮显示 1 篇（实际「' + app.text('#rn-start') + '」）');

  app.type('');
  check(app.state().selected.size === 1, '清空搜索后勾选仍然保留');
  check(app.text('#rn-sel-count').indexOf('已选 1') === 0, '已选计数保持 1（实际 ' + app.text('#rn-sel-count') + '）');

  app.calls.length = 0;
  await runToEnd(app);
  check(app.calls.length === 1, '搜索结果批量处理：只发 1 次请求（实际 ' + app.calls.length + '）');
  check(
    app.calls[0] && app.calls[0].body.note_ids === NOTES[2].id,
    '处理的是搜索命中的那条（' + (app.calls[0] && app.calls[0].body.note_ids) + '）'
  );

  /* ---------- 6. 没有勾选时给明确提示 ---------- */
  console.log('\n## 空勾选保护');
  app.click('#rn-sel-clear');
  app.calls.length = 0;
  app.action('start');
  await wait(600);
  check(app.calls.length === 0, '未勾选时不发任何请求');
  check(/还没有勾选/.test(app.logs()), '未勾选时日志给出操作提示');

  check(app.errors.length === 0, '无未捕获页面错误' + (app.errors.length ? '：' + app.errors[0] : ''));

  console.log('\n' + (failures.length ? 'FAILED ' + failures.length + ': ' + failures.join(' | ') : 'ALL PASS'));
  app.win.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});
