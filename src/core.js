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
    appearance: 'auto', // 'auto' (跟随系统) | 'light' (浅色) | 'dark' (深色)
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
      if (raw.appearance === 'light' || raw.appearance === 'dark' || raw.appearance === 'auto') {
        out.appearance = raw.appearance;
      }
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
    if (!m) return '';
    try {
      return decodeURIComponent(m[1]).replace(/%3D/gi, '=');
    } catch (e) {
      return m[1].replace(/%3D/gi, '=');
    }
  }

  /**
   * 构建可直接在浏览器新标签页打开且绕过防爬/扫码拦截的完整原文链接
   * 注意：小红书 xsec_token 为 base64 字符串（常见末尾为 =），服务端直接比对字面量，
   * 严禁把末尾的 = 转码为 %3D，否则会导致服务端鉴权失效被判定为爬虫并弹出二维码/无法访问。
   */
  function buildNoteUrl(noteOrId, token) {
    if (!noteOrId) return '';
    let raw = '';
    let id = '';
    let xToken = token || '';

    if (typeof noteOrId === 'string') {
      raw = noteOrId.trim();
      id = extractNoteId(raw);
      if (!xToken) xToken = extractXsecToken(raw);
    } else if (typeof noteOrId === 'object') {
      raw = String(noteOrId.url || noteOrId.href || '').trim();
      id = noteOrId.id || extractNoteId(raw);
      xToken = xToken || noteOrId.xsecToken || extractXsecToken(raw);
    }

    if (!id && raw && /^[0-9a-f]{24}$/i.test(raw)) {
      id = raw.toLowerCase();
    }
    if (!id) return '';

    // 若原链接本身就是小红书 explore / discovery 链接且已包含 xsec_token，直接返回标准化域名链接
    if (raw && (raw.indexOf('/explore/' + id) !== -1 || raw.indexOf('/discovery/item/' + id) !== -1)) {
      const full = raw.startsWith('http') ? raw : ('https://www.xiaohongshu.com' + (raw.startsWith('/') ? '' : '/') + raw);
      if (/[?&]xsec_token=/i.test(full)) {
        return full.replace(/([?&]xsec_token=[^&#]*?)%3D/gi, '$1=');
      }
    }

    // 组装带安全凭证的有效外链（保持原生 token 字面量，包含末尾 =，不转码为 %3D）
    if (xToken) {
      const cleanToken = String(xToken).replace(/%3D/gi, '=');
      return 'https://www.xiaohongshu.com/explore/' + id + '?xsec_token=' + cleanToken + '&xsec_source=pc_user';
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

  /* ============================ 撤销与批次目标计算 ============================ */

  /**
   * 查找待撤销的目标（区分单篇撤销与批次撤销）
   * @param {Array} history 历史记录列表
   * @param {'uncollect'|'unlike'|null} mode 模式过滤
   * @param {Object} [options] 可选的指定目标 { noteId, batchId, undoType }
   * @returns {Object|null} 包含待撤销的目标信息：{ type: 'single'|'batch', items: Array, count: number, noteId, batchId, title, mode, canUndo: boolean }
   */
  function findUndoTarget(history, mode, options) {
    const list = Array.isArray(history) ? history : [];
    if (!list.length) return null;

    const opt = options || {};

    // 1. 若显式指定 noteId，精准查找单条历史
    if (opt.noteId) {
      for (let i = list.length - 1; i >= 0; i--) {
        const h = list[i];
        if (h && h.id === opt.noteId && !h.undone && (!mode || h.mode === mode)) {
          return {
            type: 'single',
            items: [h],
            count: 1,
            noteId: h.id,
            title: h.title || '',
            mode: h.mode,
            batchId: h.batchId,
            canUndo: true,
          };
        }
      }
      return null;
    }

    // 2. 若显式指定 batchId，精准查找同一批次的全部未撤销项
    if (opt.batchId) {
      const matched = [];
      let foundMode = mode;
      for (let i = 0; i < list.length; i++) {
        const h = list[i];
        if (h && h.batchId === opt.batchId && !h.undone && (!mode || h.mode === mode)) {
          matched.push(h);
          if (!foundMode) foundMode = h.mode;
        }
      }
      if (!matched.length) return null;
      return {
        type: 'batch',
        items: matched,
        count: matched.length,
        batchId: opt.batchId,
        title: matched[0].title || '',
        mode: foundMode,
        canUndo: true,
      };
    }

    // 3. 默认：从最新历史往回找第一条尚未撤销的记录
    let targetItem = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      if (h && !h.undone && (!mode || h.mode === mode)) {
        targetItem = h;
        break;
      }
    }

    if (!targetItem) return null;

    // 判定该记录是单篇操作还是批量操作：
    // - 显式标记 type: 'single'，或者是没有 batchId 的单个记录
    // - 若标记 type: 'batch' 且有 batchId，则聚合属于同一 batchId 的所有未撤销项
    if (targetItem.type === 'single' || (!targetItem.batchId && targetItem.type !== 'batch')) {
      return {
        type: 'single',
        items: [targetItem],
        count: 1,
        noteId: targetItem.id,
        title: targetItem.title || '',
        mode: targetItem.mode,
        batchId: targetItem.batchId,
        canUndo: true,
      };
    }

    // 属于批量批次
    const batchId = targetItem.batchId;
    if (batchId) {
      const batchItems = [];
      for (let i = 0; i < list.length; i++) {
        const h = list[i];
        if (h && h.batchId === batchId && !h.undone && (!mode || h.mode === mode)) {
          batchItems.push(h);
        }
      }
      return {
        type: 'batch',
        items: batchItems.length ? batchItems : [targetItem],
        count: batchItems.length || 1,
        batchId: batchId,
        title: targetItem.title || '',
        mode: targetItem.mode,
        canUndo: true,
      };
    }

    // 兜底（老版本无 type 也无 batchId 的记录）：作为单篇
    return {
      type: 'single',
      items: [targetItem],
      count: 1,
      noteId: targetItem.id,
      title: targetItem.title || '',
      mode: targetItem.mode,
      canUndo: true,
    };
  }

  /* ============================ 情感化文案与彩蛋里程碑 ============================ */

  const MILESTONES = [
    {
      count: 10,
      title: '初见轻盈',
      badge: '🌱',
      tag: 'MILESTONE 10',
      desc: '踏出数字断舍离的第一步，感觉真棒！',
      quotes: [
        '“种一棵树最好的时间是十年前，其次是现在。”',
        '开始给数字生活卸下一副小担子。',
        '放下 10 个旧执念，迎来 10 份新清爽。',
      ],
    },
    {
      count: 20,
      title: '告别囤积',
      badge: '🍃',
      tag: 'MILESTONE 20',
      desc: '不再盲目收集，开始懂得选择与放下。',
      quotes: [
        '少即是多，好的生活不需要填得太满。',
        '清空的是负累，留下的是热爱。',
        '给自己的心腾出了一片清净天地。',
      ],
    },
    {
      count: 50,
      title: '心境清朗',
      badge: '🌿',
      tag: 'MILESTONE 50',
      desc: '给收藏夹洗了个痛快的热水澡，视野豁然开朗！',
      quotes: [
        '信息若不消化，就只是心智的尘埃。',
        '半百断舍离，生活越来越有松弛感。',
        '你的时间很贵，留给真正值得的人与事。',
      ],
    },
    {
      count: 100,
      title: '极简践行者',
      badge: '🏆',
      tag: 'CENTURY 100',
      desc: '破百断舍离！向成百个过往执念潇洒挥手。',
      quotes: [
        '恭喜达成破百里程碑！生活轻装上阵。',
        '真正富足的心，从不依赖囤积来寻找安全感。',
        '愿你在纷繁世界里，始终保持内心的澄澈与专注。',
      ],
    },
    {
      count: 500,
      title: '数字生活大师',
      badge: '🌟',
      tag: 'MASTER 500',
      desc: '重塑自己的信息流，心无杂物，专注所爱。',
      quotes: [
        '五百篇过往化作养分，你已掌握专注的艺术。',
        '不被信息洪流裹挟，做自己生活的主人。',
        '极简不是一无所有，而是把所有留给最爱。',
      ],
    },
    {
      count: 1000,
      title: '千帆过尽·归于本心',
      badge: '👑',
      tag: 'LEGEND 1000',
      desc: '千篇过客，留下的是生活，放下的是执念。',
      quotes: [
        '千帆过尽，不染纤尘。生活从此轻盈自在。',
        '能放下千般执念的人，内心定有无垠山海。',
        '数字世界里的清行者，向你致敬。',
      ],
    },
  ];

  const EMOTION_QUOTES = {
    empty: {
      uncollect: [
        '「收藏了就等于学会了」—— 是不是也有很多灵感在箱底落灰？点击【读取】，一起唤醒它们吧 ☕',
        '把过去的收藏翻出来晒晒太阳，留下真正喜欢的，其余的温柔告别 🌿',
        '给数字生活做一次断舍离，腾出空间装下新的心动与灵感 ✨',
        '有些攻略当时觉得必看，现在才发现生活早已有了自己的答案 📖',
        '收藏夹是过去的愿望清单，今天来看看哪些已经变成了现实 🎈',
      ],
      unlike: [
        '那些年随手点下的小红心，也是你过去某一刻的心动与好奇 ❤️',
        '曾经让你眼前一亮的人和事，重温一下，看看今天的自己还会不会心动 💫',
        '喜欢是当下的共鸣，清理是给现在的审美腾出新天地 🎈',
        '点赞是给世界的掌声，偶尔回顾，也是在看一路走来的审美印记 ☕',
        '曾经的心动已化作记忆，现在的你，期待着怎样的灵感火花？✨',
      ],
    },
    cooldown: [
      '正在轻柔处理中… 给小红书服务器喘口气的机会 🍃',
      '断舍离就像打扫房间，慢慢来更干净 🧹',
      '那些不再需要的内容，正在悄悄退场…',
      '专注当下，把过去的负累一件件放下 ☕',
      '生活向前走，腾出空间迎接更好的灵感 🌈',
      '深呼吸一下，喝口水，马上就好 🌿',
    ],
    roundEnd: [
      '🎉 这一轮旧念头已重温完毕。生活向前，记忆沉淀 🌿',
      '✨ 岁月常新，翻过这一批旧笔记，心里是不是更轻盈了？',
      '☕ 过去种下的灵感已重逢一轮，无论是去是留，都是最好的安排。',
      '🎈 属于过去的一幕已翻篇，去开启下一批探索吧！',
      '🍃 重温完毕！每一个保留与告别，都是更了解自己的过程。',
    ],
    batchDone: [
      '✨ 已为你完成 {n} 次断舍离，小红书和生活都轻盈了一点点～',
      '🌿 成功放下了 {n} 篇旧笔记，为新的灵感腾出空间！',
      '☕ 这 {n} 个旧念头已化作生活养分，继续轻装向前走吧！',
      '🍃 告别了 {n} 篇过往，信息流像刚整理完的桌面一样清爽。',
      '🌱 断舍离不是失去，而是把最好的注意力留给当下的自己（已处理 {n} 篇）。',
    ],
  };

  /**
   * 检查是否达成新的彩蛋里程碑。
   * @param {number} prevCount - 处理前的历史累计清理数
   * @param {number} newCount - 处理后的历史累计清理数
   * @param {Array<number>} unlocked - 已经解锁过的里程碑列表（例如 [10]）
   * @returns {Object|null} 触发的新里程碑对象（若同时跨越多个，返回最高那个），未触发返回 null
   */
  function checkMilestone(prevCount, newCount, unlocked) {
    const unlockedSet = new Set(Array.isArray(unlocked) ? unlocked : []);
    const p = Math.max(0, Number(prevCount) || 0);
    const n = Math.max(0, Number(newCount) || 0);
    if (n <= p) return null;

    let triggered = null;
    for (let i = 0; i < MILESTONES.length; i++) {
      const m = MILESTONES[i];
      if (n >= m.count && !unlockedSet.has(m.count)) {
        triggered = m;
      }
    }
    return triggered;
  }

  /**
   * 随机抽取指定场景的情感化文案。
   * @param {string} category - 'empty' | 'cooldown' | 'roundEnd' | 'batchDone'
   * @param {string|number} [subKeyOrN] - 子模式 ('uncollect'/'unlike') 或篇数 n
   * @param {number} [n] - 篇数（当 category==='batchDone' 时传入）
   * @param {Function} [rnd] - 随机数生成器（单测可用）
   */
  function getEmotionQuote(category, subKeyOrN, n, rnd) {
    const r = typeof rnd === 'function' ? rnd : Math.random;
    let list = [];
    let countNum = 0;
    if (category === 'empty') {
      const mode = (typeof subKeyOrN === 'string' && subKeyOrN) ? subKeyOrN : 'uncollect';
      list = (EMOTION_QUOTES.empty && EMOTION_QUOTES.empty[mode]) || EMOTION_QUOTES.empty.uncollect;
    } else if (category === 'batchDone') {
      list = EMOTION_QUOTES.batchDone || [];
      countNum = Number(subKeyOrN || n) || 1;
    } else {
      list = EMOTION_QUOTES[category] || [];
    }
    if (!list.length) return '';
    const idx = Math.floor(r() * list.length);
    let text = list[idx] || list[0];
    if (countNum > 0) {
      text = text.replace(/\{n\}/g, String(countNum));
    }
    return text;
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
    findUndoTarget: findUndoTarget,
    MILESTONES: MILESTONES,
    EMOTION_QUOTES: EMOTION_QUOTES,
    checkMilestone: checkMilestone,
    getEmotionQuote: getEmotionQuote,
  };
});
