/**
 * hot-trends —— 热梗速查（LLM 型技能 / API v1）
 *
 * ── 为什么是技能，不是插件 ────────────────────────────────────────────────
 * 判据（src/skills/manifest.js 的 DIR_KIND）：
 *   plugins/ 确定性型 —— 条件满足必然执行，不经过 LLM
 *   skills/  LLM 型   —— registerTool，用不用、什么时候用**由模型判断**
 *
 * "该不该聊这个梗、要不要查、查完怎么说" 全是判断题，只能由模型来做。
 * 而"每天到点抓一次、过期删掉"是纯机械动作，已经交给插件
 * hot-trend-tracker（它提供能力 knowledge.hot-trends）。本技能只负责
 * 把那个知识库**递到模型手边**：注册工具 + 提示词片段。
 *
 * ── 分工边界（这条边界别越）──────────────────────────────────────────────
 *   本技能：注册 hot_brief / hot_status；渲染给人看的结果；可选补一次联网搜索
 *   插件：  抓取 / 去重 / 保鲜期 / 落盘 / 统计
 *   连接方式：软依赖 api.capability('knowledge.hot-trends')
 *             —— 插件没装时本技能**依然可用**（工具照常注册），
 *                只是查询会明确告诉模型"知识库不可用，请直接联网搜"，
 *                而不是返回空列表让它以为"网上最近没事发生"。
 *
 * ── 踩坑备忘 ─────────────────────────────────────────────────────────────
 *   · api.capability() 对**异步**提供者会返回 Promise，对同步的返回裸值。
 *     插件那个提供者是同步的，但这里仍然统一 await —— 免得以后插件改成
 *     异步时静默拿到一个 Promise 对象再渲染成 [object Promise]。
 *   · 不能返回空列表当作"没有热点"：必须区分"知识库是空的"和"知识库没在
 *     工作"。前者模型可以直接联网搜，后者要告诉用户去开插件，两者的回复
 *     完全不一样。
 *   · 工具输出直接进模型上下文，所以要"够用但不啰嗦"：默认 10 条、简介
 *     200 字，并且明确写出总条数，让模型知道还有多少没看到。
 */

const BUILD_TAG = 'v1.0.0';
const CAP = 'knowledge.hot-trends';

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let fetchImpl = null;      // 由 api.fetch 注入（本技能未声明 web_fetch 权限 → 不可用）
let capability = () => undefined;

const DEFAULTS = {
  defaultLimit: 10,
  maxLimit: 30,
  queryDescChars: 200,
  showSource: true,
  defaultLiveSearch: false
};

// ───────────────────────────── 小工具 ─────────────────────────────

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function str(v, dflt = '') {
  const s = String(v ?? '').trim();
  return s || dflt;
}

function settings() {
  const s = (typeof cfg === 'function' ? cfg() : null) || {};
  const pick = (k) => (s[k] === undefined || s[k] === null || s[k] === '' ? DEFAULTS[k] : s[k]);
  return {
    defaultLimit: Math.max(1, Math.min(30, Math.round(num(pick('defaultLimit'), DEFAULTS.defaultLimit)))),
    maxLimit: Math.max(1, Math.min(50, Math.round(num(pick('maxLimit'), DEFAULTS.maxLimit)))),
    queryDescChars: Math.max(0, Math.min(400, Math.round(num(pick('queryDescChars'), DEFAULTS.queryDescChars)))),
    showSource: s.showSource !== false,
    defaultLiveSearch: s.defaultLiveSearch === true
  };
}

function fail(message) {
  return { content: `错误：${message}`, isError: true };
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 清洗搜索片段。
 *
 * 实测：核心的 webSearch 返回的 snippet 里带着解码前的 HTML 实体
 * （`&ensp;` `&#0183;` `&amp;`）和页面模板残渣（`<div class="u-atlist"> {if
 * suggests.length == 0}` 这种）。这些会**原样进模型上下文** —— 既浪费 token，
 * 又让模型读到一堆看不懂的噪音，还可能被误导。这里统一剥掉实体和标签。
 */
function cleanSnippet(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const n = parseInt(d, 10);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]{0,200}>/g, ' ')          // 标签
    .replace(/\{\/?[a-z_]+[^}]{0,80}\}/gi, ' ')  // 模板残渣 {if ...} {/if}
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 取插件提供的能力。
 * 统一 await：api.capability 对同步提供者返回裸值、对异步返回 Promise，
 * 两条路都要能走通。
 */
