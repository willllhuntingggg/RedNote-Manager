/**
 * RedNote Manager · AI 自动打标与分类模块 (DeepSeek)
 * -------------------------------------------------------------
 * 职责：
 *   - 提供 DeepSeek API 客户端，支持自定义 API Key、模型与 Base URL
 *   - 批量对小红书笔记标题与信息进行语义分析，归纳为「主题分类」与「决策辅助属性」
 *   - 决策辅助标签：时效过期 / 营销广告 / 干货保值 / 普通浏览
 *   - 本地持久化缓存标签，避免重复请求扣费
 */
(function () {
  'use strict';

  const DEFAULT_CONFIG = {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: '',
  };

  const STORAGE_KEY_CONFIG = 'rn:ai_config';
  const STORAGE_KEY_TAGS = 'rn:ai_tags';

  const DECISION_META = {
    '时效过期': { label: '⚠️ 时效过期', type: 'warn', desc: '限时促销、活动优惠等已失效内容，建议优先清理' },
    '营销广告': { label: '📢 营销推广', type: 'danger', desc: '软广营销、带货推销内容' },
    '干货保值': { label: '💡 干货保值', type: 'safe', desc: '高质量教程、工具资料、长期实用指南，建议保留' },
    '普通浏览': { label: '☕ 普通浏览', type: 'normal', desc: '日常随笔、分享记录等' },
  };

  const SYSTEM_PROMPT = [
    '你是一个专业的小红书笔记分类与清理决策专家。',
    '用户会提供一组小红书笔记的 ID、标题及博主。请根据笔记信息，输出严格合法的 JSON 对象，不要输出任何非 JSON 字符。',
    '',
    '【分析维度】：',
    '1. category（主题分类）：从以下标准大类中选择最匹配的一个（如果都不匹配可高度概括）：',
    '   学习干货、美食探店、美妆穿搭、数码科技、影视娱乐、生活家居、旅游出行、职场提升、健康运动、其他。',
    '2. decision（辅助清理决策，四选一）：',
    '   - "时效过期"：针对往期活动打卡、限时优惠券、往年攻略、已截止招聘/比赛等现已无时效价值的内容；',
    '   - "营销广告"：明显的产品软广推销、通告种草、商业广告；',
    '   - "干货保值"：教程指南、工具代码、实用食谱、高价值知识等值得长期收藏的内容；',
    '   - "普通浏览"：日常随笔、风景晒图、生活记录等。',
    '3. reason（简要理由）：12字以内精炼说明原因（如："2023年限时探店已过期"、"实用Python教程"）。',
    '',
    '【输出 JSON 结构】：',
    '{',
    '  "items": {',
    '    "<note_id>": {',
    '      "category": "学习干货",',
    '      "decision": "干货保值",',
    '      "reason": "系统化实用教程"',
    '    }',
    '  }',
    '}',
  ].join('\n');

  /**
   * 清洗用户输入的 API Key
   * 自动去除引号、Bearer 前缀、键名前缀、全角字符以及不可见的零宽字符/BOM
   */
  function cleanApiKey(raw) {
    if (!raw) return '';
    let k = String(raw).trim();
    // 移除全角空格、不可见零宽字符、BOM与制表符/换行符
    k = k.replace(/[\u200B-\u200D\uFEFF\u00A0\u3000\r\n\t]/g, '').trim();
    // 移除可能存在的引号包裹: "sk-..." 或 'sk-...'
    k = k.replace(/^["'`]|["'`]$/g, '').trim();
    // 移除用户误粘贴的 Bearer 前缀: Bearer sk-...
    k = k.replace(/^Bearer\s+/i, '').trim();
    // 移除键名前缀: api_key: sk-... 或 API_KEY=sk-...
    k = k.replace(/^(?:api[-_]?key|key|token)\s*[:=]\s*/i, '').trim();
    return k.trim();
  }

  /**
   * 清洗 LLM 输出的文本为合法 JSON
   */
  function cleanJsonText(raw) {
    if (!raw) return '{}';
    let s = String(raw).trim();
    // 移除 markdown ```json 和 ``` 标记
    if (s.startsWith('```')) {
      s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    }
    // 提取首个 { 到最后一个 }
    const firstBrace = s.indexOf('{');
    const lastBrace = s.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      s = s.slice(firstBrace, lastBrace + 1);
    }
    return s;
  }

  /**
   * 测试 DeepSeek API Key 连通性
   */
  async function testConnection(cfg) {
    const config = Object.assign({}, DEFAULT_CONFIG, cfg || {});
    const apiKey = cleanApiKey(config.apiKey);
    if (!apiKey) {
      return { ok: false, error: '请先填入 DeepSeek API Key' };
    }

    const endpoint = (config.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '') + '/chat/completions';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    const model = config.model || DEFAULT_CONFIG.model;
    const isReasoner = model.includes('reasoner');

    const reqBody = {
      model: model,
      messages: [
        { role: 'user', content: 'Hi, please reply with JSON: {"status":"ok"}' },
      ],
      max_tokens: 20,
    };
    if (!isReasoner) {
      reqBody.response_format = { type: 'json_object' };
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let serverDetail = '';
        if (errText) {
          try {
            const parsed = JSON.parse(errText);
            if (parsed && parsed.error && parsed.error.message) serverDetail = parsed.error.message;
          } catch (e) {
            serverDetail = errText.slice(0, 150);
          }
        }

        let errMsg = 'HTTP ' + res.status;
        if (res.status === 401) {
          errMsg = serverDetail
            ? ('API Key 认证失败 (401)：' + serverDetail + '。\n请检查密钥是否有效未过期，或前往 platform.deepseek.com 重新生成')
            : 'API Key 认证失败 (401 Unauthorized)，请检查输入的密钥是否正确有效';
        } else if (res.status === 402) {
          errMsg = serverDetail
            ? ('账户余额不足 (402)：' + serverDetail)
            : 'DeepSeek 账户余额已耗尽，请前往 platform.deepseek.com 充值';
        } else if (res.status === 429) {
          errMsg = serverDetail
            ? ('请求过于频繁 (429)：' + serverDetail)
            : 'DeepSeek 接口请求过于频繁，请稍候再试';
        } else if (serverDetail) {
          errMsg = serverDetail;
        }
        return { ok: false, error: errMsg };
      }

      return { ok: true };
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') return { ok: false, error: '连接超时（12秒未响应）' };
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /**
   * 将多篇笔记分批发送给 DeepSeek 进行智能归类与打标
   * @param {Object} cfg - 配置对象 (apiKey, model, baseUrl)
   * @param {Array} notes - 待分析笔记列表 [{ id, title, author }]
   * @param {Function} onProgress - 进度回调 (done, total)
   */
  async function analyzeNotes(cfg, notes, onProgress) {
    const config = Object.assign({}, DEFAULT_CONFIG, cfg || {});
    const apiKey = cleanApiKey(config.apiKey);
    if (!apiKey) {
      throw new Error('未配置 DeepSeek API Key，请先在设置中填写');
    }

    if (!Array.isArray(notes) || notes.length === 0) {
      return {};
    }

    const endpoint = (config.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '') + '/chat/completions';
    const BATCH_SIZE = 35;
    const allResults = {};
    const total = notes.length;
    let completed = 0;

    const model = config.model || DEFAULT_CONFIG.model;
    const isReasoner = model.includes('reasoner');

    for (let i = 0; i < notes.length; i += BATCH_SIZE) {
      const batch = notes.slice(i, i + BATCH_SIZE).map(n => ({
        id: n.id,
        title: (n.title || '').slice(0, 60),
        author: (n.author || '').slice(0, 30),
      }));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000);

      const reqBody = {
        model: model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: '请分析以下 ' + batch.length + ' 篇小红书笔记：\n' + JSON.stringify(batch) },
        ],
      };
      if (!isReasoner) {
        reqBody.response_format = { type: 'json_object' };
        reqBody.temperature = 0.2;
      }

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
          },
          body: JSON.stringify(reqBody),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          let serverDetail = '';
          if (errText) {
            try {
              const j = JSON.parse(errText);
              if (j && j.error && j.error.message) serverDetail = j.error.message;
            } catch (e) {
              serverDetail = errText.slice(0, 150);
            }
          }

          let errMsg = '调用 AI 失败 (HTTP ' + res.status + ')';
          if (res.status === 401) {
            errMsg = serverDetail
              ? ('DeepSeek API 认证失败 (401)：' + serverDetail + '。请检查设置中的密钥是否有效未过期')
              : 'DeepSeek API Key 验证失败 (401 Unauthorized)，请检查设置中的密钥是否有效或包含多余字符';
          } else if (res.status === 402) {
            errMsg = serverDetail
              ? ('DeepSeek 账户余额不足 (402)：' + serverDetail)
              : 'DeepSeek 账户余额已耗尽，请前往 platform.deepseek.com 充值';
          } else if (res.status === 429) {
            errMsg = serverDetail
              ? ('DeepSeek 请求频率超限 (429)：' + serverDetail)
              : 'DeepSeek 请求频率超限，请稍候再试';
          } else if (serverDetail) {
            errMsg = serverDetail;
          }
          throw new Error(errMsg);
        }

        const data = await res.json();
        const contentStr = data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content
          : '{}';

        const parsed = JSON.parse(cleanJsonText(contentStr));
        const items = parsed.items || parsed;

        if (items && typeof items === 'object') {
          for (let j = 0; j < batch.length; j++) {
            const id = batch[j].id;
            const item = items[id] || {};
            allResults[id] = {
              category: item.category || '其他',
              decision: item.decision || '普通浏览',
              reason: item.reason || '',
              updatedAt: Date.now(),
            };
          }
        }
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          throw new Error('AI 分析请求超时，请稍候再试');
        }
        throw err;
      }

      completed += batch.length;
      if (typeof onProgress === 'function') {
        onProgress(Math.min(completed, total), total);
      }
    }

    return allResults;
  }

  /**
   * 从 chrome.storage.local 读取 AI 配置
   */
  async function loadConfig() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const res = await chrome.storage.local.get([STORAGE_KEY_CONFIG]);
        return Object.assign({}, DEFAULT_CONFIG, res[STORAGE_KEY_CONFIG] || {});
      }
    } catch (e) {}
    return Object.assign({}, DEFAULT_CONFIG);
  }

  /**
   * 保存 AI 配置至 chrome.storage.local
   */
  async function saveConfig(cfg) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const toSave = Object.assign({}, cfg || {});
        if (toSave.apiKey !== undefined) {
          toSave.apiKey = cleanApiKey(toSave.apiKey);
        }
        await chrome.storage.local.set({ [STORAGE_KEY_CONFIG]: toSave });
        return true;
      }
    } catch (e) {}
    return false;
  }

  /**
   * 从 chrome.storage.local 读取已缓存的 AI 标签
   */
  async function loadSavedTags() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const res = await chrome.storage.local.get([STORAGE_KEY_TAGS]);
        return res[STORAGE_KEY_TAGS] || {};
      }
    } catch (e) {}
    return {};
  }

  /**
   * 增量合并保存笔记的 AI 标签
   */
  async function saveTags(newTags) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const cur = await loadSavedTags();
        const merged = Object.assign({}, cur, newTags || {});
        // 最多保留最近 1500 条
        const keys = Object.keys(merged);
        if (keys.length > 1500) {
          keys.sort((a, b) => (merged[a].updatedAt || 0) - (merged[b].updatedAt || 0));
          const toRemove = keys.slice(0, keys.length - 1500);
          for (let i = 0; i < toRemove.length; i++) delete merged[toRemove[i]];
        }
        await chrome.storage.local.set({ [STORAGE_KEY_TAGS]: merged });
        return merged;
      }
    } catch (e) {}
    return newTags || {};
  }

  /**
   * 清空本地存储的 AI 标签
   */
  async function clearTags() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.remove([STORAGE_KEY_TAGS]);
      }
    } catch (e) {}
  }

  const RNAI = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    DECISION_META: DECISION_META,
    cleanApiKey: cleanApiKey,
    cleanJsonText: cleanJsonText,
    testConnection: testConnection,
    analyzeNotes: analyzeNotes,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    loadSavedTags: loadSavedTags,
    saveTags: saveTags,
    clearTags: clearTags,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RNAI;
  }
  globalThis.RNAI = RNAI;
})();
