/*
 * RedNote Manager · 页面内（MAIN world）签名代理
 * ---------------------------------------------------------------
 * 为什么需要它：
 *   小红书的写接口要求 x-s / x-t 两个签名头，签名函数 window._webmsxyw 是页面自己的
 *   全局变量。MV3 的内容脚本跑在「隔离世界」，看不见页面的 window，所以必须有一个
 *   跑在 MAIN world 的小脚本负责「签名 + 发请求」，再通过 postMessage 把结果递回来。
 *
 * 这个文件不含任何业务逻辑，只做三件事：
 *   1. ping  —— 报告签名函数是否就绪
 *   2. me    —— 尽力从页面状态里读出「当前登录用户 ID」，用于防止在别人的主页上操作
 *   3. call  —— 签名后 POST 到接口，原样返回 {status, payload}
 *
 * 注意：MAIN world 里没有 chrome.* API，也不该有。只发网络请求。
 */
(function () {
  'use strict';

  if (window.__RN_BRIDGE_READY__) return;
  window.__RN_BRIDGE_READY__ = true;

  const REQ_SOURCE = 'RN_UI';
  const RES_SOURCE = 'RN_BRIDGE';
  const IS_REDNOTE = /(^|\.)rednote\.com$/i.test(location.hostname);
  const API_ORIGIN = IS_REDNOTE ? 'https://webapi.rednote.com' : 'https://edith.xiaohongshu.com';
  const CALL_TIMEOUT = 20000;

  let cachedSigner = null;

  function pickSigner() {
    if (cachedSigner && typeof cachedSigner === 'function') return cachedSigner;
    const w = window;
    const candidates = [w._webmsxyw, w._webmsxyw_, w.webmsxyw];
    for (let i = 0; i < candidates.length; i++) {
      if (typeof candidates[i] === 'function') return (cachedSigner = candidates[i]);
    }
    // 兜底：签名函数有时挂在别的名字上，按关键字扫一遍 window
    try {
      const keys = Object.keys(w);
      for (let i = 0; i < keys.length; i++) {
        if (!/webmsxyw/i.test(keys[i])) continue;
        if (typeof w[keys[i]] === 'function') return (cachedSigner = w[keys[i]]);
      }
    } catch (e) { /* 某些 window 属性会抛错，忽略 */ }
    return null;
  }

  /** 签名函数不同版本返回的键名不一致，这里统一成 {xs, xt} */
  function normalizeSignature(sig) {
    if (!sig || typeof sig !== 'object') return null;
    const xs = sig['X-s'] || sig['x-s'] || sig['xs'];
    if (!xs) return null;
    const xt = sig['X-t'] || sig['x-t'] || sig['xt'];
    return {
      xs: String(xs),
      xt: String(xt == null ? Math.round(Date.now() / 1000) : xt),
    };
  }

  /** 从页面状态里尽力找「我」的 user_id 和 昵称；找不到就返回 ''，绝不猜 */
  function detectMyUserInfo() {
    const probes = [];
    const st = window.__INITIAL_STATE__;
    if (st && typeof st === 'object') {
      probes.push(
        st.user && st.user.userInfo && st.user.userInfo.value,
        st.user && st.user.userInfo,
        st.user && st.user.userPageData && st.user.userPageData.value && st.user.userPageData.value.basicInfo,
        st.user && st.user.userPageData && st.user.userPageData.basicInfo,
        st.user && st.user.userPageData && st.user.userPageData.value,
        st.user && st.user.userPageData,
        st.user && st.user.loggedInUser
      );
    }
    let id = '';
    let nickname = '';
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i];
      if (!p || typeof p !== 'object') continue;
      if (!id) {
        const tid = p.user_id || p.userId || p.userid || p.id;
        if (typeof tid === 'string' && /^[0-9a-f]{24}$/i.test(tid)) id = tid;
      }
      if (!nickname) {
        const tname = p.nickname || p.nickName || p.userName || p.name;
        if (typeof tname === 'string' && tname.trim()) nickname = tname.trim();
      }
    }
    return { me: id, nickname: nickname };
  }

  function detectMyUserId() {
    return detectMyUserInfo().me;
  }

  /** 从页面状态 window.__INITIAL_STATE__ 深度扫描已有的 xsecToken 凭证映射表 */
  function collectTokens() {
    const tokens = {};
    const st = window.__INITIAL_STATE__;
    if (!st || typeof st !== 'object') return tokens;

    function walk(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 7) return;
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) walk(obj[i], depth + 1);
        return;
      }
      const id = obj.id || obj.noteId || (obj.noteCard && obj.noteCard.noteId);
      const token = obj.xsecToken || obj.xsec_token;
      if (typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id) && typeof token === 'string' && token) {
        tokens[id.toLowerCase()] = token;
      }
      const keys = Object.keys(obj);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === 'userPageData' || k === 'basicInfo') continue;
        walk(obj[k], depth + 1);
      }
    }

    try {
      walk(st, 0);
    } catch (e) {}
    return tokens;
  }

  async function callApi(path, method, body) {
    const signer = pickSigner();
    if (!signer) {
      throw new Error('页面签名函数 window._webmsxyw 不存在（页面可能未加载完，或站点改版）');
    }
    const sig = normalizeSignature(signer(path, body || null));
    if (!sig) throw new Error('签名函数返回的格式不认识，站点可能已改版');

    const init = {
      method: method || 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8',
        'x-s': sig.xs,
        'x-t': sig.xt,
      },
    };
    if (body) init.body = JSON.stringify(body);

    const res = await fetch(API_ORIGIN + path, init);
    const text = await res.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      throw new Error('响应不是 JSON（HTTP ' + res.status + '）：' + text.slice(0, 120));
    }
    return { status: res.status, payload: payload };
  }

  function reply(msg) {
    msg.source = RES_SOURCE;
    try {
      window.postMessage(msg, location.origin);
    } catch (e) {
      window.postMessage(msg, '*');
    }
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== REQ_SOURCE || !msg.id) return;

    if (msg.kind === 'ping') {
      const info = detectMyUserInfo();
      reply({ id: msg.id, ok: true, signer: !!pickSigner(), origin: API_ORIGIN, me: info.me, nickname: info.nickname, tokens: collectTokens() });
      return;
    }

    if (msg.kind === 'me') {
      const info = detectMyUserInfo();
      reply({ id: msg.id, ok: true, me: info.me, nickname: info.nickname, tokens: collectTokens() });
      return;
    }

    if (msg.kind === 'tokens') {
      reply({ id: msg.id, ok: true, tokens: collectTokens() });
      return;
    }

    if (msg.kind !== 'call') return;

    const started = Date.now();
    let timer = null;
    const timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error('请求超时（' + CALL_TIMEOUT + 'ms）'));
      }, CALL_TIMEOUT);
    });

    Promise.race([callApi(msg.path, msg.method, msg.body), timeout])
      .then(function (r) {
        reply({ id: msg.id, ok: true, status: r.status, payload: r.payload, ms: Date.now() - started });
      })
      .catch(function (e) {
        reply({ id: msg.id, ok: false, error: (e && e.message) || String(e), ms: Date.now() - started });
      })
      .finally(function () {
        if (timer) clearTimeout(timer);
      });
  });
})();