async function callCapability(args) {
  try {
    const fn = capability(CAP, args);
    if (fn && typeof fn.then === 'function') return await fn;
    return fn;
  } catch (error) {
    warn(`调用 ${CAP} 失败：${error?.message ?? error}`);
    return undefined;
  }
}

/** 知识库是否可用（不看有没有数据，只看通道通不通）。 */
function capabilityReady() {
  try {
    return typeof capability === 'function' ? capability(CAP) !== undefined : false;
  } catch {
    return false;
  }
}

// ───────────────────────────── 渲染 ─────────────────────────────

/** 把 query() 的结果渲染成给模型看的紧凑清单。 */
function renderTopics(res, s, extra = {}) {
  const L = [];
  const head = [];
  head.push(`本地热梗库：${res.total} 条在库、${res.fresh} 条在保鲜期`);
  if (res.query) head.push(`关键词「${res.query}」命中 ${res.matched} 条`);
  head.push(`最近更新 ${res.lastCollectedText}`);
  L.push(`【热梗速查】${head.join('　|　')}`);

  if (!res.returned) {
    L.push(res.query
      ? ' · 没有匹配的话题。可以换个说法再查，或者直接用 web_search 联网搜。'
      : ' · 知识库里现在没有还在保鲜期内的话题。');
  } else {
    for (const t of res.topics) {
      const src = s.showSource ? `（${t.sources.join('/')}，${t.lastSeenText}）` : '';
      L.push(`· ${t.title}${src}`);
      if (t.desc) L.push(`   ${t.desc}`);
    }
    if (res.matched > res.returned) {
      L.push(`（命中 ${res.matched} 条，只显示了前 ${res.returned} 条；需要更多就带 query 再查一次。）`);
    }
  }

  L.push('提醒：这些只是标题和简介，不是全部事实。要细节就用 web_search / web_fetch 核实；'
    + '核实不了就只说你确定的部分，别顺着标题编内容。');
  if (extra.liveNote) L.push(extra.liveNote);
  return L.join('\n');
}

/** 知识库通道不通时的说明（绝不能伪装成"没有热点"）。 */
function renderUnavailable() {
  return [
    '【热梗速查】本地热梗知识库当前**不可用** —— 这不是"最近没有热点"，而是后台收集插件没在工作。',
    '原因通常是：「热梗事件收集」(hot-trend-tracker) 插件被关掉或未安装，或者技能配置里禁用了它。',
    '现在该怎么办：直接用 web_search 联网搜（需要实时信息时本来就该这么办）；'
    + '如果希望恢复「先查本地、少花钱」的路径，去 QQ Agent 的插件页把「热梗事件收集」打开。',
    '不要对群友说"我的知识库坏了"这类内部细节，直接按联网搜索的结果正常聊就行。'
  ].join('\n');
}

// ───────────────────────────── 可选：补一次联网搜索 ─────────────────────────────

/**
 * 用核心的 webSearch 补一次实时结果。
 *
 * 为什么优先用 api.fetch 而不是直接 import：技能的权限白名单里，
 * 联网只能通过声明 web_fetch 权限拿到（plugin-loader 的 createSkillApi）。
 * 这里没有声明该权限，所以 api.fetch 实际上是"拒绝式"函数 —— 于是回退到
 * 核心自己的搜索模块，它自带查询词清洗与（多引擎）渠道配置，
 * 比技能自己 fetch 更合适。
 */
async function liveSearch(query, maxResults = 4) {
  const q = str(query);
  if (!q) return { ok: false, reason: '没有给搜索词' };
  try {
    const mod = await import('../../src/web-search.js');
    if (typeof mod.webSearch !== 'function') return { ok: false, reason: '核心没有导出 webSearch' };
    const res = await mod.webSearch(q);
    const results = Array.isArray(res?.results) ? res.results.slice(0, maxResults) : [];
    if (!results.length) return { ok: false, reason: '搜索没有返回结果' };
    const lines = results.map((r) => {
      const title = clip(cleanSnippet(r.title), 80);
      const snippet = clip(cleanSnippet(r.snippet), 140);
      return `· ${title}${snippet ? `：${snippet}` : ''}`;
    });
    return { ok: true, text: `【联网搜索结果：${q}】\n${lines.join('\n')}` };
  } catch (error) {
    // 搜索渠道配错是常见情况（例如 provider 指向的渠道没填 Key），
    // 必须把真实原因带出去，否则模型和用户都只会看到"搜不到"。
    return { ok: false, reason: clip(error?.message ?? error, 160) };
  }
}

