// 音游知识库（LLM 型技能）—— 注册查询工具，由模型自己决定何时查。
//
// 为什么放在 skills/ 而不是 plugins/：
//   plugins/ 是"确定性型"，靠能力(providers)/钩子(hooks)被核心代码在固定条件下调用；
//   本功能没有任何"满足条件必然执行"的时机可言 —— 什么时候有人问音游、问的是哪条，
//   只能靠模型理解人话来判断。放在 plugins/ 且只 registerTool 会触发加载器的
//   lintKindPlacement 警告（模块在 plugins/ 却没有能力/钩子）。
//
// 数据来源两个：
//   1. 技能自带底稿  skills/rhythm-kb/kb/*.json                  —— 随技能分发，只读
//   2. 群友教的新条目 <DATA_DIR>/rhythm-kb/user-added.json        —— 唯一会被写入的文件
//
// 为什么写在外面而不是 kb/ 里：skills/ 是热重载监听目录，每次"收录一条知识"都往
// kb/ 写文件会触发整轮重新扫描 + 重新加载技能（500ms 防抖后重扫两个目录），
// 属于没必要的行为。数据目录约定与 skills/music/lib/store.js 完全一致：
// 优先环境变量 QQ_AGENT_DATA_DIR（由 electron/main.js 设置），取不到时按目录层级
// 推算 <app>/data —— 这样安装版和开发版落在同一个地方。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cfg = () => ({});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.join(HERE, 'kb');
const APP_ROOT = path.resolve(HERE, '..', '..');
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(APP_ROOT, 'data');
const USER_DIR = path.join(DATA_DIR, 'rhythm-kb');
const USER_FILE = path.join(USER_DIR, 'user-added.json');

const MAX_ENTRIES = 1500;  // 防呆：只约束"群友教的"那一份，别让它无限增长（自带底稿已有数百条）

// ── 知识库读取（3 秒缓存）────────────────────────────────────────────────
// 工具可用性检查会在每轮对话里被调用多次，每次都同步读盘没必要。
// 缓存只影响"读到新内容"的延迟，不影响热重载（改 kb/*.json 会整轮重载技能）。
let cache = { at: 0, entries: [] };

function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // 记事本 / PowerShell 的 UTF-8 会带 BOM，JSON.parse 遇到 \uFEFF 直接抛错
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;   // 文件不存在或格式坏掉：当作没有，不影响其它条目
  }
}

function toList(value) {
  if (Array.isArray(value)) return value.map((x) => String(x ?? '').trim()).filter(Boolean);
  return String(value ?? '')
    .split(/[、,，/|]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeEntry(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title ?? '').trim();
  if (!title) return null;   // 没标题的条目无法被检索，直接丢弃
  return {
    title,
    aliases: toList(raw.aliases),
    tags: toList(raw.tags),
    category: String(raw.category ?? '').trim(),
    summary: String(raw.summary ?? '').trim(),
    details: String(raw.details ?? '').trim(),
    tips: toList(raw.tips),
    source
  };
}

function entriesOf(raw, source) {
  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.entries) ? raw.entries : []);
  return arr.map((e) => normalizeEntry(e, source)).filter(Boolean);
}

function loadKnowledge({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.entries.length && now - cache.at < 3000) return cache.entries;

  const all = [];
  try {
    const files = fs.readdirSync(KB_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
    for (const f of files) all.push(...entriesOf(readJson(path.join(KB_DIR, f)), f));
  } catch { /* kb/ 不存在：只剩群友教的条目 */ }
  all.push(...entriesOf(readJson(USER_FILE), 'user-added.json'));

  // 同标题去重：自带底稿优先，保证人工维护的内容不会被群友收录的版本盖掉
  const byTitle = new Map();
  for (const e of all) {
    const key = e.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, e);
  }
  const entries = [...byTitle.values()];
  cache = { at: now, entries };
  return entries;
}

// ── 检索 ────────────────────────────────────────────────────────────────
// 中文没有空格分词，所以走"整词命中 + 二字组重叠"两段式：
// 短查询（屁股肉 / 定数 / 手疼）走整词；长句（Phigros的RKS怎么才能涨）走二字组重叠。

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s\u3000]+/g, '');

