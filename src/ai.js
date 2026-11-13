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
    '',
    '【格式严苛规范】：',
    '1. 必须输出严格符合标准 JSON 格式的对象，严禁在最后一个属性或最后一个对象后留有末尾逗号 (trailing comma)。',
    '2. 严禁在 reason 内容中使用半角双引号，如有引用请用中文引号「」或书名号《》代替。',
    '3. 只返回纯 JSON，不附带任何前缀或后缀说明。',
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
   * 自动剥离 Markdown 围栏、注释、以及尾随逗号 (trailing commas)
   */
  function cleanJsonText(raw) {
    if (!raw) return '{}';
    let s = String(raw).trim();

    // 剔除所有 markdown 代码块标记 (如 ```json 或 ```)
    s = s.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

    // 提取首个 { 到最后一个 }，或首个 [ 到最后一个 ]
    const firstBrace = s.indexOf('{');
    const lastBrace = s.lastIndexOf('}');
    const firstBracket = s.indexOf('[');
    const lastBracket = s.lastIndexOf(']');

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
      if (firstBracket === -1 || firstBrace < firstBracket) {
        s = s.slice(firstBrace, lastBrace + 1);
      } else if (lastBracket > firstBracket) {
        s = s.slice(firstBracket, lastBracket + 1);
      }
    } else if (firstBracket !== -1 && lastBracket !== -1 && lastBracket >= firstBracket) {
      s = s.slice(firstBracket, lastBracket + 1);
    }

    // 移除多行与单行注释
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');
    s = s.replace(/^\s*\/\/.*$/gm, '');

    // 循环剔除尾随逗号 (trailing commas: ,} 或 ,])
    let prev;
    do {
      prev = s;
      s = s.replace(/,\s*([}\]])/g, '$1');
    } while (s !== prev);

    return s;
  }

  /**
   * 鲁棒解析 LLM 返回的 JSON 内容
   * 多重降级防护体系：
   * 1. 尝试清洗后的标准 JSON.parse
   * 2. 尝试清洗控制字符与非法换行后的 JSON.parse
   * 3. 若仍解析失败，启动正则逐条提取引擎 (逐项提取 id -> category, decision, reason)，
   *    确保即使个别记录含有未转义半角引号等语法残损，其余有效笔记全部正常完成打标，绝不抛出语法崩溃中断
   */
  function parseAiJsonSafely(raw, batchIds) {
    const cleaned = cleanJsonText(raw);

    // 第 1 级尝试：标准清洗解析
    try {
      return JSON.parse(cleaned);
    } catch (e1) {
      // 降级尝试
    }

    // 第 2 级尝试：清理字符串内部未转义的控制字符 (0x00 - 0x1F)
    try {
      const sanitized = cleaned.replace(/[\u0000-\u0009\u000B-\u001F]+/g, ' ');
      return JSON.parse(sanitized);
    } catch (e2) {
      // 降级尝试
    }

    // 第 3 级尝试：正则语义逐条提取兜底引擎
    const items = {};
    const ids = Array.isArray(batchIds) && batchIds.length > 0 ? batchIds : [];

    for (let k = 0; k < ids.length; k++) {
      const id = String(ids[k]);
      const escapedId = id.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      const blockRegex = new RegExp('["\']?' + escapedId + '["\']?\\s*:\\s*\\{([\\s\\S]*?)(?:\\}\\s*[,}]|(?=["\']?[a-zA-Z0-9_-]+["\']?\\s*:\\s*\\{)|$)', 'i');
      const blockMatch = cleaned.match(blockRegex);
      if (blockMatch) {
        const body = blockMatch[1];
        const catM = body.match(/["']category["']\s*:\s*["']([^"']+)["']/i);
        const decM = body.match(/["']decision["']\s*:\s*["']([^"']+)["']/i);
        const reaM = body.match(/["']reason["']\s*:\s*["']([\s\S]*?)["'](?=\s*[,}\n]|$)/i)
          || body.match(/["']reason["']\s*:\s*["']([^"'\r\n]+)/i);
        items[id] = {
          category: catM ? catM[1].trim() : '其他',
          decision: decM ? decM[1].trim() : '普通浏览',
          reason: reaM ? reaM[1].trim() : '',
        };
      }
    }

    if (Object.keys(items).length > 0) {
      return { items: items };
    }

    // 通用提取：扫描所有 ID 格式
    const genericRegex = /["']([a-zA-Z0-9_-]{8,36})["']\s*:\s*\{([^{}]+)\}/g;
    let m;
    while ((m = genericRegex.exec(cleaned)) !== null) {
      const gId = m[1];
      const gBody = m[2];
      const catM = gBody.match(/["']category["']\s*:\s*["']([^"']+)["']/i);
      const decM = gBody.match(/["']decision["']\s*:\s*["']([^"']+)["']/i);
      const reaM = gBody.match(/["']reason["']\s*:\s*["']([^"']+)["']/i);
      items[gId] = {
        category: catM ? catM[1].trim() : '其他',
        decision: decM ? decM[1].trim() : '普通浏览',
        reason: reaM ? reaM[1].trim() : '',
      };
    }

    return { items: items };
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
    const BATCH_SIZE = 20;
    const allResults = {};
    const total = notes.length;
    let completed = 0;

    const model = config.model || DEFAULT_CONFIG.model;
    const isReasoner = model.includes('reasoner');

    for (let i = 0; i < notes.length; i += BATCH_SIZE) {
      const batch = notes.slice(i, i + BATCH_SIZE).map(n => ({
        id: String(n.id),
        title: (n.title || '').slice(0, 60),
        author: (n.author || '').slice(0, 30),
      }));

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

      let lastErr = null;
      let batchSuccess = false;

      // 单次批次允许 1 次瞬态网络重试，增强抗波动韧性
      for (let attempt = 0; attempt < 2 && !batchSuccess; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 35000);

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
              throw new Error(errMsg);
            } else if (res.status === 402) {
              errMsg = serverDetail
                ? ('DeepSeek 账户余额不足 (402)：' + serverDetail)
                : 'DeepSeek 账户余额已耗尽，请前往 platform.deepseek.com 充值';
              throw new Error(errMsg);
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

          const batchIds = batch.map(b => b.id);
          const parsed = parseAiJsonSafely(contentStr, batchIds);
          let items = parsed.items || parsed;

          // 若返回数组格式，自动转为按 id 索引的对象
          if (Array.isArray(items)) {
            const map = {};
            for (let m = 0; m < items.length; m++) {
              const it = items[m];
              if (it && it.id) map[String(it.id)] = it;
            }
            items = map;
          }

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

          batchSuccess = true;
        } catch (err) {
          clearTimeout(timer);
          lastErr = err;
          // 致命鉴权/余额错误直接跳出，不重试
          if (err && (String(err.message).includes('401') || String(err.message).includes('402'))) {
            throw err;
          }
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 1200));
          }
        }
      }

      if (!batchSuccess) {
        if (lastErr && lastErr.name === 'AbortError') {
          throw new Error('AI 分析请求超时，请稍候再试');
        }
        throw (lastErr || new Error('AI 分析批次失败'));
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
    parseAiJsonSafely: parseAiJsonSafely,
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