// ───────────────────────────── 工具 ─────────────────────────────

export function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  if (typeof api?.log === 'function') log = api.log;
  if (typeof api?.warn === 'function') warn = api.warn;
  if (typeof api?.capability === 'function') capability = api.capability;
  fetchImpl = typeof api?.fetch === 'function' ? api.fetch : null;

  api.registerTool({
    id: 'hot_brief',
    name: '查热梗热点',
    description: '查本地热梗库（每天自动更新的网上热搜/贴吧热议/B站热门），用于了解「最近网上在聊什么」。'
      + '什么时候用：① 群里提到最近的热搜、新梗、网络流行语，你要确认自己知不知道；'
      + '② 有人说你「out 了」「这都不知道」；③ 你想主动抛个话题，先看看最近有什么可聊的；'
      + '④ 讨论里出现一个你不认识的词，怀疑是梗。'
      + '怎么用：不带参数 = 给最新的一批；带 query = 按关键词找（比如某个梗名、人名、事件）。'
      + '本地库只有标题和简介，**不是完整事实**：需要细节、要确认传闻真假时，把 live 设为 true 让它顺带联网搜一次，'
      + '或者自己再用 web_search。查不到不代表没有，只代表本地库没收录。'
      + '这是你自己的查资料动作，结果不要原样发进群里 —— 看完用你自己的话聊。',
    category: 'knowledge',
    icon: '🔥',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，比如「×× 梗」「某个明星」「某个事件」。留空 = 看最新的一批。' },
        limit: { type: 'number', description: '最多返回几条，默认 10。' },
        live: { type: 'boolean', description: 'true = 额外联网搜一次（更准更新，但慢且花 token）。默认 false，先信本地库。' },
        includeStale: { type: 'boolean', description: 'true = 连已经过了保鲜期的旧话题也返回。默认 false（过期的等于旧闻，容易说错话）。' }
      }
    },
    async execute(ctx, args) {
      const raw = typeof args === 'string' ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : (args || {});
      const s = settings();
      const limit = Math.max(1, Math.min(s.maxLimit, Math.round(num(raw.limit, s.defaultLimit))));
      const query = str(raw.query);
      const wantLive = raw.live === true || (raw.live === undefined && s.defaultLiveSearch);

      // ── 本地库通道不通：明确说清楚，并给出可执行的替代动作 ──
      if (!capabilityReady()) {
        const lines = [renderUnavailable()];
        if (wantLive && query) {
          const live = await liveSearch(query, 4);
          lines.push(live.ok ? live.text : `（另外，联网搜索也没成功：${live.reason}）`);
        }
        return { content: lines.join('\n\n') };
      }

      let res;
      try {
        res = await callCapability({
          action: 'query',
          query,
          limit,
          descChars: s.queryDescChars,
          includeStale: raw.includeStale === true
        });
      } catch (error) {
        return fail(`查询热梗库时出错：${error?.message ?? error}`);
      }
      if (!res || typeof res !== 'object') {
        return fail('热梗库没有返回结果（插件可能加载失败了，去 QQ Agent 的插件页看「热梗事件收集」的状态）。');
      }

      const extra = {};
      if (wantLive) {
        const q = query || (res.topics?.[0]?.title ?? '');
        const live = await liveSearch(q, 4);
        extra.liveNote = live.ok ? live.text : `（联网搜索没成功：${live.reason}）`;
      }
      return { content: renderTopics(res, s, extra) };
    }
  });

  api.registerTool({
    id: 'hot_status',
    name: '热梗库状态与维护',
    description: '查看本地热梗库的健康状况：最后一次成功更新是什么时候、三个来源各自通不通、库里有多少条、'
      + '以及手动触发的维护动作。什么时候用：① 有人问「你的热梗库多久没更新了」「你是不是不知道新梗了」；'
      + '② 查热梗发现内容很旧、或者查询总是失败；③ 有人明确让你「现在去更新一下热梗」；'
      + '④ 用户想「用完就卸载/清空」时帮他清掉。'
      + 'action 可选：status（默认，只看状态）、refresh（立刻抓一次，要联网、几秒钟）、'
      + 'clear（清空知识库，不可恢复）、clear_keep_today（只留今天抓到的）。'
      + 'clear 类动作会真的删数据，除非对方明确要求，否则不要自作主张调用。',
    category: 'knowledge',
    icon: '🧹',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'refresh', 'clear', 'clear_keep_today'],
          description: '要做的动作，默认 status。'
        }
      }
    },
    async execute(ctx, args) {
      const raw = typeof args === 'string' ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : (args || {});
      const action = str(raw.action, 'status').toLowerCase();

      if (!capabilityReady()) {
        return {
          content: renderUnavailable()
            + '\n\n（维护动作需要插件在运行，现在做不了。）'
        };
      }

      try {
        if (action === 'refresh') {
          const r = await callCapability({ action: 'collect' });
          const st = await callCapability({ action: 'status' });
          const lines = [
            '【热梗库 · 手动刷新】',
            r?.ok
              ? `抓取完成：新增 ${r.added ?? 0} 条、更新 ${r.updated ?? 0} 条、清理过期 ${r.pruned ?? 0} 条，`
                + `现在库里 ${r.total ?? 0} 条，耗时 ${r.ms ?? 0}ms。`
              : `抓取失败：${r?.error || '未知原因'}`,
            st ? renderStatus(st) : ''
          ].filter(Boolean);
          return { content: lines.join('\n') };
        }

        if (action === 'clear' || action === 'clear_keep_today') {
          const keepToday = action === 'clear_keep_today';
          const r = await callCapability({ action: 'clear', keepToday });
          return {
            content: `【热梗库 · 清理】已删除 ${r?.removed ?? 0} 条，剩余 ${r?.left ?? 0} 条`
              + `${keepToday ? '（保留了今天抓到的）' : '（已清空）'}。\n`
              + '提醒：这只清掉了本地缓存的卡片，插件本身还在、明天到点还会继续抓。'
              + '如果想彻底不再收集，要去 QQ Agent 的插件页把「热梗事件收集」关掉或卸载。'
          };
        }

        const st = await callCapability({ action: 'status' });
        if (!st || typeof st !== 'object') return fail('热梗库没有返回状态（插件可能加载失败了）。');
        return { content: renderStatus(st) };
      } catch (error) {
        return fail(`操作热梗库失败：${error?.message ?? error}`);
      }
    }
  });

  log(`热梗速查已加载（${BUILD_TAG}）｜工具 hot_brief / hot_status｜知识库通道：`
    + `${capabilityReady() ? '已接通' : '未接通（热梗事件收集插件未启用）'}`);
}

