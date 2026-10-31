'use strict';
/*
 * 冒烟测试：用 jsdom 搭一个「我的主页 → 收藏」页面，把三个脚本按 manifest 顺序注入，
 * 验证：面板挂载 → 卡片解析 → 引擎逐条调用 → 记录落盘。
 * 这里的 window.postMessage / 事件用直接 dispatch 模拟，绕开 jsdom 对 source 的限制。
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
const ids = ['a'.repeat(24), 'b'.repeat(24), 'c'.repeat(24)];

const cards = ids
  .map(
    (id, i) => `
  <section class="note-item">
    <a class="cover" href="/explore/${id}?xsec_token=xyz">
      <img src="https://example.com/${i}.jpg" alt="备用标题${i}" />
    </a>
    <div class="footer"><div class="title"><span>测试笔记 ${i}</span></div></div>
  </section>`
  )
  .join('');

const html = `<!doctype html><html><head><title>主页</title></head><body>
  <div class="user-page">
    <div class="user-info"><button>编辑资料</button></div>
    <div class="tab-bar">
      <div class="reds-tab-item sub-tab-list active" data-tab="笔记">笔记 12</div>
      <div class="reds-tab-item sub-tab-list" data-tab="收藏">收藏 3</div>
      <div class="reds-tab-item sub-tab-list" data-tab="点赞">点赞 2</div>
    </div>
    <div class="feeds-container">${cards}</div>
  </div>
</body></html>`;

const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (e) => {
  // jsdom 没实现 scrollTo/scrollBy，忽略这两个
  if (/Not implemented: window\.scroll/.test(e.message)) return;
  errors.push(e.message);
});
vc.on('error', (...a) => errors.push(a.join(' ')));

const dom = new JSDOM(html, {
  url: `https://www.xiaohongshu.com/user/profile/${UID}?tab=fav`,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const win = dom.window;

/* ---------- 极简 chrome API 桩 ---------- */
const store = {};
const listeners = [];
win.chrome = {
  storage: {
    local: {
      get(keys) {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
          if (store[k] !== undefined) out[k] = store[k];
        });
        return Promise.resolve(out);
      },
      set(obj) {
        Object.assign(store, obj);
        return Promise.resolve();
      },
    },
  },
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: () => Promise.resolve(),
  },
};

/* ---------- 模拟页面侧 bridge（签名代理） ---------- */
const calls = [];
function replyTo(msg, extra) {
  const data = Object.assign({ source: 'RN_BRIDGE', id: msg.id, ok: true }, extra);
  const ev = new win.MessageEvent('message', { data, source: win, origin: win.location.origin });
  win.dispatchEvent(ev);
}
win.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || m.source !== 'RN_UI') return;
  if (m.kind === 'ping') return replyTo(m, { signer: true, origin: 'https://edith.xiaohongshu.com', me: UID });
  if (m.kind === 'me') return replyTo(m, { me: UID });
  if (m.kind === 'call') {
    calls.push(m);
    return replyTo(m, { status: 200, payload: { code: 0, success: true, data: {} } });
  }
});

/* ---------- 标签页切换：让点击真的切 active ---------- */
win.document.querySelectorAll('.reds-tab-item').forEach((tab) => {
  tab.addEventListener('click', () => {
    win.document.querySelectorAll('.reds-tab-item').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
  });
});

win.confirm = () => true;