function bigrams(s) {
  const t = norm(s);
  const out = new Set();
  if (t.length <= 1) { if (t) out.add(t); return out; }
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * 问句套话剥离。
 * 踩过的坑：上了 IDF 之后，"有什么区别""是什么"这类套话在知识库里**很罕见**，
 * 于是拿到很高的 idf —— 结果「叠键和切换有什么区别」被「定数和难度等级有什么区别」抢了头名，
 * 纯粹因为标题里都有"有什么区别"。套话必须在检索前剥掉，它不携带任何领域信息。
 */
const QUERY_NOISE = [
  '有什么区别', '有什么不同', '有什么差别', '是啥意思', '啥意思', '是什么意思',
  '是什么', '有哪些', '有那些', '怎么用', '怎么办', '怎么才能', '为什么', '怎么样',
  '是多少', '多少钱', '请问', '帮我', '一下', '这个', '那个', '如何'
];
function stripNoise(s) {
  let t = String(s ?? '');
  for (const n of QUERY_NOISE) t = t.split(n).join(' ');
  return t;
}

function tokensOf(query) {
  return String(query ?? '')
    .split(/[\s\u3000,，、;；:：!！?？"'“”‘’()（）\[\]【】{}/|\\+~*_-]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 中文没有空格，「Malody 的判定窗口是多少毫秒」会被切成「的判定窗口是多少毫秒」这**一个**长词，
 * 整词匹配必然落空 —— 而不切分就永远只能靠二字组兜底（噪声大）。
 * 这里对中文长词再切出 3~4 字滑窗：「判定窗口」「多少毫秒」「判定窗」都能拿去精确匹配标题。
 */
function expandTokens(tokens) {
  const out = [...tokens];
  for (const tok of tokens) {
    const t = norm(tok);
    if (t.length < 4 || /[\x00-\x7f]/.test(t)) continue;   // 只处理纯中文长词
    for (let n = 4; n >= 3; n -= 1) {
      for (let i = 0; i + n <= t.length; i += 1) out.push(t.slice(i, i + n));
    }
  }
  return [...new Set(out)];
}

// 常见虚词的二字组：它们出现在问题是必然的，不该产生命中
const STOP_BIGRAMS = new Set([
  '怎么', '什么', '为什', '么办', '可以', '是否', '不是', '没有', '怎样', '如何',
  '多少', '哪里', '这个', '那个', '的话', '还是', '就是', '应该', '要不', '不要',
  '能不', '不能', '是不', '不是', '一下', '一点', '有点', '很多', '有没', '知道',
  '请问', '告诉', '帮我', '为啥', '咋办', '回事',
  // 疑问句片段：不是术语，但容易在标题里撞上（"…是什么"这种标题很常见）
  '是什', '有什', '是个', '在哪', '了吗', '干嘛', '哪个', '几个'
]);

/**
 * 打分走三条路，缺一条都会在真实提问上漏匹配：
 *   (a) 查询词出现在条目文本里 —— 短查询（「定数」「手疼」）
 *   (b) 条目的名字/别名/标签出现在**查询里** —— 自然语言长问句
 *       （「屁股肉RKS怎么才能涨」里就藏着别名「屁股肉」和「RKS」）
 *   (c) 二字组兜底，忽略虚词 —— 换了个说法的问句（「打歌总是掉准」→「老掉准」）
 */
function scoreEntry(entry, tokens, queryNorm, idf = () => 1) {
  // 名字与别名：最强信号，既用于"查询词命中条目"，也用于"条目名出现在查询里"
  const named = [
    { text: norm(entry.title), w: 6 },
    ...entry.aliases.map((a) => ({ text: norm(a), w: 5 }))
  ];
  // 标签与分类：只是"归类"，不是"名字"，权重压到最低。
  // 踩过的坑：Malody 的每条词条都带 tag「Malody」，于是"Malody 上架有什么要求"这类问句
  // 让上百条同时拿到高分，真正的答案被淹掉；而且分数一样时排序等于随机。
  const weak = [
    ...entry.tags.map((t) => ({ text: norm(t), w: 1 })),
    { text: norm(entry.category), w: 1 }
  ];
  const fields = [
    ...named,
    ...weak,
    { text: norm(entry.summary), w: 2 },
    { text: norm(entry.details), w: 1 },
    { text: norm(entry.tips.join('')), w: 1 }
  ];

  let score = 0;

  // (a) 每个查询词只按"最匹配的那一个字段"计一次分。
  //     早期版本对所有命中字段累加，结果"别名里含 ln 的段位条目"靠别名数量滚雪球，
  //     把真正该回答的「面/longnote/ln」挤到了后面 —— 别名越多分越高的模型是错的。
  //     长度加成只给强字段（w>=4）：否则一个 6 字的平台标签也能拿满加成，重回刷分老路。
  for (const tok of tokens) {
    const t = norm(tok);
    if (!t) continue;
    let best = 0;
    for (const f of fields) {
      if (f.text && f.text.includes(t)) best = Math.max(best, f.w + (f.w >= 4 ? Math.min(4, t.length) : 0));
    }
    score += best * idf(t);
  }

  // (b)
  for (const f of named) {
    if (f.text.length >= 2 && queryNorm.includes(f.text)) score += (f.w + 6) * idf(f.text);
  }

  // (c) 二字组兜底**只认非 ASCII（中日文）二字组**。
  //     拉丁字母的二字组误撞率极高："xyzzy" 里的 zy 会撞上别名 chinacrazy，
  //     把"库里没有这条"错报成命中 —— 对"不许编造"的知识库来说这是最坏的一种错。
  const queryBigrams = [...bigrams(queryNorm)].filter((g) => !STOP_BIGRAMS.has(g) && !/[\x00-\x7f]/.test(g));
  if (queryBigrams.length) {
    for (const f of named) {
      if (f.text.length < 2) continue;
      const fb = bigrams(f.text);
      let matched = 0;
      for (const g of queryBigrams) if (fb.has(g)) matched += 1 * idf(g);
      if (matched > 0) score += matched * 1.2 * (f.w / 6);
    }
  }

  // 有人精确问某个游戏/术语时，正确条目排第一
  if (queryNorm && (norm(entry.title) === queryNorm || entry.aliases.some((a) => norm(a) === queryNorm))) {
    score += 8;
  }
  return score;
}

function search(query, limit) {
  const entries = loadKnowledge();
  const clean = stripNoise(query);
  const tokens = expandTokens(tokensOf(clean));
  const queryNorm = norm(clean);

  // ── IDF：压掉"满库都是"的词 ──────────────────────────────────────────
  // 711 条库里 malody / osu / 音游 这类词出现在上百条里，区分度接近 0。
  // 不压权的话，"Malody 的判定窗口是多少"会退化成"返回所有 Malody 条目"，
  // 真正的答案（Judge A~E 毫秒表）反而排不上来。
  // df 只在标题+别名上统计（够用且快），且在 n>60 时提前截断（idf 早已饱和）。
  const dfCache = new Map();
  const idf = (keyRaw) => {
    const t = norm(keyRaw);
    if (!t) return 1;
    const hit = dfCache.get(t);
    if (hit !== undefined) return hit;
    let n = 0;
    for (const e of entries) {
      if (norm(e.title).includes(t) || e.aliases.some((a) => norm(a).includes(t))) { n += 1; if (n > 60) break; }
    }
    const v = Math.log(1 + entries.length / (1 + n));
    dfCache.set(t, v);
    return v;
  };

  const scored = entries
    .map((entry) => ({ entry, score: scoreEntry(entry, tokens, queryNorm, idf) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  // 只保留分数在头名 1/4 以上的，避免正确答案被一堆弱命中挤掉、也避免白烧 token。
  const floor = Math.max(1, scored[0].score * 0.25);
  return scored.filter((x) => x.score >= floor).slice(0, limit).map((x) => x.entry);
}

function formatEntry(entry) {
  const lines = [`【${entry.title}】${entry.category ? `（${entry.category}）` : ''}`];
  if (entry.aliases.length) lines.push(`别名：${entry.aliases.join('、')}`);
  if (entry.summary) lines.push(entry.summary);
  if (entry.details) lines.push(entry.details);
  for (const tip of entry.tips) lines.push(`· ${tip}`);
  return lines.join('\n');
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));

// ── 入口 ────────────────────────────────────────────────────────────────
export function setup(api) {
  cfg = api.config;

  api.registerTool({
    id: 'search_knowledge',
    name: '查音游知识',
    description: '查询本地音游知识库。话题涉及音游时必须先查这里：音游名字或黑话（屁股肉、舞萌、啤酒烧烤、喵斯、阀门、osu、mania、malody…）、判定与判定区间、结算评级、定数、潜力值/RKS/PTT/Rating/pp/星数、谱面与键型（叠键/jack、乱键/stream、切换/stamina、面条/LN、秒杀/vibro、变速/SV、技巧/tech）、段位体系（dan、4K/7K 各段位）、推分瓶颈、新手入门、设备与延迟校准、外设键盘、贴膜指套、手疼、常用网站与工具、社区礼仪。参数 query 用问题里的关键词，例如「定数」「叠键」「鞋嘎子段」「判定区间」「sv2 判定」「手疼」。',
    category: 'knowledge',
    icon: '🎵',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的关键词或问题片段，例如「定数」「maimai Rating」「判定老Miss」' },
        limit: { type: 'number', description: '最多返回几条，1~5，默认用设置里的值' }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      const c = cfg() || {};
      const query = String(args?.query ?? '').trim();
      if (!query) {
        return { content: '缺少 query：告诉我查什么（例如「定数」「判定偏移」）。', isError: true };
      }
      const maxLimit = clamp(Number(c.maxResults) || 3, 1, 5);
      const limit = clamp(Number(args?.limit) || maxLimit, 1, 5);
      const hits = search(query, limit);

      if (!hits.length) {
        const all = loadKnowledge();
        const idxLimit = clamp(Number(c.indexLimit) || 20, 5, 60);
        const names = all.slice(0, idxLimit).map((e) => e.title);
        const tail = all.length > names.length ? `…等共 ${all.length} 条` : '';
        return {
          content: `知识库里没有和「${query}」相关的条目。`
            + (names.length ? `现有条目：${names.join('、')}${tail}。` : '知识库目前是空的。')
            + '请如实告诉群友库里没有这条，不要凭印象编造（定数、潜力值、曲目数量、价格、版本号尤其不能瞎说）。'
        };
      }

      const body = hits.map(formatEntry).join('\n\n---\n\n');
      return {
        content: `命中 ${hits.length} 条：\n\n${body}\n\n（回答时只取和问题相关的一两句，别把整段念出来；数字类信息以库里写的为准，库里没写的不要说。）`
      };
    }
  });

  api.registerTool({
    id: 'list_knowledge',
    name: '音游知识目录',
    description: '列出本地音游知识库里已有的条目（按分类分组，每个分类只列前几条）。用在：想确认库里覆盖了哪些游戏/术语，或者刚被问到的问题查不到、需要告诉对方库里有什么。要精确找条目请用 keyword 过滤。',
    category: 'knowledge',
    icon: '📚',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '可选：只看标题/别名里含这个词的条目，例如「判定」「Phigros」' }
      }
    },
    async execute(_ctx, args) {
      const keyword = String(args?.keyword ?? '').trim();
      let all = loadKnowledge();
      if (keyword) {
        const k = norm(keyword);
        all = all.filter((e) => norm(e.title).includes(k) || e.aliases.some((a) => norm(a).includes(k)));
      }
      if (!all.length) {
        return { content: keyword ? `知识库里没有含「${keyword}」的条目。` : '音游知识库目前是空的：请检查 skills/rhythm-kb/kb/ 下是否有 json 文件。' };
      }
      // 知识库已有数百条：每个分类只列前几条，否则单次工具结果上万字，纯烧 token。
      // keyword 过滤时放宽（那是有明确目标的查询）。
      const PER_CAT = keyword ? 40 : 6;
      const groups = new Map();
      for (const e of all) {
        const key = e.category || '未分类';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e.title);
      }
      const lines = [...groups.entries()].map(([cat, titles]) => {
        const shown = titles.slice(0, PER_CAT);
        const more = titles.length > shown.length ? `\n…另有 ${titles.length - shown.length} 条` : '';
        return `【${cat}】(${titles.length})\n${shown.map((t) => `· ${t}`).join('\n')}${more}`;
      });
      return { content: `共 ${all.length} 条（按分类）：\n\n${lines.join('\n\n')}\n\n要看某条的详细内容，用「查音游知识」按关键词检索。` };
    }
  });

  api.registerTool({
    id: 'add_knowledge',
    name: '收录音游知识',
    description: '把群友教的新音游知识写进本地知识库（写入 data/rhythm-kb/user-added.json）。只在有人明确要求「记一下／收录／记进库里／以后记住」时使用；不要自动收录随口提到的东西。参数 title 是条目标题，summary 是一句话说明。',
    category: 'knowledge',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '条目标题，例如「舞萌的段位认定」' },
        summary: { type: 'string', description: '一句话说明，写清楚这条是什么意思' },
        details: { type: 'string', description: '可选：更详细的补充说明' },
        aliases: { type: 'string', description: '可选：别名/黑话，用「、」分隔，例如「舞萌、洗衣板」' },
        tags: { type: 'string', description: '可选：标签，用「、」分隔，例如「街机、段位」' },
        category: { type: 'string', description: '可选：分类，例如「游戏介绍」「新手与提升」「基础机制」「黑话」' }
      },
      required: ['title', 'summary']
    },
    async execute(_ctx, args) {
      const c = cfg() || {};
      if (c.allowTeach === false) {
        return { content: '管理员关掉了「允许群友教新知识」，这条不收录。', isError: true };
      }
      const title = String(args?.title ?? '').trim();
      const summary = String(args?.summary ?? '').trim();
      if (!title || !summary) {
        return { content: '收录失败：title 和 summary 都要填。', isError: true };
      }

      const existing = loadKnowledge({ force: true });
      if (existing.some((e) => e.title.toLowerCase() === title.toLowerCase())) {
        return { content: `知识库里已经有「${title}」了，没有重复收录。` };
      }
      if (existing.length >= MAX_ENTRIES) {
        return { content: `知识库条目已达上限 ${MAX_ENTRIES} 条，请先整理 data/rhythm-kb/user-added.json。`, isError: true };
      }

      const current = readJson(USER_FILE);
      const list = Array.isArray(current?.entries) ? current.entries : (Array.isArray(current) ? current : []);
      list.push({
        title,
        summary,
        details: String(args?.details ?? '').trim(),
        aliases: toList(args?.aliases),
        tags: toList(args?.tags),
        category: String(args?.category ?? '').trim() || '群友补充',
        source: 'user',
        ts: Date.now()
      });

      try {
        fs.mkdirSync(USER_DIR, { recursive: true });
        fs.writeFileSync(USER_FILE, JSON.stringify({ note: '群友教的新条目；可直接编辑，格式参考 kb/basics.json', entries: list }, null, 2), 'utf8');
      } catch (error) {
        return { content: `写入失败（${error?.message ?? error}）。可以让群友改 skills/rhythm-kb/kb/ 里的 json 文件来手动添加。`, isError: true };
      }

      cache = { at: 0, entries: [] };
      return { content: `已收录「${title}」。下次被问到就会查到它，不用复述归档过程。` };
    }
  });
}

/** 技能自检：知识库读不到任何条目时明确报出来，而不是让工具静默变哑巴。
 *  注意用**带缓存**的读取：这个函数会在每次工具可用性检查时被调用（每轮多次），
 *  底稿已有数百条，强制重读全部文件是纯浪费。3 秒 TTL 足够让"修好文件"被感知到。 */
export function available() {
  const entries = loadKnowledge();
  if (!entries.length) {
    return { ok: false, reason: `音游知识库为空：请确认 ${KB_DIR} 下有 json 文件` };
  }
  return true;
}