/** 状态渲染：把"哪里坏了"说清楚，而不是只报一个总数。 */
function renderStatus(st) {
  const L = [];
  L.push('【热梗库 · 状态】');
  L.push(`· 自动收集：${st.enabled ? '开启' : '已关闭'}　定时器：${st.timerRunning ? '在跑' : '没在跑'}`);
  L.push(`· 最后一次成功更新：${st.lastCollectedText}　下次预计：${st.nextRunText}`);
  L.push(`· 在库 ${st.total} 条，其中保鲜期内 ${st.fresh} 条（保鲜 ${st.keepDays} 天，上限 ${st.maxTopics} 条）`);
  L.push(`· 文件：${clip(st.storeFile, 120)}（${Math.round(num(st.bytes, 0) / 1024)}KB）`);
  L.push('· 各来源：');
  for (const [, v] of Object.entries(st.sources || {})) {
    const state = !v.enabled ? '未启用'
      : (v.streak > 0 ? `连续失败 ${v.streak} 次` : '正常');
    L.push(`   - ${v.label}：${v.status || state}｜累计成功 ${v.ok} / 失败 ${v.fail}｜`
      + `上次成功 ${v.lastOkText}${v.lastCount ? `（${v.lastCount} 条）` : ''}`
      + `${v.lastError ? `｜最近错误：${clip(v.lastError, 80)}` : ''}`);
  }
  L.push(`· 已服务查询 ${st.stats?.served ?? 0} 次、自动递小抄 ${st.stats?.injected ?? 0} 次，`
    + `累计抓取 ${st.stats?.collectRuns ?? 0} 轮（上轮耗时 ${st.stats?.lastRunMs ?? 0}ms）`);
  if (st.lastRunOk === false && st.lastError) {
    L.push(`· ⚠️ 最近一轮抓取**全部失败**：${clip(st.lastError, 160)}`);
  }
  L.push('（说明：抓取是纯后台动作，不消耗 token；只有把内容递给模型看时才算花费。）');
  return L.join('\n');
}

/** 测试/排障用导出。 */
export const __internals = { settings, renderTopics, renderStatus, renderUnavailable, liveSearch, callCapability };
