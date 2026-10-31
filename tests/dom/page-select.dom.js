'use strict';
/*
 * 页面卡片勾选测试
 * ---------------------------------------------------------------
 * 验证勾选框确实贴在真实的小红书卡片上（能看封面选），并与面板状态双向同步：
 *   注入徽标 / 点击切换 / Shift 区间 / 选中描边 / 搜索时暗化 / 已处理不可选 /
 *   虚拟列表新增卡片自动补齐 / 非目标标签页不响应
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
  { id: 'b1b2c3d4e5f60718293a4c01', title: '杭州这家咖啡馆很好喝' },
  { id: 'b1b2c3d4e5f60718293a4c02', title: '成都火锅探店' },
  { id: 'b1b2c3d4e5f60718293a4c03', title: '上海看展记录' },
  { id: 'b1b2c3d4e5f60718293a4c04', title: '北京书店清单' },
  { id: 'b1b2c3d4e5f60718293a4c05', title: '广州糖水铺' },
];

const cardHtml = (n, i) =>
  `<section class="note-item"><a class="cover" href="/explore/${n.id}?xsec_token=x">` +
  `<img alt="备${i}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>` +
  `<div class="footer"><div class="title"><span>${n.title}</span></div></div></section>`;

function makeApp() {
  const html = `<!doctype html><html><body><div class="user-page">
    <div class="user-info"><button>编辑资料</button></div>
    <div class="tab-bar">
      <div class="reds-tab-item sub-tab-list active">笔记 20</div>
      <div class="reds-tab-item sub-tab-list">收藏 5</div>
    </div>
    <div class="feeds-container">${NOTES.map(cardHtml).join('')}</div></div></body></html>`;

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

  const tabs = win.document.querySelectorAll('.reds-tab-item');
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
    });
  });
  win.confirm = () => true;

  for (const r of ['src/core.js', 'src/content/style.js', 'src/content/content.js']) {
    win.eval(fs.readFileSync(path.join(ROOT, r), 'utf8'));
  }

  const shadow = () => win.document.getElementById('rn-manager-host').shadowRoot;
  const state = () => win.__rnManager.state;
  const badges = () => Array.from(win.document.querySelectorAll('.rn-pick'));
  const cards = () => Array.from(win.document.querySelectorAll('.note-item'));

  return {
    win,
    store,
    calls,
    errors,
    shadow,
    state,
    badges,
    cards,
    action: (a) => listeners.forEach((fn) => fn({ type: 'RN_ACTION', action: a }, {}, () => {})),
    text: (sel) => (shadow().querySelector(sel) || {}).textContent || '',
    type: (text) => {
      listeners.forEach((fn) => fn({ type: 'RN_SET_KEYWORD', keyword: text }, {}, () => {}));
    },
    clickBadge: (idx, shift) => {
      const b = badges()[idx];
      b.dispatchEvent(new win.MouseEvent('click', { bubbles: true, shiftKey: !!shift }));
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

const failures = [];
function check(cond, name, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !detail ? '' : ' — ' + detail));
  if (!cond) failures.push(name);
}

(async () => {
  const app = makeApp();
  await wait(300);

  /* ---------- 1. 注入 ---------- */
  console.log('\n## 徽标注入');
  check(app.badges().length === 5, '5 张卡片各有一个勾选框（实际 ' + app.badges().length + '）');
  check(app.cards()[0].style.position === 'relative', '卡片被设为相对定位，徽标才能贴角');
  check(app.badges()[0].getAttribute('role') === 'checkbox', '徽标有 checkbox 语义');
  check(app.badges()[0].getAttribute('aria-checked') === 'false', '默认未选中');

  app.action('scan');
  const scanned = await waitFor(() => app.state().candidates.length === 5, 15000);
  check(scanned, '扫描到 5 篇候选');

  /* ---------- 2. 点击勾选 ---------- */
  console.log('\n## 点击勾选');
  app.clickBadge(1);
  check(app.state().selected.size === 1, '点第 2 张卡片勾选 1 篇（实际 ' + app.state().selected.size + '）');
  check(app.selectedIds()[0] === NOTES[1].id, '勾选的是第 2 张卡片对应的笔记');
  check(app.cards()[1].classList.contains('rn-card-sel'), '卡片出现选中描边');
  check(app.badges()[1].getAttribute('aria-checked') === 'true', '徽标切换为选中态');
  check(app.text('#rn-bar-count') === '1', '页面反馈栏「已选条数」实时同步为 1（实际 ' + app.text('#rn-bar-count') + '）');
  check(app.win.location.pathname.indexOf('/user/profile/') === 0, '点击徽标没有跳转页面');

  /* ---------- 3. Shift 区间 ---------- */
  console.log('\n## Shift 区间（按页面顺序）');
  app.clickBadge(3, true);
  check(app.state().selected.size === 3, 'Shift 点第 4 张：选中第 2–4 张共 3 篇（实际 ' + app.state().selected.size + '）');
  check(
    JSON.stringify(app.selectedIds().slice().sort()) === JSON.stringify(NOTES.slice(1, 4).map((n) => n.id).sort()),
    '区间内 id 正确'
  );

  /* ---------- 4. 取消勾选 ---------- */
  app.clickBadge(1);
  check(app.state().selected.size === 2, '再点一次取消，剩 2 篇');
  check(!app.cards()[1].classList.contains('rn-card-sel'), '描边随之消失');

  /* ---------- 5. 页面上新出现的卡片（虚拟列表） ---------- */
  console.log('\n## 虚拟列表新增卡片');
  const extra = { id: 'b1b2c3d4e5f60718293a4c09', title: '新刷出来的笔记' };
  app.win.document.querySelector('.feeds-container').insertAdjacentHTML('beforeend', cardHtml(extra, 9));
  const grew = await waitFor(() => app.badges().length === 6, 3000);
  check(grew, '巡检自动给新卡片补上勾选框（实际 ' + app.badges().length + '）');
  app.clickBadge(5);
  check(app.state().selected.size === 3, '新卡片也能直接勾选');
  check(app.state().candidates.length === 6, '页面上勾选的新笔记自动加入候选（实际 ' + app.state().candidates.length + '）');

  /* ---------- 6. 搜索时暗化不匹配的卡片 ---------- */
  console.log('\n## 搜索联动');
  app.type('成都');
  check(app.cards()[1].classList.contains('rn-card-dim') === false, '命中的卡片不暗化');
  check(app.cards()[0].classList.contains('rn-card-dim') === true, '不命中的卡片被暗化');
  check(app.badges().length === 6, '暗化不影响徽标数量');
  app.type('');

  /* ---------- 7. 跑完后已处理不可再选 ---------- */
  console.log('\n## 已处理状态');
  app.state().settings.minDelay = 800;
  app.state().settings.maxDelay = 800;
  app.state().settings.maxPerRun = 10;
  app.action('start');
  await wait(500);
  await waitFor(() => app.state().running === false, 30000);
  await wait(300);

  const doneBadges = app.badges().filter((b) => b.classList.contains('rn-done'));
  check(doneBadges.length === 3, '3 个徽标变为已处理（实际 ' + doneBadges.length + '）');
  const before = app.state().selected.size;
  app.clickBadge(2); // 上海看展，刚处理过
  check(app.state().selected.size === before, '点已处理的徽标不改变勾选');
  check(/已经处理过/.test(app.logs()), '并给出「已经处理过」提示');

  /* ---------- 8. 非目标标签页不响应 ---------- */
  console.log('\n## 标签页守卫');
  app.win.document.querySelectorAll('.reds-tab-item')[0].click(); // 切到「笔记」
  await wait(700);
  check(app.win.document.documentElement.getAttribute('data-rn-tab') === '0', '非收藏/赞过页时标记为不可勾选');
  const b2 = app.state().selected.size;
  app.clickBadge(4);
  check(app.state().selected.size === b2, '此时点徽标不会改变勾选');
  check(/先切换标签页/.test(app.logs()), '提示先切回对应列表');

  check(app.errors.length === 0, '无未捕获页面错误' + (app.errors.length ? '：' + app.errors[0] : ''));

  console.log('\n' + (failures.length ? 'FAILED ' + failures.length + ': ' + failures.join(' | ') : 'ALL PASS'));
  app.win.close();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});
