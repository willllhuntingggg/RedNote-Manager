/*
 * RedNote Manager · 纯逻辑层
 * ---------------------------------------------------------------
 * 这里只放「不碰 DOM、不碰 chrome API」的纯函数，方便用 node --test 单测。
 * 内容脚本把它挂到 globalThis.RNCore，Node 里可以 require 进来。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RNCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  /* ============================ 模式与接口 ============================ */

  const MODES = {
    uncollect: {
      key: 'uncollect',
      label: '取消收藏',
      verb: '取消收藏',
      undoVerb: '重新收藏',
      unit: '篇',
      tabLabel: '收藏',
    },
    unlike: {
      key: 'unlike',
      label: '取消点赞',
      verb: '取消点赞',
      undoVerb: '重新点赞',
      unit: '篇',
      tabLabel: '点赞',
    },
  };

  /*
   * 小红书网页端的 4 个写接口。字段名来自线上实测，三者互不相同，别想当然：
   *   like / dislike  -> { note_oid: "<note_id>" }
   *   collect         -> { note_id:  "<note_id>" }
   *   uncollect       -> { note_ids: "<note_id>" }   ← 键名是复数，但值是「单个字符串」
   * 站点改版后如果返回「参数错误」，先改这里。
   */
  const ENDPOINTS = {
    uncollect: { path: '/api/sns/web/v1/note/uncollect', body: (id) => ({ note_ids: String(id) }) },
    collect: { path: '/api/sns/web/v1/note/collect', body: (id) => ({ note_id: String(id) }) },
    dislike: { path: '/api/sns/web/v1/note/dislike', body: (id) => ({ note_oid: String(id) }) },
    like: { path: '/api/sns/web/v1/note/like', body: (id) => ({ note_oid: String(id) }) },
  };

  const ACTION_OF = {
    'uncollect:do': 'uncollect',
    'uncollect:undo': 'collect',
    'unlike:do': 'dislike',
    'unlike:undo': 'like',
  };

  const NOTE_ID_RE = /^[0-9a-f]{24}$/i;

  function isNoteId(v) {
    return NOTE_ID_RE.test(String(v || ''));
  }

  /**
   * 构造一次写操作请求。
   * @param {'uncollect'|'unlike'} mode
   * @param {'do'|'undo'} phase
   * @param {string} noteId 24 位十六进制
   */
  function buildWrite(mode, phase, noteId) {
    const action = ACTION_OF[mode + ':' + phase];
    if (!action) throw new Error('未知操作：' + mode + '/' + phase);
    if (!isNoteId(noteId)) throw new Error('笔记 ID 不合法：' + noteId);
    const ep = ENDPOINTS[action];
    return { action: action, path: ep.path, method: 'POST', body: ep.body(noteId) };
  }

  /* ============================ 设置与边界 ============================ */

  const DEFAULTS = {
    mode: 'uncollect',
    minDelay: 1500,
    maxDelay: 3200,
    maxPerRun: 30,
    cooldownEvery: 20,
    cooldownMs: 45000,
    keyword: '', // 搜索词：只过滤「看得见什么」和批量勾选，不再隐式决定执行范围
    autoScroll: true,
  };

  /* 硬边界：用户填什么都不允许越过，防止手滑填 0 间隔 / 9999 条 */
  const LIMITS = {
    minDelay: [800, 20000],
    maxDelay: [800, 60000],
    maxPerRun: [1, 200],
    cooldownEvery: [0, 200],
    cooldownMs: [0, 600000],
  };

  function clampInt(n, lo, hi) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
  }

  function clampSettings(raw) {
    const out = Object.assign({}, DEFAULTS);
    if (raw && typeof raw === 'object') {
      if (MODES[raw.mode]) out.mode = raw.mode;
      if (typeof raw.autoScroll === 'boolean') out.autoScroll = raw.autoScroll;
      if (typeof raw.keyword === 'string') out.keyword = raw.keyword.slice(0, 200);
      Object.keys(LIMITS).forEach(function (k) {
        if (raw[k] === undefined || raw[k] === null || raw[k] === '') return;
        out[k] = clampInt(raw[k], LIMITS[k][0], LIMITS[k][1]);
      });
    }
    if (out.maxDelay < out.minDelay) out.maxDelay = out.minDelay;
    return out;
  }

  /* ============================ 响应判定 ============================ */

  const RISK_CODES = { 461: 1, '-1': 1, 300012: 1, 300013: 1 };
  const RISK_WORDS = /频繁|太快|稍后再试|风控|验证|限流|限制|异常|安全|封禁|违规|登录/;

  /**
   * 是否应该「熔断」——命中就立刻停手，别再硬刚。
   * 461 是小红书风控层最典型的返回（HTTP 461 + code 0 的空 data）。
   */
  function isRiskResponse(payload, httpStatus) {
    const st = Number(httpStatus);
    if (st === 461 || st === 429) return true;
    if (!payload || typeof payload !== 'object') return false;
    const code = payload.code;
    if (RISK_CODES[String(code)] === 1) return true;
    return RISK_WORDS.test(String(payload.msg || payload.message || ''));
  }

  function isSuccess(payload) {
    return !!payload && Number(payload.code) === 0 && payload.success !== false;
  }

  function describeError(payload, httpStatus) {
    if (!payload) return 'HTTP ' + httpStatus + '（无响应体）';
    const bits = [];
    if (payload.code !== undefined) bits.push('code=' + payload.code);
    if (payload.msg) bits.push('msg=' + payload.msg);
    if (payload.message && payload.message !== payload.msg) bits.push('message=' + payload.message);
    if (!bits.length) bits.push('HTTP ' + httpStatus);
    return bits.join(' ');
  }

  /* ============================ 笔记卡片解析 ============================ */

  /**
   * 从卡片链接里取 note_id。
   * 只认 /explore/<id> 和 /user/profile/<uid>/<id> 这两种形态——
   * 裸的 24 位十六进制不能要，因为用户 ID 也是 24 位，会把「用户的 ID」当成「笔记 ID」。
   */
  function extractNoteId(href) {
    const s = String(href || '');
    let m = s.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i);
    if (m) return m[1].toLowerCase();
    m = s.match(/\/user\/profile\/[0-9a-f]+\/([0-9a-f]{24})/i);
    if (m) return m[1].toLowerCase();
    m = s.match(/[?&](?:noteId|note_id|noteid)=([0-9a-f]{24})/i);
    if (m) return m[1].toLowerCase();
    return '';
  }

  /**
   * 从卡片链接中提取 xsec_token 安全凭证
   */
  function extractXsecToken(href) {
    const s = String(href || '');
    const m = s.match(/[?&]xsec_token=([^&#]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /**
   * 构建可直接在浏览器新标签页打开且绕过防爬/扫码拦截的完整原文链接
   */
  function buildNoteUrl(noteOrId, token) {
    if (!noteOrId) return '';
    let id = '';
    let xToken = token || '';
    let rawUrl = '';

    if (typeof noteOrId === 'string') {
      id = extractNoteId(noteOrId) || (/^[0-9a-f]{24}$/i.test(noteOrId) ? noteOrId.toLowerCase() : '');
      if (!xToken) xToken = extractXsecToken(noteOrId);
    } else if (typeof noteOrId === 'object') {
      id = noteOrId.id || extractNoteId(noteOrId.url || noteOrId.href);
      rawUrl = noteOrId.url || noteOrId.href || '';
      xToken = xToken || noteOrId.xsecToken || extractXsecToken(rawUrl);
    }

    if (!id) return '';
    if (xToken) {
      return 'https://www.xiaohongshu.com/explore/' + id + '?xsec_token=' + encodeURIComponent(xToken) + '&xsec_source=pc_user';
    }
    return 'https://www.xiaohongshu.com/explore/' + id + '?xsec_source=pc_user';
  }

  /**
   * 从用户个人主页链接提取 user_id (24位十六进制)
   */
  function extractUserId(href) {
    const s = String(href || '');
    const m = s.match(/\/user\/profile\/([0-9a-f]{24})/i);
    return m ? m[1].toLowerCase() : '';
  }

  function dedupeNotes(list) {
    const seen = {};
    const out = [];
    (list || []).forEach(function (n) {
      if (!n || !n.id || seen[n.id]) return;
      seen[n.id] = 1;
      out.push(n);
    });
    return out;
  }

  /* ============================ 关键词筛选 ============================ */

  /**
   * "美食, 旅行 -广告" → { include: ['美食','旅行'], exclude: ['广告'] }
   * 用逗号/空格分隔，前缀 - 表示排除；空串表示不筛选。
   */
  function parseKeywords(raw) {
    const terms = { include: [], exclude: [] };
    String(raw || '')
      .split(/[,，\s]+/)
      .forEach(function (t) {
        const s = t.trim().toLowerCase();
        if (!s) return;
        if (s.charAt(0) === '-' && s.length > 1) terms.exclude.push(s.slice(1));
        else terms.include.push(s);
      });
    return terms;
  }

  function matchKeywords(note, terms) {
    const inc = (terms && terms.include) || [];
    const exc = (terms && terms.exclude) || [];
    const hay = ((note && note.title) || '') + ' ' + ((note && note.author) || '') + ' ' + ((note && note.id) || '');
    const lower = hay.toLowerCase();
    for (let i = 0; i < exc.length; i++) if (lower.indexOf(exc[i]) !== -1) return false;
    if (!inc.length) return true;
    for (let i = 0; i < inc.length; i++) if (lower.indexOf(inc[i]) !== -1) return true;
    return false;
  }

  /* ============================ 人味节律 ============================ */

  function randInt(a, b, rnd) {
    const r = typeof rnd === 'function' ? rnd : Math.random;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return lo + Math.floor(r() * (hi - lo + 1));
  }

  /**
   * 两条操作之间的等待时间。除了区间随机，还以 8% 概率插入一次长停顿，
   * 避免出现「精确等间隔」这种一眼就能被识别的机器节律。
   */
  function delayBetween(min, max, rnd) {
    const lo = clampInt(min, LIMITS.minDelay[0], LIMITS.maxDelay[1]);
    const hi = clampInt(Math.max(lo, max), lo, LIMITS.maxDelay[1]);
    const base = randInt(lo, hi, rnd);
    const longPause = (typeof rnd === 'function' ? rnd() : Math.random()) < 0.08;
    return longPause ? base + randInt(1500, 5000, rnd) : base;
  }

  /** 每处理 every 条就冷却一次（every<=0 表示不冷却） */
  function shouldCooldown(doneCount, every) {
    const e = Number(every) || 0;
    return e > 0 && doneCount > 0 && doneCount % e === 0;
  }

  /**
   * Shift 区间选择：返回 [from, to] 之间（含端点）的 id 列表。
   * 索引越界会被夹住；from > to 时自动交换。
   */
  function selectRange(ids, from, to) {
    const list = ids || [];
    if (!list.length) return [];
    const clampIdx = function (v) {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) return 0;
      return Math.min(list.length - 1, Math.max(0, n));
    };
    let a = clampIdx(from);
    let b = clampIdx(to);
    if (a > b) { const t = a; a = b; b = t; }
    return list.slice(a, b + 1);
  }

  /* ============================ 展示 ============================ */

  function formatDuration(ms) {
    const s = Math.max(0, Math.round(Number(ms) / 1000));
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? m + ' 分 ' + r + ' 秒' : m + ' 分';
  }

  function summarize(stats) {
    const s = stats || {};
    const parts = ['成功 ' + (s.ok || 0)];
    if (s.fail) parts.push('失败 ' + s.fail);
    if (s.skipped) parts.push('跳过 ' + s.skipped);
    if (s.elapsedMs) parts.push('耗时 ' + formatDuration(s.elapsedMs));
    if (s.risk) parts.push('已熔断');
    return parts.join('，');
  }

  return {
    MODES: MODES,
    DEFAULTS: DEFAULTS,
    LIMITS: LIMITS,
    buildWrite: buildWrite,
    isNoteId: isNoteId,
    clampInt: clampInt,
    clampSettings: clampSettings,
    isRiskResponse: isRiskResponse,
    isSuccess: isSuccess,
    describeError: describeError,
    extractNoteId: extractNoteId,
    extractXsecToken: extractXsecToken,
    extractUserId: extractUserId,
    buildNoteUrl: buildNoteUrl,
    dedupeNotes: dedupeNotes,
    parseKeywords: parseKeywords,
    matchKeywords: matchKeywords,
    randInt: randInt,
    delayBetween: delayBetween,
    shouldCooldown: shouldCooldown,
    selectRange: selectRange,
    formatDuration: formatDuration,
    summarize: summarize,
  };
});
