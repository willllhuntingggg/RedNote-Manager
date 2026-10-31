'use strict';
/*
 * 边界场景测试：风控熔断 / 演练零写入 / 撤销 / 已处理跳过
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

const cardsHtml = ids
  .map(
    (id, i) =>
      `<section class="note-item"><a class="cover" href="/explore/${id}?xsec_token=x"><img alt="备用${i}"></a>` +
      `<div class="footer"><div class="title"><span>测试笔记 ${i}</span></div></div></section>`
  )
  .join('');

function makeApp(opts) {
  const html = `<!doctype html><html><body><div class="user-page">
    <div class="user-info"><button>编辑资料</button></div>
    <div class="tab-bar">
      <div class="reds-tab-item sub-tab-list active">笔记 12</div>
      <div class="reds-tab-item sub-tab-list">收藏 3</div>
      <div class="reds-tab-item sub-tab-list">点赞 2</div>
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
  const store = Object.assign({}, opts.seed || {});
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
    if (m.kind === 'call') { calls.push(m); return reply(m, opts.respond(m, calls.length)); }
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

  return {
    win,
    store,
    calls,
    errors,
    shadow: () => (win.document.getElementById('rn-manager-host') || {}).shadowRoot,
    action: (a) => listeners.forEach((fn) => fn({ type: 'RN_ACTION', action: a }, {}, () => {})),
    logs: () => win.__rnManager.state.logs.map((l) => l.kind + ' ' + l.msg).join('\n'),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (fn, ms = 30000, step = 100) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(step); }
  return false;
};

/** 扫完列表再启动，并等本次运行真正结束（而不是靠猜时间） */
async function scanAndStart(app, settings) {
  Object.assign(app.win.__rnManager.state.settings, { minDelay: 800, maxDelay: 800, maxPerRun: 10 }, settings || {});
  app.action('scan');
  const ok = await waitFor(() => app.win.__rnManager.state.candidates.length > 0, 15000);
  if (!ok) throw new Error('扫描超时');
  const selAll = app.win.document.getElementById('rn-manager-host').shadowRoot.getElementById('rn-sel-all');
  selAll.click();
  if (app.win.__rnManager.state.selected.size === 0) throw new Error('全选命中失败');
  app.action('start');
  await wait(400);
  const finished = await waitFor(() => app.win.__rnManager.state.running === false, 30000);
  if (!finished) throw new Error('运行超时');
}

const failures = [];
function check(cond, name, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !detail ? '' : ' — ' + detail));
  if (!cond) failures.push(name);
}

async function scenarioRisk() {
  console.log('\n## 场景：第一条就被风控（HTTP 461 空壳响应）');
  const app = makeApp({
    respond: () => ({ status: 461, payload: { code: 0, success: true, data: {} } }),
  });
  await wait(300);
  await scanAndStart(app, { dryRun: false });

  const st = app.win.__rnManager.state;
  check(app.calls.length === 1, '发出第一条后立刻熔断（实际请求 ' + app.calls.length + ' 次）');
  check(st.stats.risk === true, '标记为风控熔断');
  check(st.processed.uncollect.length === 0, '熔断时不计入已处理');
  check((app.store['rn:history'] || []).length === 0, '不写撤销历史');
  check(/风控/.test(app.logs()), '日志里明确提示风控');
  check(st.running === false, '运行状态复位');
  app.win.close();
}

async function scenarioUndo() {
  console.log('\n## 场景：正常跑完后撤销');
  const app = makeApp({ respond: () => ({ status: 200, payload: { code: 0, success: true } }) });
  await wait(300);
  await scanAndStart(app, { dryRun: false });
  check(app.calls.length === 3, '先完成 3 条取消（实际 ' + app.calls.length + '）');

  app.calls.length = 0;
  app.action('undo');
  await wait(400);
  const undone = await waitFor(() => app.win.__rnManager.state.running === false, 30000);
  check(undone, '撤销流程结束');

  const paths = app.calls.map((c) => c.path);
  check(app.calls.length === 3, '撤销发出 3 次请求（实际 ' + app.calls.length + '）');
  check(paths.every((p) => p === '/api/sns/web/v1/note/collect'), '撤销走 collect 接口：' + paths.join(','));
  check(app.calls.every((c) => c.body && typeof c.body.note_id === 'string'), '撤销用单数 note_id 字符串');
  const st = app.win.__rnManager.state;
  check(st.processed.uncollect.length === 0, '撤销后清空已处理记录（实际 ' + st.processed.uncollect.length + '）');
  check(app.store['rn:history'].every((h) => h.undone === true), '历史条目标记 undone');
  app.win.close();
}

async function scenarioSkipProcessed() {
  console.log('\n## 场景：已处理的笔记不重复取消');
  const app = makeApp({
    respond: () => ({ status: 200, payload: { code: 0, success: true } }),
    seed: { 'rn:processed': { uncollect: [ids[0]], unlike: [] }, 'rn:history': [] },
  });
  await wait(300);
  await scanAndStart(app, { dryRun: false });

  check(app.calls.length === 2, '只处理剩下 2 条（实际 ' + app.calls.length + '）');
  check(app.calls.every((c) => c.body.note_ids !== ids[0]), '跳过了已处理的笔记');
  app.win.close();
}

(async () => {
  await scenarioRisk();
  await scenarioUndo();
  await scenarioSkipProcessed();
  console.log('\n' + (failures.length ? 'FAILED ' + failures.length + ': ' + failures.join(' | ') : 'ALL PASS'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(2);
});