/* ---------- 注入脚本（顺序与 manifest 一致） ---------- */
for (const rel of ['src/core.js', 'src/content/style.js', 'src/content/content.js']) {
  win.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shadow = () => {
  const host = win.document.getElementById('rn-manager-host');
  return host ? host.shadowRoot : null;
};

(async () => {
  await wait(300);

  const fails = [];
  const ok = (cond, name) => {
    console.log((cond ? 'PASS ' : 'FAIL ') + name);
    if (!cond) fails.push(name);
  };

  ok(!!win.__rnManager, '脚本注入并暴露 __rnManager');
  ok(!!shadow(), '已选条数反馈栏挂到页面（Shadow DOM）');
  ok(!!shadow().querySelector('.rn-bar-wrap'), '底部反馈栏容器存在');
  ok(!!shadow().querySelector('#rn-bar-count'), '已选条数计数器存在');
  ok(!!shadow().querySelector('#rn-bar-clear'), '清空按钮存在');
  ok(!!shadow().querySelector('#rn-bar-open'), '展开侧边栏按钮存在');

  const notes = win.__rnManager.scan();
  ok(notes.length === 3, 'DOM 解析出 3 篇笔记（实际 ' + notes.length + '）');
  ok(notes[0].title === '测试笔记 0', '标题解析正确：' + (notes[0] && notes[0].title));
  ok(notes.every((n) => /^[0-9a-f]{24}$/.test(n.id)), '笔记 ID 全部合法');

  // ---- 走一遍「读取列表」 ----
  win.__rnManager.state.settings.mode = 'uncollect';
  const action = (a) => listeners.forEach((fn) => fn(typeof a === 'string' ? { type: 'RN_ACTION', action: a } : a, {}, () => {}));

  action('scan');
  await wait(4000);
  ok(win.__rnManager.state.candidates.length === 3, '读取列表拿到 3 篇（实际 ' + win.__rnManager.state.candidates.length + '）');
  ok(shadow().querySelector('#rn-bar-count').textContent === '0', '初始勾选为 0');

  // ---- 勾选全部命中 ----
  action({ type: 'RN_SELECT_ALL_VISIBLE' });
  ok(win.__rnManager.state.selected.size === 3, '全选命中勾选 3 篇（实际 ' + win.__rnManager.state.selected.size + '）');
  ok(shadow().querySelector('#rn-bar-count').textContent === '3', '页面反馈栏已选条数实时显示为 3');
  ok(!shadow().querySelector('.rn-bar-wrap').classList.contains('rn-hidden'), '页面反馈栏自动显示');

  // ---- 真实模式跑一遍引擎 ----
  win.__rnManager.state.settings.minDelay = 800;
  win.__rnManager.state.settings.maxDelay = 800;
  win.__rnManager.state.settings.maxPerRun = 10;
  action('start');
  await wait(6000);

  ok(calls.length === 3, '发出 3 次写请求（实际 ' + calls.length + '）');
  ok(calls.every((c) => c.path === '/api/sns/web/v1/note/uncollect'), '走的是 uncollect 接口');
  ok(
    calls.every((c) => c.body && typeof c.body.note_ids === 'string' && /^[0-9a-f]{24}$/.test(c.body.note_ids)),
    '请求体是 note_ids 字符串（不是数组）'
  );
  ok(JSON.stringify(calls.map((c) => c.body.note_ids).sort()) === JSON.stringify(ids.slice().sort()), '三条 ID 都被处理');

  const cp = store['rn:processed'];
  ok(cp && cp.uncollect.length === 3, '已处理记录持久化（' + (cp && cp.uncollect.length) + '）');
  ok(Array.isArray(store['rn:history']) && store['rn:history'].length === 3, '撤销历史写入（' + (store['rn:history'] || []).length + '）');
  ok(win.__rnManager.state.stats.ok === 3, '成功计数为 3');
  ok(win.__rnManager.state.running === false, '运行结束后状态复位');

  // ---- 处理完自动取消勾选 ----
  ok(win.__rnManager.state.candidates.length === 3, '候选仍在');
  ok(win.__rnManager.state.selected.size === 0, '处理完的自动移出勾选（实际 ' + win.__rnManager.state.selected.size + '）');

  ok(errors.length === 0, '无未捕获的页面错误' + (errors.length ? '：' + errors[0] : ''));

  console.log('\n' + (fails.length ? 'FAILED ' + fails.length : 'ALL PASS'));
  win.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});
