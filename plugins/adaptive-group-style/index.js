/**
 * adaptive-group-style —— 群风格自适应学习（确定性型插件 / 放在 plugins/）
 *
 * ── 用户的原话 ────────────────────────────────────────────────────────────
 *   「我需要做一个她能自主学习的插件，优先使用本地存档的聊天记录与搜索记录，
 *     然后聊天的语句会跟着与群友聊天的风格更新，不再是单一的回复固定词汇，
 *     尝试让人设更灵动更贴近生活。」
 *
 * ── 判定：为什么是「插件」而不是「技能」（这一条决定成败，不能搞错）──────
 * 判据（README 的扩展章节 / src/skills/manifest.js 的 DIR_KIND）：
 *   规则能写死 → 插件（plugins/）；要理解人话 → 技能（skills/）
 *
 * 三问：
 *   ① 规则能写死吗？**能。** 句长、标点频率、连发节奏、高频口头语，
 *      全都是从本地聊天记录里数出来的统计量，纯代码算得出来，不需要"理解"。
 *   ② 要不要理解人话？**不需要。** 这里一个字都不用读懂 —— 读懂了反而糟：
 *      那是模型每轮都要重新判断一遍、结果还不稳定的事。
 *   ③ 何时执行由谁定？**由核心代码定。**「每轮发言前把学到的风格放进提示词」
 *      必须是必然发生的；交给模型自己决定"这轮要不要参考风格"，它多半会忘。
 * 三条都指向确定性型 → plugins/。
 *
 * ⚠️ 反过来放（做成只 registerTool 的技能）会**静默失效**：
 *   技能的工具只有模型主动调用才生效，而"每次发言都带上风格"这件事
 *   恰恰不能指望模型记得 —— 表现就是"装了跟没装一样，不报错也没反应"。
 *
 * ── 它到底怎么让机器人"不像复读机"（机制，不是玄学）──────────────────────
 *   宿主每次运行都重发一份**静态**系统提示词（人设 + 规则，见 src/prompt.js），
 *   所以机器人平时的腔调是固定的 —— 这就是"单一、固定词汇"的来源。
 *   本插件在**每次组装提示词时**插进一段按当前群实时统计出来的说话习惯：
 *     · before-context      钩子：到点就重新统计（默认 30 分钟一次），结果进内存缓存
 *     · promptSections(ctx) 动态片段：把缓存渲染成【群聊语言风格】段，进系统提示词
 *     · before-llm-messages 钩子：再在**本次用户消息末尾**贴一小段紧凑版
 *                              （提示词里最靠近发言位置、模型最当真的地方）
 *     · after-response      钩子：记录机器人这轮真正发出去的话，和群里的习惯比对，
 *                              下一轮直接把"你偏长/你爱带句号"点名写进提示词
 *   于是同一个群越聊越像它自己，换个群又是另一套说法 —— 不再是全局一套固定腔调。
 *
 * ── 数据来源（全部本地，不联网、不调用模型、不花一分钱 token）──────────────
 *   1. 本地聊天存档（首选）：ctx.store.recent(chatKey, { limit })，即 data/messages/group_*.json
 *   2. 记忆里已存的群友印象（补充）：ctx.memory.query(chatKey).memberImpression，
 *      它本来就是模型提炼过的"长期印象"，噪音比原始聊天记录低
 *   3. 机器人自己发过的话：会话的 session.sent / 存档里 self:true 的条目
 *   刻意**没有**去读 SnowLuma 的 messages.db / 搜索记录库：
 *     · 那是另一个进程（QQ 协议端）的 SQLite，实时连着写，直读有锁风险；
 *     · 更关键的是——宿主已经在内存里维护了同一批数据的 JSON 存档，
 *       走 ctx.store 拿到的就是权威视图，跟"模型实际看到的上下文"完全一致。
 *       读数据库反而可能读到模型没看过的消息，学出来的风格对不上。
 *
 * ── v1.1 新增：夜间整理官（休息时间里的自主学习）──────────────────────────
 *   白天的 learn() 只做统计，有三件事它做不了：
 *     ① "今天整个群聊了什么"需要通读一遍再提炼 —— 统计函数只会数数；
 *     ② 语气好不好（有没有太冲）需要理解，字面统计只能给事实（几条在顶人）；
 *     ③ 群里聊的哪些是正在热的梗、怎么接才自然，需要联网对照。
 *   这三件事都放到**人设卡写的休息时间**里做（从人设文本里解析"每日 X 点到
 *   Y 点不回复"这类句子，解析不到退回默认 00:00-08:00）：
 *     · 每分钟看一次表：到点 + 空闲（90 秒没有新会话）+ 今天还没整理过 → 开工
 *     · 整理 = 读今天的记录 → 对照热榜（hot-trend-tracker 的本地榜单 + 联网补抓）
 *       → 调一次 LLM 做"语气教练"复盘 → 产出 {语气修正, 说话调整, 可接的梗}
 *     · 产出写进档案（第二天提示词里生效）+ 归档文件（data/adaptive-group-style-archive/日期.json）
 *   复盘的每一项都可以单独关（toneSoftening / memeInject / nightly）。
 *   ⚠️ v1.0"setup 里不建定时器"的规矩被 v1.1 打破了一处 —— 但补了双保险：
 *     定时器注册进 globalThis 集合，setup 时先把上一个实例残留的全清掉再建新的，
 *     deactivate/dispose 也各自清一次。热重载不会积累幽灵定时器（测试有覆盖）。
 *
 * ── 落盘的坑（都按宿主真实行为处理了，不按它写就会静默失效）────────────────
 *   · 状态文件不写死路径：优先用核心的 DATA_DIR（安装版里是 <安装目录>/data），
 *     拿不到就退回插件自己的目录。**必须在 setup 里 try/catch 动态 import**
 *     —— 顶层静态 import 一旦因为宿主升级挪了文件而抛错，整个插件变"加载失败"。
 *   · 写盘用"临时文件 + rename"，避免断电/被杀时留下半个 JSON（下次读取直接解析失败）。
 *   · 读取失败(坏文件)一律回落到空档案，绝不让坏状态把插件打成加载失败。
 *   · 钩子里的异常必须自己吞掉：hooks 由 skillManager.runHook 调用，
 *     虽然它本身有 try/catch，但我们的异常会变成"上次出错"红字显示给用户，
 *     而风格学习失败不该影响机器人正常说话。
 *   · 钩子有 5 秒硬超时（manager.js 的 DEFAULT_HOOK_TIMEOUT_MS）：
 *     所以统计量被 sampleSize 卡死（默认 400 条，纯字符串统计，毫秒级），
 *     写盘也只在内存里标脏、由下一次钩子顺手 flush —— 不在钩子里做重 IO。
 *   · 工具 id / 能力名一概不注册：本插件不提供 capability、不注册 tool，
 *     完全靠 hooks + promptSections 工作（这正是"确定性型"的标准形态）。
 *   · setup 里**不建任何定时器**：热重载会重新 setup，定时器会泄漏成幽灵行为
 *     （同一个群被统计两次、越积越多）。所有节奏都由钩子驱动、按时间戳判断。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeStyle, renderStyleHint, summarizeProfile, scanAggression, matchTrends } from './style-engine.js';

const PLUGIN_ID = 'adaptive-group-style';
const BUILD_TAG = 'v1.1.0';
const STATE_FILE = 'adaptive-group-style.json';
/** 夜间归档目录（相对数据目录）。每天一个 JSON，只存提炼结果不存原始聊天。 */
const ARCHIVE_DIR_NAME = 'adaptive-group-style-archive';

// 兜底位置：核心配置模块拿不到时，状态就写在插件目录下（宁可写在插件里，也不要丢档案）
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_STATE_PATH = path.join(HERE, STATE_FILE);

const DEFAULTS = {
  enabled: true,
  learnMinutes: 30,
  sampleSize: 400,
  adoptLevel: '贴近（推荐）',
  injectToUser: true,
  includeWords: true,
  learnFromMemory: true,
  minSample: 30,
  observeSelf: true,
  // ── v1.1 夜间整理官 ──
  nightly: true,          // 总开关：休息时间里自动整理/归档/复盘
  nightlyMaxChats: 3,     // 每晚最多做 LLM 深度复盘的群数（按当天消息量取最活跃的）
  archiveKeepDays: 30,    // 归档保留天数
  toneSoftening: true,    // 语气软化（进攻性降低）
  memeInject: true,       // 把学到的梗/流行词注入提示词
  webMatch: true,         // 联网搜索匹配（热榜对照 + Bing 查新词）
  restStart: '',          // 休息开始（"HH:MM"或"HH点"）；空 = 从人设卡文本解析
  restEnd: ''             // 休息结束；空 = 从人设卡文本解析
};

const MAX_PROFILES = 60;        // 档案表上限（防内存/磁盘无限增长）
const MAX_SELF_ROWS = 40;       // 每个群最多留多少条"机器人最近说过的话"
const COMPACT_MAX_CHARS = 300;  // 紧凑版风格提醒的长度上限（v1.0 是 200；v1.1 加了"昨天的梗/语气"一行，放宽到 300 仍很省）
const FLUSH_MIN_MS = 60_000;       // 两次落盘的最小间隔（学习结果可以等，避免每轮都写磁盘）

let cfg = () => ({});
let log = () => {};
let warn = () => {};

/** 当前状态文件路径（setup 时确定）。 */
let statePath = FALLBACK_STATE_PATH;
/** 核心 src/config.js 的 DATA_DIR（软依赖，可能取不到）。 */
let coreDataDir = '';

/** { version, profiles: { [chatKey]: {...} }, nightly: {...} } */
let state = { version: 1, profiles: {}, nightly: {} };

/** chatKey -> 已算好的风格提示词（直接进提示词，避免每次组装都重算）。 */
const cache = new Map();
/** sessionId -> { chatKey, sentSeen }：本次运行已经收走多少条机器人发言。 */
const runSent = new Map();

let dirty = false;
let lastFlushAt = 0;
let startedAt = 0;

// ───────────────────────────── v1.1 夜间整理官 · 运行态 ─────────────────────────────

let nightTimer = null;          // 每分钟看表的 setInterval
let nightRunning = false;       // 防重入（整理可能要跑几分钟）
let lastActivityAt = 0;         // 宿主最后一次处理消息的时刻（"闲时"判定）
let lastEnv = { store: null, memory: null };   // 从钩子 ctx 捕获的宿主引用（整理的数据源）

// 软依赖的宿主模块（setup 里逐个 try/catch import；缺哪个就降级对应功能，绝不加载失败）
let coreConfig = null;      // src/config.js：读人设卡文本（解析休息时间）
let coreLlm = null;         // src/llm.js：夜间复盘的 LLM 调用
let coreWebSearch = null;   // src/web-search.js：查群里的新词
let corePersonas = null;    // src/personas.js：内置人设文本（兜底解析）
let coreStoreMod = null;    // src/store.js：钩子还没来过时兜底建只读 store
let coreSafeFetch = null;   // src/safe-fetch.js：联网补抓热榜

let dataDirResolved = '';       // resolveStatePath 选定的数据目录（归档放这里）
let restWindowCache = null;     // {at, win} 休息时间解析缓存（1 小时，人设卡不会一分钟一改）
let trendCache = null;          // {at, items} 联网热榜缓存（12 小时）

// 测试注入口（经 __internals 设置；生产路径永远走真实实现）
let llmCallOverride = null;
let webLookupOverride = null;
let trendsOverride = null;

const NIGHT_TICK_MS = 60_000;        // 看表间隔
const NIGHT_IDLE_MS = 90_000;        // 宿主安静多久才算"闲时"
const NIGHT_RETRY_MS = 30 * 60_000;  // 整理失败后的重试间隔（每晚最多试 2 次）
const NIGHT_MAX_TRIES = 2;
const TREND_LIVE_TTL = 12 * 3600_000;

// ───────────────────────────── 基础设施 ─────────────────────────────

function settings() {
  const s = (typeof cfg === 'function' ? cfg() : null) || {};
  const num = (k, min, max) => {
    const n = Number(s[k]);
    if (!Number.isFinite(n)) return DEFAULTS[k];
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  const bool = (k) => (s[k] === undefined || s[k] === null ? DEFAULTS[k] : s[k] !== false);
  const str = (k) => String(s[k] ?? DEFAULTS[k] ?? '').trim();
  return {
    enabled: bool('enabled'),
    learnMinutes: num('learnMinutes', 1, 1440),
    sampleSize: num('sampleSize', 50, 2000),
    adoptLevel: String(s.adoptLevel || DEFAULTS.adoptLevel),
    injectToUser: bool('injectToUser'),
    includeWords: bool('includeWords'),
    learnFromMemory: bool('learnFromMemory'),
    minSample: num('minSample', 10, 500),
    observeSelf: bool('observeSelf'),
    // ── v1.1 ──
    nightly: bool('nightly'),
    nightlyMaxChats: num('nightlyMaxChats', 1, 8),
    archiveKeepDays: num('archiveKeepDays', 7, 365),
    toneSoftening: bool('toneSoftening'),
    memeInject: bool('memeInject'),
    webMatch: bool('webMatch'),
    restStart: str('restStart'),
    restEnd: str('restEnd')
  };
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 读状态文件。任何异常都当成"空档案"——坏文件不能把插件打成加载失败。 */
function loadState() {
  try {
    if (!fs.existsSync(statePath)) return { version: 1, profiles: {}, nightly: {} };
    const text = fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.profiles !== 'object' || !parsed.profiles) {
      warn('状态文件结构不对，已按空档案继续（文件：%s）', statePath);
      return { version: 1, profiles: {}, nightly: {} };
    }
    // ⚠️ nightly（夜间整理的当日去重/重试状态）必须随行：漏掉的话每次重启都
    //    "忘了今天整理过"，夜里反复跑 LLM 白烧 token。
    return { version: 1, profiles: parsed.profiles, nightly: (parsed.nightly && typeof parsed.nightly === 'object') ? parsed.nightly : {} };
  } catch (error) {
    warn('读状态文件失败，已按空档案继续（%s）：%s', statePath, error?.message ?? error);
    return { version: 1, profiles: {}, nightly: {} };
  }
}

/**
 * 落盘。
 * 先写临时文件再 rename —— 直接覆写时被杀进程会留下截断的 JSON，
 * 下次读取解析失败，档案全丢（而且是静默丢，界面上看不出来）。
 *
 * @param {number} minGapMs 两次写盘之间的最小间隔（防抖）。默认 FLUSH_MIN_MS。
 *   ⚠️ 这个参数存在的原因（真踩到过）：早期版本把间隔硬编码成 60 秒，
 *   于是"刚学完（写了一次）→ 紧接着记下机器人自己的发言"这第二次写会被
 *   直接吞掉，那一轮发言只活在内存里。这类"当前状态和磁盘不一致"的问题
 *   在界面上完全看不出来，只会在下次重启后表现为"记录少了"。
 *   按调用点的价值区分间隔：学习结果可以等，机器人刚说的话要立刻落。
 */
function flushState(minGapMs = FLUSH_MIN_MS) {
  if (!dirty) return;
  const now = Date.now();
  if (now - lastFlushAt < minGapMs) return;
  try {
    const entries = Object.entries(state.profiles);
    if (entries.length > MAX_PROFILES) {
      // 超出上限：删掉最久没碰过的那些群（保留最近活跃的）
      entries.sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0));
      state.profiles = Object.fromEntries(entries.slice(0, MAX_PROFILES));
    }
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, statePath);
    dirty = false;
    lastFlushAt = now;
  } catch (error) {
    // 写不进去不影响本次运行（内存里的风格照样生效），下次钩子再试
    warn('写状态文件失败（不影响本次发言）：%s', error?.message ?? error);
  }
}

/** 会话标签：把 chatKey 变成人看得懂的一小段（群名优先，没有就退回群号）。 */
function chatLabel(chatKey, chatName = '') {
  const name = String(chatName || '').trim();
  if (name) return clip(name, 20);
  return String(chatKey || '');
}

// ───────────────────────────── 收集样本 ─────────────────────────────

/** 从存档里取这个会话的最近记录（拿不到就返回空数组，绝不上抛）。 */
function readRows(store, chatKey, limit) {
  try {
    if (!store || typeof store.recent !== 'function' || !chatKey) return [];
    const rows = store.recent(String(chatKey), { limit, includeSelf: true });
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    warn('读聊天存档失败（%s）：%s', chatKey, error?.message ?? error);
    return [];
  }
}

/**
 * 取记忆里已存的群友印象。
 * 形状按 src/memory.js 的 query() 返回值处理，字段名不匹配时安静跳过
 * （记忆模块改版不该把风格学习搞崩）。
 */
function readNotes(memory, chatKey) {
  try {
    if (!memory || typeof memory.query !== 'function' || !chatKey) return [];
    const q = memory.query(String(chatKey));
    const list = Array.isArray(q?.memberImpression) ? q.memberImpression : [];
    return list
      .map((e) => String(e?.content ?? '').trim())
      .filter(Boolean)
      .slice(0, 40);
  } catch {
    return [];
  }
}

// ───────────────────────────── 学习一个群 ─────────────────────────────

/**
 * 重新统计一个会话的风格并更新缓存。
 *
 * @returns {{ok: boolean, reason?: string, profile?: object}}
 */
function learn({ chatKey, chatName = '', store, memory }, conf, { force = false } = {}) {
  const key = String(chatKey || '');
  if (!key) return { ok: false, reason: '没有会话标识' };

  const entry = state.profiles[key] || null;
  const intervalMs = conf.learnMinutes * 60_000;
  const entryProfile = entry?.profile || null;
  const fresh = entryProfile && Number(entryProfile.learnedAt || 0) > 0
    && Date.now() - Number(entryProfile.learnedAt) < intervalMs;

  // 缓存里已经有渲染好的文本 → 直接用，不必重算（这是绝大多数轮次走的路）
  if (!force && fresh && cache.has(key)) return { ok: true, profile: entryProfile, cached: true };

  const rows = readRows(store, key, conf.sampleSize * 1.5);
  const notes = conf.learnFromMemory ? readNotes(memory, key) : [];
  const profile = analyzeStyle({
    rows,
    notes,
    sampleSize: conf.sampleSize,
    minSample: conf.minSample
  });

  if (!profile) {
    // 样本不够：**保留上一次的档案**（而不是清空）。
    // 群里刚安静几小时就把学到的风格忘掉，表现就是"风格时有时无"，很难排查。
    if (entryProfile) {
      cache.set(key, renderStyleHint(entryProfile, {
        adoptLevel: conf.adoptLevel,
        includeWords: conf.includeWords,
        style: 'full',
        chatName: chatLabel(key, chatName),
        night: entry?.night,
        toneSoftening: conf.toneSoftening,
        memeInject: conf.memeInject
      }));
      return { ok: false, reason: `样本不足（需要 ${conf.minSample} 条群友消息），沿用上次学习结果`, profile: entryProfile };
    }
    cache.delete(key);
    return { ok: false, reason: `样本不足（需要 ${conf.minSample} 条群友消息）` };
  }

  // 说明：机器人的"自查"数据来自 analyzeStyle 内部（它从同一份 rows 里取最近的
  // self 条目），这里不需要再单独抽一份存起来 —— 曾经写过 selfFromStore 字段，
  // 结果既没被读、又让档案多一份会过期的副本，纯属噪音，删掉。
  const prevWords = Array.isArray(entryProfile?.words) ? entryProfile.words.length : -1;
  // ⚠️ 带上已有的 selfSent：学习会**整个替换**档案对象，漏掉这个字段的话，
  //    每重学一次就把"机器人最近说过的话"清空一次 —— "你最近偏长"这类提醒
  //    会跟着忽有忽无，很难联想到是重学把它冲掉的。
  const prevSelf = Array.isArray(entry?.selfSent) ? entry.selfSent : [];
  // ⚠️ 夜间整理的产出（entry.night）也必须随行：learn 是整档替换，
  //    漏掉这个字段的话，每次重学都把昨晚复盘的语气/梗清空一次，
  //    "夜间整理没生效"会时有时无，很难联想到是这里把它冲掉的。
  const prevNight = entry?.night || null;
  const nextEntry = {
    chatKey: key,
    name: chatLabel(key, chatName),
    at: Date.now(),
    profile,
    samples: profile.group.sampleSize,
    notes: notes.length,
    selfSent: prevSelf.slice(-MAX_SELF_ROWS),
    night: prevNight
  };
  state.profiles[key] = nextEntry;
  dirty = true;
  flushState();

  cache.set(key, renderStyleHint(profile, {
    adoptLevel: conf.adoptLevel,
    includeWords: conf.includeWords,
    style: 'full',
    chatName: chatLabel(key, chatName),
    night: prevNight,
    toneSoftening: conf.toneSoftening,
    memeInject: conf.memeInject
  }));

  const wordsMsg = prevWords >= 0 && Math.abs(profile.words.length - prevWords) >= 4
    ? `，口头语表变化较大（${prevWords} → ${profile.words.length} 个）`
    : '';
  log('学到「%s」的风格：%s%s', chatLabel(key, chatName), summarizeProfile(profile), wordsMsg);
  return { ok: true, profile };
}

// ───────────────────────────── 机器人自己的发言 ─────────────────────────────

/**
 * 收走本次运行里机器人**真正发出去**的话。
 *
 * 数据源是 session.sent（src/tools.js 里 send_message / send_sticker / 转发 都会 push）
 * —— 它是"确实发出去了"的唯一权威记录：模型写在正文里但没调工具的话**不会**在这里，
 * 这正是我们要的（正文不会发到 QQ，不该拿来当风格样本）。
 *
 * 每轮都会带上本轮之前已经记过的内容，所以用 sentSeen 计数去重。
 *
 * ⚠️ 记账表按 sessionId 存（不是按 chatKey）——但**不能**拿它来否决写入：
 *    同一次运行里 chatKey 是宿主显式传给钩子的（比我们自己记的可靠），
 *    早期版本用"记下来的 chatKey 不一致就丢弃"做保护，结果是第一次记账时
 *    表项刚建好、chatKey 还是空串，就把这一批发言全丢了（自测里表现为
 *    "记下了 0 条"）。宁可少一层猜测，也不要丢掉真实发言。
 */
function collectSelfSent(session, chatKey) {
  try {
    const list = Array.isArray(session?.sent) ? session.sent : [];
    const sid = String(session?.id || '');
    let st = sid ? runSent.get(sid) : null;
    if (!st) { st = { chatKey: String(chatKey || ''), sentSeen: 0 }; if (sid) runSent.set(sid, st); }
    if (chatKey) st.chatKey = String(chatKey);
    const fresh = list.slice(st.sentSeen);
    st.sentSeen = list.length;
    const texts = [];
    for (const item of fresh) {
      if (!item) continue;
      const t = String(item.text ?? '').trim();
      if (!t) continue;
      if (/^\[表情包:/.test(t)) continue;   // 表情包不是"说法"，不参与语言风格比对
      texts.push(clip(t, 80));
    }
    // 记账表别无限长：会话结束后没人清，超过上限就丢掉最老的
    if (runSent.size > 300) {
      for (const k of [...runSent.keys()].slice(0, 100)) runSent.delete(k);
    }
    return texts;
  } catch {
    return [];
  }
}

/** 把机器人刚说的话记进档案（供下一轮的"需要你改的地方"使用）。 */
function rememberSelf(chatKey, texts) {
  const key = String(chatKey || '');
  if (!key || !texts.length) return;
  const entry = state.profiles[key];
  if (!entry) return;   // 还没学过这个群 → 先不记（等有档案了再算，避免拿几条样本瞎判断）
  const keep = Array.isArray(entry.selfSent) ? entry.selfSent : [];
  for (const t of texts) keep.push({ text: t, ts: Date.now() });
  entry.selfSent = keep.slice(-MAX_SELF_ROWS);
  entry.at = Date.now();
  dirty = true;
  // ⚠️ 必须在这里**立刻落盘**（间隔传 0，不走防抖）：
  //    早期版本两处都错过 —— 先是只标 dirty、指望"下次学习时顺手写"（学习是到点才做的，
  //    默认 30 分钟一次）；改成调用 flushState 之后又被防抖间隔吞掉，
  //    因为"学习"和"记下自己刚说的话"往往只隔几毫秒（同一个群里前后两轮）。
  //    结果是这些发言只活在内存里，热重载/重启就丢，"你最近爱带句号"这类提醒
  //    永远建立在旧数据上。集成自测就是这么把它抓出来的。
  //    调用方（after-response）已按 sentSeen 去重，每轮最多写一次，不会形成写入风暴。
  flushState(0);
}

/**
 * 定状态文件放在哪。
 *
 * 这个坑值得写清楚：宿主的 src/config.js 里 `DATA_DIR = process.env.QQ_AGENT_DATA_DIR
 * || path.join(ROOT, 'data')`，而 ROOT = <…>/resources/app。开发模式下那就是
 * <项目根>/data，没问题；但**安装版**里业务数据实际在 <安装目录>/data
 * （electron/main.js 的 resolveDataDir 用 exe 所在目录推导），此时
 * `QQ_AGENT_DATA_DIR` 环境变量才是权威值。
 * 只信 config.DATA_DIR 会把状态写到 resources/app/data 这个"看起来对、其实是另一个地方"
 * 的目录里 —— 界面上一切正常，用户却在自己的 data 目录里找不到文件。
 * 所以：承认两个来源，**挑磁盘上真实存在的那一个**，都拿不到才退回插件目录。
 */
function resolveStatePath() {
  const appRoot = path.resolve(HERE, '..', '..');
  const candidates = [
    String(coreDataDir || ''),                       // 核心模块算出来的 DATA_DIR
    String(process.env.QQ_AGENT_DATA_DIR || ''),     // Electron 主进程注入的真实数据目录
    path.join(appRoot, 'data'),                      // 开发模式
    path.join(appRoot, 'data-2')                     // 第二实例
  ].filter((d) => d && d.trim());
  for (const dir of candidates) {
    try { if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) { dataDirResolved = dir; return path.join(dir, STATE_FILE); } } catch { /* 试下一个 */ }
  }
  dataDirResolved = candidates.length ? candidates[0] : path.dirname(FALLBACK_STATE_PATH);
  return candidates.length ? path.join(candidates[0], STATE_FILE) : FALLBACK_STATE_PATH;
}

/** 夜间归档等派生文件的位置（跟着状态文件走，保证读写的是同一份数据目录）。 */
function dataDir() {
  return dataDirResolved || path.dirname(statePath);
}

// ───────────────────────────── v1.1 夜间整理官 ─────────────────────────────
//
// 设计取舍（为什么这么绕）：
//   · 休息时间从**人设卡文本**解析，而不是让用户再填一遍 —— 用户在卡片里写了
//     "每日 24:00 到次日 8:00 不回复任何消息"，插件就该自己读懂它；
//     插件设置里仍留 restStart/restEnd 作为显式覆盖（解析不准时的逃生门）。
//   · "联网搜索匹配"分两层：本地已缓存的每日热榜（hot-trend-tracker 维护的
//     data/hot-trends.json，贴吧带简介最好用）+ 联网补抓（B站热搜/抖音热榜，
//     实测 keyless 可用）+ Bing 查群里认识的新词。全部 best-effort，断了不挡整理。
//   · LLM 只做"教练"：事实（几条在顶人、哪些词对上热榜）由纯代码统计，LLM 在
//     事实之上给"怎么改"。LLM 输出必须是 JSON，解析失败退回确定性复盘 ——
//     夜间任务不能因为一次模型抽风就整晚空手而归。
//   · 白天 learn() 学统计口径，夜里 runNightly 学语气和梗，两者写进**同一个**
//     档案但互不覆盖（learn 管 profile，nightly 管 night 字段）。

/** 机器人今天说过的话里的进攻性扫描、热榜匹配（实现在 style-engine，纯函数）。 */

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayStart(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function nowMinutes(ts = Date.now()) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

function fmtMin(min) {
  const m = ((Number(min) || 0) % 1440 + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// 只在含这些词的句子里找时间段 —— 避免"昨晚 8 点的事"被当成作息。
const REST_LINE_RE = /(休息|睡觉|睡眠|不回复|不回消息|晚安|作息|免打扰)/;
// "每日 24:00 到次日 8:00" / "晚上11点到早上7点" / "23:30-07:30"
// ⚠️ 时间单位字（点/时）必须**总能被消费掉**：写成 `[:：点时](\d{1,2})` 时，
//    "11点**到**"（点后没数字）会让可选组整体回退、点字留在流里，
//    分隔符到不了"到"，整条正则失配 → 人设卡解析永远 null（静默失效）。
//    现在的写法允许"点"后面不跟数字（"11点到早上7点"是最高频的写法）。
const REST_WINDOW_RE = /(晚上|夜里|深夜|每晚|早上|上午|凌晨)?\s*(\d{1,2})(?:\s*[:：点时]\s*(?:(\d{1,2})\s*分?|半)?)?\s*(?:到|至|—|–|~|～|-)+\s*(次日|第二[天日]|早上|上午|凌晨)?\s*(\d{1,2})(?:\s*[:：点时]\s*(?:(\d{1,2})\s*分?|半)?)?/;

function parseClock(hRaw, mRaw, prefix = '') {
  let h = Math.trunc(Number(hRaw));
  const m = Math.trunc(Number(mRaw)) || 0;
  if (!Number.isFinite(h) || h < 0 || h > 24) return -1;
  if (/晚上|夜里|深夜|每晚/.test(String(prefix || '')) && h < 12) h += 12;
  if (h >= 24) h -= 24;   // "24:00" 就是 0:00（人设卡里常见这种写法）
  if (m < 0 || m > 59) return -1;
  return h * 60 + m;
}

/** 从一段人设文本里解析休息时间窗；解析不到返回 null（调用方走下一份文本/默认值）。 */
function parseRestWindowFromText(text) {
  for (let rawLine of String(text || '').split(/\n|。|；|;/)) {
    let line = String(rawLine || '').trim();
    if (!line || !REST_LINE_RE.test(line)) continue;
    // "11点半" 先归一成 "11点30分"，正则里就不用单独处理"半"了
    line = line.replace(/(\d{1,2})\s*点半/g, '$1点30分');
    const m = REST_WINDOW_RE.exec(line);
    if (!m) continue;
    const startMin = parseClock(m[2], m[3], m[1]);
    const endMin = parseClock(m[5], m[6], m[4]);
    if (startMin < 0 || endMin < 0 || startMin === endMin) continue;
    return { startMin, endMin, line: clip(line, 60) };
  }
  return null;
}

/** 判断某时刻（分钟数）是否落在休息窗内（支持跨午夜）。 */
function inRestWindow(minOfDay, win) {
  if (!win) return false;
  const { startMin, endMin } = win;
  if (startMin === endMin) return false;
  if (startMin < endMin) return minOfDay >= startMin && minOfDay < endMin;
  return minOfDay >= startMin || minOfDay < endMin;
}

/** 所有可解析的人设文本：全局人设 → 自定义人设卡 → 内置模板（按优先级）。 */
function personaTexts() {
  const out = [];
  try { const t = coreConfig?.getConfig?.()?.persona?.roleText; if (t) out.push(String(t)); } catch { /* ignore */ }
  try {
    const cps = coreConfig?.getConfig?.()?.customPersonas;
    if (Array.isArray(cps)) for (const p of cps) if (p?.roleText) out.push(String(p.roleText));
  } catch { /* ignore */ }
  try {
    if (corePersonas?.PERSONAS) for (const p of Object.values(corePersonas.PERSONAS)) if (p?.text) out.push(String(p.text));
  } catch { /* ignore */ }
  return out;
}

function parseHm(s) {
  const m = /^(\d{1,2})\s*[:：点时]\s*(\d{1,2})?$/.exec(String(s || '').trim());
  if (!m) return -1;
  return parseClock(m[1], m[2], '');
}

/**
 * 休息时间窗：插件设置显式给了就用设置；否则逐份人设卡文本解析（第一份解析成功的算数）；
 * 全都没有就退回默认 00:00-08:00（与常见作息一致）。结果缓存 1 小时。
 */
function resolveRestWindow(conf = settings()) {
  // 显式覆盖（插件设置里的 restStart/restEnd）不走缓存：用户刚在界面上改完时间，
  // 下一分钟的 tick 就该按新时间来，缓存反而会把旧窗口多留一小时。
  if (!conf.restStart || !conf.restEnd) {
    if (restWindowCache && Date.now() - restWindowCache.at < 3600_000) return restWindowCache.win;
  }
  let win = null;
  let source = '';
  if (conf.restStart && conf.restEnd) {
    const a = parseHm(conf.restStart);
    const b = parseHm(conf.restEnd);
    if (a >= 0 && b >= 0 && a !== b) { win = { startMin: a, endMin: b }; source = '插件设置'; }
  }
  if (!win) {
    for (const text of personaTexts()) {
      const found = parseRestWindowFromText(text);
      if (found) { win = { startMin: found.startMin, endMin: found.endMin }; source = `人设卡「${found.line}」`; break; }
    }
  }
  if (!win) { win = { startMin: 0, endMin: 8 * 60 }; source = '默认'; }
  const out = { ...win, source, label: `${fmtMin(win.startMin)}-${fmtMin(win.endMin)}（${source}）` };
  if (!(conf.restStart && conf.restEnd)) restWindowCache = { at: Date.now(), win: out };
  return out;
}

/** 钩子还没来过（启动后没人说话）时的兜底数据源：自建只读 ChatStore。 */
function fallbackStore() {
  try {
    if (!coreStoreMod?.ChatStore) return null;
    const inst = new coreStoreMod.ChatStore();
    return typeof inst.listChats === 'function' ? inst : null;
  } catch { return null; }
}

// ── 热榜（联网匹配的"联网"半边）───────────────────────────────────────────

/** hot-trend-tracker 插件维护的本地榜单（每天 6 点抓：贴吧热议/B站/百度）。 */
function loadLocalTrends() {
  try {
    const file = path.join(dataDir(), 'hot-trends.json');
    if (!fs.existsSync(file)) return { items: [], at: 0 };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const topics = Array.isArray(parsed?.topics) ? parsed.topics : [];
    const items = topics
      .filter((t) => t && (t.key || t.title))
      .map((t) => ({ key: String(t.key || t.title), title: String(t.title || t.key), desc: String(t.desc || ''), sources: Array.isArray(t.sources) && t.sources.length ? t.sources : ['local'] }));
    return { items, at: Number(parsed?.lastCollectedAt || 0) };
  } catch { return { items: [], at: 0 }; }
}

/** 联网补抓（best-effort，12 小时缓存）：B站热搜 + 抖音热榜，实测都 keyless 可用。 */
async function fetchLiveTrends() {
  if (trendsOverride) return trendsOverride;
  if (trendCache && Date.now() - trendCache.at < TREND_LIVE_TTL) return trendCache.items;
  const items = [];
  const UA2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  try {
    const r = await coreSafeFetch.safeFetch('https://api.bilibili.com/x/web-interface/search/square?limit=10', {
      headers: { 'User-Agent': UA2, Referer: 'https://www.bilibili.com/' }, timeoutMs: 12000, maxBytes: 300_000
    });
    const list = JSON.parse(String(r.body || ''))?.data?.trending?.list || [];
    for (const it of list) if (it?.keyword) items.push({ key: String(it.keyword), title: String(it.show_name || it.keyword), desc: '', sources: ['bilibili'] });
  } catch { /* 断网/改版就跳过，本地榜单还在 */ }
  try {
    const r = await coreSafeFetch.safeFetch('https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1&source=6&pc_client_type=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=120.0.0.0', {
      headers: { 'User-Agent': UA2, Referer: 'https://www.douyin.com/' }, timeoutMs: 12000, maxBytes: 300_000
    });
    const list = JSON.parse(String(r.body || ''))?.data?.word_list || [];
    for (const it of list) if (it?.word) items.push({ key: String(it.word), title: String(it.word), desc: '', sources: ['douyin'] });
  } catch { /* 同上 */ }
  trendCache = { at: Date.now(), items };
  return items;
}

/** 热榜汇总：本地榜新鲜（26h 内）就用本地的；否则补抓联网榜单；合并去重。 */
async function loadTrends() {
  if (trendsOverride) return trendsOverride;
  const local = loadLocalTrends();
  const localFresh = local.items.length >= 10 && local.at > 0 && (Date.now() - local.at) < 26 * 3600_000;
  let items = local.items;
  if (!localFresh) {
    const live = await fetchLiveTrends();
    if (live.length) {
      const seen = new Set(items.map((t) => t.key));
      for (const t of live) if (!seen.has(t.key)) { items = items.concat([t]); seen.add(t.key); }
    }
  }
  return items.slice(0, 400);
}

/** 用 Bing 查一个群里的新词（"xx 梗 是什么意思"）。失败返回错误占位，不抛。 */
async function webLookup(word) {
  if (webLookupOverride) return webLookupOverride(word);
  if (!coreWebSearch?.webSearch) return { word, error: '搜索模块不可用' };
  try {
    const r = await coreWebSearch.webSearch(`${word} 梗 是什么意思`);
    const results = (Array.isArray(r?.results) ? r.results : []).slice(0, 3)
      .map((x) => ({ title: clip(x?.title, 40), snippet: clip(x?.snippet, 80) }));
    if (!results.length) return { word, error: '没搜到结果' };
    return { word, results };
  } catch (e) {
    return { word, error: clip(String(e?.message ?? e), 60) };
  }
}

// ── LLM 复盘 ──────────────────────────────────────────────────────────────

const NIGHTLY_SYSTEM = [
  '你是一个 QQ 群机器人的"夜间语气教练"。下面是机器人今天在某个群里的复盘材料：统计数据、对话抽样、它自己说过的话、热榜对照。',
  '你的任务：总结今天群里聊了什么，评估机器人的语气（对照群里活人的感觉：太冲、太规整、太客服、太刻意都算问题），给出明天可执行的调整，并挑出值得接的梗。',
  '',
  '只输出一个 JSON 对象，不要解释、不要代码块围栏，字段固定为：',
  '{"digest":"今天这个群主要聊了什么（≤60字，口语）","tone":"对照群友，机器人今天的语气有什么问题（≤60字；确实没有就写\'自然\'）","toneNote":"给机器人明天的一条具体语气要求（≤40字，要可执行，如\'被怼先接梗，不连续顶两轮\'）","tips":["明天说话方式的具体调整，每条≤28字，最多3条，要具体，不要\'更自然一点\'这种空话"],"memes":[{"word":"值得接的梗或流行词","how":"怎么接才自然（≤22字）"}],"aggressiveScore":0到10的整数（10=攻击性最强）}',
  '',
  '硬性要求：',
  '- 语气调整方向是"进攻性更低、更像活人"：不贬低人、不连续顶人、不阴阳怪气；被怼优先接梗或软软带过。',
  '- memes 只收材料里真实出现过的词（热榜对照里命中的、或群里反复出现的），最多 3 个；没有合适的就给空数组，不要编。',
  '- tips 必须针对材料里的具体问题，一条一个动作。'
].join('\n');

/** 夜间 LLM 调用（可被测试桩替换）。 */
async function nightlyLlmCall(payload) {
  if (llmCallOverride) return llmCallOverride(payload);
  if (!coreLlm?.chatCompletion) throw new Error('LLM 模块不可用');
  const res = await coreLlm.chatCompletion({
    messages: [
      { role: 'system', content: NIGHTLY_SYSTEM },
      { role: 'user', content: payload }
    ],
    temperature: 0.4,
    maxTokens: 900,
    // thinkingMode:'off'：裁判/复盘类调用不思考（核心 llm 原生支持，且 reply-economy
    // 看到这个标记会整段让路，不会把 max_tokens 压小导致 JSON 截断）。
    skillContext: { thinkingMode: 'off', sessionId: '', source: `${PLUGIN_ID}.nightly` }
  });
  const text = String(res?.message?.content || '').trim();
  if (!text) throw new Error('模型返回空');
  return text;
}

/** 宽容解析 LLM 输出的 JSON（剥代码围栏、截取首尾大括号、逐字段清洗）。 */
function parseNightlyJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let obj;
  try { obj = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const memes = (Array.isArray(obj.memes) ? obj.memes : [])
    .map((m) => ({ word: clip(m?.word, 14), how: clip(m?.how, 22) }))
    .filter((m) => m.word)
    .slice(0, 3);
  const tips = (Array.isArray(obj.tips) ? obj.tips : [])
    .map((t) => clip(typeof t === 'string' ? t : '', 34))
    .filter(Boolean)
    .slice(0, 3);
  const score = Number(obj.aggressiveScore);
  return {
    digest: clip(obj.digest, 80),
    tone: clip(obj.tone, 60),
    toneNote: clip(obj.toneNote, 60),
    tips,
    memes,
    aggressiveScore: Number.isFinite(score) ? Math.max(0, Math.min(10, Math.round(score))) : null,
    source: 'llm'
  };
}

/** LLM 不可用/解析失败时的确定性复盘：事实来自纯统计，"怎么改"按固定规则给。 */
function fallbackNight({ aggr, matches, profile }) {
  const tips = [];
  if (aggr && aggr.level !== 'low') tips.push('被怼先接梗，不连续顶人两轮以上');
  if (profile?.self?.issues?.length) for (const it of profile.self.issues) tips.push(clip(it, 30));
  if (!tips.length) tips.push('保持今天的语气，可以更松弛：短句、碎片、少完整句');
  const toneNote = aggr && aggr.level !== 'low'
    ? `今晚有 ${aggr.hits} 条消息在顶人${aggr.examples.length ? `（如「${aggr.examples[0]}」）` : ''}。明天少抬杠，先接梗再说理。`
    : '今晚语气克制。明天可以更松弛一点，像群里的人一样说半句也行。';
  return {
    digest: '', tone: '', toneNote,
    tips: tips.slice(0, 3),
    memes: matches.slice(0, 2).map((m) => ({ word: m.word, how: '对上语境自然带一句，别解释' })),
    source: 'fallback'
  };
}

/** 均匀抽样：从一天的消息里抽 n 条铺满全天（比"只看最后 12 条"更能代表一整天）。 */
function spreadSample(rows, n) {
  if (rows.length <= n) return rows;
  const step = rows.length / n;
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(rows[Math.min(rows.length - 1, Math.floor(i * step))]);
  return out;
}

/** 组装给语气教练的复盘材料（纯文本；群友内容只进抽样，不导出原始记录）。 */
function buildNightlyPayload({ name, chatKey, rows, humanCount, profile, selfTexts, matches, webInfo, aggr }) {
  const lines = [];
  lines.push(`【群】${name}（${chatKey}）`);
  const g = profile?.group;
  lines.push(`【今天】群友消息 ${humanCount} 条；机器人发了 ${selfTexts.length} 条${g ? `；机器人平均每条 ${g.meanChars} 字（群里平均 ${g.meanChars} 字上下）` : ''}`);
  const words = (profile?.words || []).map((w) => w.token).filter(Boolean).slice(0, 10);
  if (words.length) lines.push(`【群里今天的高频词】${words.join('、')}`);
  const sorted = [...rows].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const sample = spreadSample(sorted.filter((m) => String(m.text || '').trim() && !m.isPoke), 12);
  if (sample.length) {
    lines.push('【今天的对话抽样】（[时间] 谁：内容；"我"=机器人）');
    for (const m of sample) {
      const d = new Date(Number(m.ts) || 0);
      const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const who = m.self ? '我' : clip(m.senderName || '群友', 10);
      lines.push(`[${hh}] ${who}：${clip(String(m.text), 36)}`);
    }
  }
  if (selfTexts.length) {
    lines.push('【机器人今天说过的话】（评估语气用，最多 12 条）');
    for (const t of selfTexts.slice(-12)) lines.push(`- ${clip(t, 40)}`);
  }
  if (aggr && aggr.hits) {
    lines.push(`【语气事实】今天 ${aggr.hits}/${aggr.n} 条消息检测到进攻性用语${aggr.examples.length ? `，例如「${aggr.examples.join('」「')}」` : ''}`);
  }
  if (matches.length) {
    lines.push('【热榜对照】今天群里聊到的、正在网上热的（词｜出处｜出现次数）：');
    for (const m of matches) lines.push(`- ${m.word}｜${m.from}｜${m.count} 次${m.desc ? `｜${m.desc}` : ''}`);
  }
  if (webInfo.length) {
    lines.push('【联网查证】群里出现但热榜没对上的词：');
    for (const w of webInfo) {
      lines.push(w.error
        ? `- ${w.word}：查询失败（${w.error}）`
        : `- ${w.word}：${(w.results || []).map((r) => clip(r.title, 30)).join(' / ')}`);
    }
  }
  lines.push('请按系统指令只输出 JSON。');
  return lines.join('\n');
}

// ── 归档 ──────────────────────────────────────────────────────────────────

/**
 * 写当天归档 + 清理过期归档。
 * 只存提炼结果（digest/语气/梗/匹配），不存群友的原始聊天 —— 原始记录本来就在
 * data/messages/ 里，归档的价值是"这一天的学习成果"，不是第二份聊天记录。
 */
function writeArchive({ day, win, chats, trends, llmOk, llmFail, ms, keepDays }) {
  try {
    const dir = path.join(dataDir(), ARCHIVE_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${day}.json`);
    const payload = {
      version: 1,
      day,
      at: Date.now(),
      restWindow: { label: win?.label || '', source: win?.source || '' },
      summary: `整理 ${chats.length} 个群；LLM 成功 ${llmOk} / 失败 ${llmFail}；热榜 ${trends} 条；耗时 ${(ms / 1000).toFixed(1)}s`,
      chats
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    // 过期归档清理（顺手的，失败不影响本次）
    try {
      const cutoff = Date.now() - Math.max(7, Number(keepDays) || 30) * 86_400_000;
      for (const f of fs.readdirSync(dir)) {
        const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
        if (!m) continue;
        const t = new Date(`${m[1]}T00:00:00`).getTime();
        if (Number.isFinite(t) && t < cutoff) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
      }
    } catch { /* ignore */ }
  } catch (e) {
    warn('写夜间归档失败（不影响学习本身）：%s', e?.message ?? e);
  }
}

function scheduleNightRetry(nst, why) {
  nst.tries = Number(nst.tries || 0) + 1;
  if (nst.tries >= NIGHT_MAX_TRIES) {
    // 今晚放弃：把 lastDay 置上，防止整夜每分钟空转重试
    nst.lastDay = dayKey();
    nst.at = Date.now();
    nst.nextTryAt = 0;
    nst.report = `放弃：${why}（已重试 ${nst.tries} 次）`;
    log('夜间整理放弃：%s', why);
  } else {
    nst.nextTryAt = Date.now() + NIGHT_RETRY_MS;
    nst.report = `待重试：${why}`;
  }
  dirty = true;
  flushState(0);
}

// ── 主流程 ────────────────────────────────────────────────────────────────

/**
 * 夜间整理（在休息时间的闲时执行）：
 *   选今天最活跃的群 → 对照热榜 → 逐群 LLM 复盘 → 写档案/归档 → 第二天生效。
 *
 * @param {{force?: boolean, reason?: string}} opts force=true 跳过时间窗/闲时/当日去重
 *        （测试与手动补跑用），但**不**跳过总开关。
 */
async function runNightly({ force = false, reason = 'timer' } = {}) {
  if (nightRunning) return { ok: false, skipped: '上一轮还没跑完' };
  const conf = settings();
  if (!conf.enabled) return { ok: false, skipped: '学习总开关未启用' };
  if (!conf.nightly && !force) return { ok: false, skipped: '夜间整理未启用' };
  const win = resolveRestWindow(conf);
  if (!force && !inRestWindow(nowMinutes(), win)) return { ok: false, skipped: `不在休息时间（${win.label}）` };
  const day = dayKey();
  const nst = state.nightly || (state.nightly = {});
  if (!force) {
    if (nst.lastDay === day) return { ok: false, skipped: '今天已经整理过' };
    if (Number(nst.nextTryAt || 0) > Date.now()) return { ok: false, skipped: '等待重试' };
    if (Date.now() - lastActivityAt < NIGHT_IDLE_MS) return { ok: false, skipped: '宿主还在忙，先让路' };
  }
  const store = lastEnv.store || fallbackStore();
  if (!store || typeof store.listChats !== 'function' || typeof store.recent !== 'function') {
    scheduleNightRetry(nst, '拿不到聊天存档（宿主还没处理过消息）');
    return { ok: false, skipped: 'store 不可用' };
  }

  nightRunning = true;
  const t0 = Date.now();
  try {
    // ① 选今天的活跃群（≥15 条群友消息），按活跃度取前 N
    const startTs = dayStart();
    const candidates = [];
    for (const key of store.listChats()) {
      if (!/^(group|private):/.test(String(key))) continue;
      const rows = readRows(store, key, 1500);
      const todayRows = rows.filter((m) => Number(m?.ts || 0) >= startTs);
      const human = todayRows.filter((m) => !m.self && !m.isPoke);
      if (human.length < 15) continue;
      candidates.push({ chatKey: key, rows: todayRows, human: human.length });
    }
    candidates.sort((a, b) => b.human - a.human);
    const workset = candidates.slice(0, conf.nightlyMaxChats);
    if (!workset.length) {
      nst.lastDay = day;
      nst.at = Date.now();
      nst.tries = 0;
      nst.nextTryAt = 0;
      nst.report = '今天没有活跃群（每群群友消息都少于 15 条），无需整理';
      dirty = true;
      flushState(0);
      log('夜间整理：今天没有活跃群，跳过（不归档）。');
      return { ok: true, chats: 0 };
    }

    // ② 热榜（本地榜单 + 联网补抓）+ 每晚限量的新词查证
    const trends = conf.webMatch ? await loadTrends() : [];
    let webBudget = 2;

    // ③ 逐群复盘
    const archiveChats = [];
    let llmOk = 0;
    let llmFail = 0;
    for (const c of workset) {
      const entry = state.profiles[c.chatKey] || null;
      const name = entry?.name || c.chatKey;
      const selfTexts = c.rows.filter((m) => m.self).map((m) => String(m.text || '')).filter(Boolean);
      const aggr = conf.toneSoftening ? scanAggression(selfTexts) : null;
      const matches = trends.length ? matchTrends(trends, c.rows, { limit: 8 }) : [];
      const profile = analyzeStyle({ rows: c.rows, notes: [], sampleSize: 400, minSample: 8 });

      const webInfo = [];
      if (conf.webMatch && webBudget > 0 && profile?.words?.length) {
        const known = new Set(matches.map((m) => m.word));
        for (const w of profile.words) {
          if (webBudget <= 0) break;
          if (known.has(w.token)) continue;
          if (trends.some((t) => String(t.title || '').includes(w.token) || t.key === w.token)) continue;
          const info = await webLookup(w.token);
          if (info) { webInfo.push(info); webBudget -= 1; }
        }
      }

      const payload = buildNightlyPayload({ name, chatKey: c.chatKey, rows: c.rows, humanCount: c.human, profile, selfTexts, matches, webInfo, aggr });
      let night = null;
      let llmError = '';
      try {
        const raw = await nightlyLlmCall(payload);
        const parsed = parseNightlyJson(raw);
        if (!parsed) throw new Error('输出不是合法 JSON');
        // 梗防幻觉：只保留材料里真实出现过的词
        const hay = payload;
        if (parsed.memes.length) {
          parsed.memes = parsed.memes.filter((m) => hay.includes(m.word) || matches.some((x) => x.word === m.word));
        }
        night = parsed;
        llmOk += 1;
      } catch (e) {
        llmFail += 1;
        llmError = clip(String(e?.message ?? e), 80);
        night = fallbackNight({ aggr, matches, profile });
      }

      night.at = Date.now();
      night.day = day;
      night.aggr = aggr ? { hits: aggr.hits, hard: aggr.hard, ratio: aggr.ratio, level: aggr.level } : null;
      night.hotMatches = matches.map((m) => ({ word: m.word, from: m.from, count: m.count }));
      night.web = webInfo.map((w) => ({ word: w.word, error: w.error || undefined }));
      night.llmError = llmError || undefined;

      // 写进档案（nightly 只管 night 字段，learn() 的 profile 原样保留 —— 互不覆盖）
      const ent = entry || { chatKey: c.chatKey, name, at: 0, profile: null, samples: 0, notes: 0, selfSent: [] };
      ent.night = night;
      ent.at = Date.now();
      state.profiles[c.chatKey] = ent;
      dirty = true;
      if (ent.profile) {
        cache.set(c.chatKey, renderStyleHint(ent.profile, {
          adoptLevel: conf.adoptLevel,
          includeWords: conf.includeWords,
          style: 'full',
          chatName: name,
          night: ent.night,
          toneSoftening: conf.toneSoftening,
          memeInject: conf.memeInject
        }));
      }
      archiveChats.push({
        chatKey: c.chatKey,
        name,
        messages: c.human,
        selfMessages: selfTexts.length,
        digest: night.digest || '',
        tone: night.tone || '',
        toneNote: night.toneNote || '',
        tips: night.tips || [],
        memes: night.memes || [],
        aggressive: night.aggr ? { hits: night.aggr.hits, hard: night.aggr.hard, level: night.aggr.level } : null,
        hotMatches: night.hotMatches || [],
        web: night.web || [],
        llmOk: !llmError
      });
    }

    // ④ 收尾：LLM 全挂了就不算完成（半小时后重试），否则落盘 + 归档
    const ms = Date.now() - t0;
    if (llmOk === 0 && llmFail > 0 && !force) {
      scheduleNightRetry(nst, `LLM 全部失败（${llmFail} 个群）`);
      return { ok: false, error: 'llm-failed', chats: workset.length };
    }
    nst.lastDay = day;
    nst.at = Date.now();
    nst.tries = 0;
    nst.nextTryAt = 0;
    nst.report = `整理 ${archiveChats.length} 个群，LLM 成功 ${llmOk} / 失败 ${llmFail}，热榜 ${trends.length} 条，耗时 ${(ms / 1000).toFixed(1)}s`;
    nst.chatKeys = archiveChats.map((c) => c.chatKey);
    writeArchive({ day, win, chats: archiveChats, trends: trends.length, llmOk, llmFail, ms, keepDays: conf.archiveKeepDays });
    flushState(0);
    log('夜间整理完成：%s。归档：%s/%s.json', nst.report, ARCHIVE_DIR_NAME, day);
    return { ok: true, chats: archiveChats.length, llmOk, llmFail, report: nst.report };
  } finally {
    nightRunning = false;
  }
}

// ── 定时器（v1.1 唯一的定时器，带防泄漏双保险）────────────────────────────

function tickNightly() {
  if (nightRunning) return;
  runNightly({ reason: 'timer' }).catch((e) => warn('夜间整理异常：%s', e?.message ?? e));
}

function startNightTimer() {
  stopNightTimer();   // 重复 setup 保护
  nightTimer = setInterval(tickNightly, NIGHT_TICK_MS);
  if (typeof nightTimer.unref === 'function') nightTimer.unref();   // 不该挡着进程退出
  // 双保险：注册进 globalThis。热重载会创建新的模块实例，旧实例的 deactivate
  // 万一没被调用（加载器行为变化/异常路径），新实例 setup 时把**旧实例残留的**
  // 定时器一并清掉 —— 只清别人的、保留自己的。
  try {
    const g = globalThis;
    const old = g.__agsNightlyTimers instanceof Set ? g.__agsNightlyTimers : new Set();
    for (const t of old) {
      if (t !== nightTimer) { try { clearInterval(t); } catch { /* ignore */ } }
    }
    g.__agsNightlyTimers = new Set([nightTimer]);
  } catch { /* ignore */ }
}

function stopNightTimer() {
  // ⚠️ 只停**自己的**定时器：热重载时新旧实例短暂共存，旧实例的 deactivate
  //    若把 globalThis 集合里的全清掉，就会误杀新实例刚启动的定时器
  //    （夜间整理从此静默失效，界面上毫无提示）。
  if (nightTimer) {
    try { clearInterval(nightTimer); } catch { /* ignore */ }
    try { globalThis.__agsNightlyTimers?.delete(nightTimer); } catch { /* ignore */ }
    nightTimer = null;
  }
}

// ───────────────────────────── 生命周期 ─────────────────────────────

export async function setup(api) {
  cfg = typeof api?.config === 'function' ? api.config : () => ({});
  log = typeof api?.log === 'function' ? api.log : () => {};
  warn = typeof api?.warn === 'function' ? api.warn : log;
  startedAt = Date.now();
  lastActivityAt = Date.now();   // 启动瞬间算"刚忙过"，避免开机第一分钟就抢跑夜间任务

  // 核心配置模块是**软依赖**：取不到就用插件目录兜底，绝不让 import 失败变砖。
  try {
    const mod = await import('../../src/config.js');
    coreDataDir = typeof mod?.DATA_DIR === 'string' && mod.DATA_DIR.trim() ? mod.DATA_DIR : '';
  } catch {
    coreDataDir = '';
  }
  statePath = resolveStatePath();

  // v1.1 夜间整理的软依赖：逐个 try/catch，缺哪个就降级对应功能。
  try { coreConfig = await import('../../src/config.js'); } catch { coreConfig = null; }
  try { coreLlm = await import('../../src/llm.js'); } catch { coreLlm = null; }
  try { coreWebSearch = await import('../../src/web-search.js'); } catch { coreWebSearch = null; }
  try { corePersonas = await import('../../src/personas.js'); } catch { corePersonas = null; }
  try { coreStoreMod = await import('../../src/store.js'); } catch { coreStoreMod = null; }
  try { coreSafeFetch = await import('../../src/safe-fetch.js'); } catch { coreSafeFetch = null; }

  state = loadState();
  cache.clear();
  runSent.clear();

  const conf = settings();
  const learned = Object.keys(state.profiles || {}).length;
  const win = conf.nightly ? resolveRestWindow(conf) : null;
  log('已加载（%s）：%s。状态文件：%s',
    BUILD_TAG,
    conf.enabled
      ? `每 ${conf.learnMinutes} 分钟按本地存档重新学一次说话风格（样本 ${conf.sampleSize} 条起，最少 ${conf.minSample} 条才给建议；模仿程度：${conf.adoptLevel}）`
      : '当前为「停用学习」状态（只保留已学档案，不注入风格）',
    statePath);
  if (learned) log('磁盘上已有 %s 个群的风格档案，本次启动直接复用。', learned);
  if (conf.enabled && conf.nightly) {
    log('夜间整理已启用：休息时间 %s 自动整理/归档当天的聊天记录并复盘语气%s。',
      win?.label || '',
      conf.webMatch ? '（联网对照热榜学梗）' : '（不联网）');
  }
  startNightTimer();
}

/** 自检必须**同步**返回（返回 Promise 会被当成"可用"）。本插件没有硬依赖。 */
export function available() {
  return true;
}

/** 被启用时（界面打开开关）：保证夜间定时器在跑。 */
export function activate() {
  const conf = settings();
  if (conf.enabled && conf.nightly) startNightTimer();
  else stopNightTimer();
}

/**
 * 停用时（界面关掉开关 / 热重载覆盖）：
 *   · 内存缓存清掉 —— 下一次启用时重新按磁盘上的最新聊天记录统计
 *   · **不删档案**：用户关开关是"先别学"，不是"把学到的忘掉"
 *   · v1.1 起有夜间定时器了，停用必须一并停掉（否则积累幽灵定时器）
 */
export function deactivate() {
  stopNightTimer();
  cache.clear();
  runSent.clear();
}

/** 卸载：把没落盘的档案写下去（间隔传 0 = 立刻写），并停掉定时器。 */
export function dispose() {
  stopNightTimer();
  cache.clear();
  runSent.clear();
  try { flushState(0); } catch { /* 卸载路径上不再抛错 */ }
}

// ───────────────────────────── 提示词片段 ─────────────────────────────

/**
 * 动态提示词片段：每个群的风格都不一样，所以必须在**运行时**按 chatKey 生成，
 * 不能写死在 manifest.prompt.sections 里（那是全局静态段）。
 *
 * 调用时机（src/prompt.js 的 collectSkillSections）在**系统提示词末尾**，
 * 前面的核心规则字节不受影响，前缀缓存不会被这次注入整体毁掉 ——
 * 这一点很重要：静态段插在中间会把后面所有规则的字节位置推来推去。
 *
 * @param {object} ctx 宿主的 skillContext：{ chatKey, chatName, kind, model, sessionId, ... }
 */
export function promptSections(ctx = {}) {
  try {
    const conf = settings();
    if (!conf.enabled) return [];
    const chatKey = String(ctx?.chatKey || '');
    if (!chatKey) return [];
    // 私聊也照样用（一对一聊天同样有"跟谁说话像谁"的问题）
    const text = cache.get(chatKey);
    if (!text) return [];
    return [{
      id: 'adaptive-group-style',
      title: '',
      content: text,
      // 35 < 核心安全规则(100)/工具协议，> 普通技能段(50)之外靠后：
      // 风格是"怎么说"，必须排在"说什么/不能说什么"后面，绝不能盖住安全规则。
      priority: 35
    }];
  } catch (error) {
    warn('生成风格片段失败：%s', error?.message ?? error);
    return [];
  }
}

// ───────────────────────────── 钩子 ─────────────────────────────

/**
 * 钩子名对照（真实存在的只有这 5 个，由 src/orchestrator.js 的 runHook 调用）：
 *   before-context / before-llm-messages / after-response / before-tool / after-tool
 * 写错名字**不会报错**，钩子只是永远不被调用 —— 这是本项目最容易静默失效的坑。
 */
export const hooks = {

  /**
   * 提示词组装之前：更新这个群的风格缓存。
   *
   * 这是唯一"重活"的地方，而且是**到点才做**（默认 30 分钟一次），
   * 其余轮次直接命中缓存，对每次发言的耗时影响可以忽略。
   */
  'before-context'(ctx = {}) {
    try {
      // v1.1：记录宿主活动 + 捕获 store/memory 引用（夜间整理的数据源）。
      // 每次消息处理都会路过这里，所以 lastActivityAt 就是可靠的"忙闲"信号。
      lastActivityAt = Date.now();
      if (ctx?.store) lastEnv.store = ctx.store;
      if (ctx?.memory) lastEnv.memory = ctx.memory;

      const conf = settings();
      if (!conf.enabled) return;
      const chatKey = String(ctx?.chatKey || '');
      if (!chatKey) return;

      const entry = state.profiles[chatKey];
      const profile = entry?.profile;
      const intervalMs = conf.learnMinutes * 60_000;
      const stale = !profile || Date.now() - Number(profile.learnedAt || 0) >= intervalMs;

      if (stale || !cache.has(chatKey)) {
        learn({ chatKey, chatName: ctx.chatName, store: ctx.store, memory: ctx.memory }, conf);
      } else if (conf.observeSelf) {
        // 没到重学时间，但机器人自己说过的话要随时更新 ——
        // "你最近说话偏长"这类提醒必须反映**刚刚**的表现，不能等半小时。
        const self = Array.isArray(entry.selfSent) ? entry.selfSent.slice(-MAX_SELF_ROWS) : [];
        if (self.length >= 3) {
          const merged = { ...profile, self: profile.self || { n: self.length, issues: [] } };
          const rows = self.map((s) => ({ self: true, text: s.text, ts: s.ts }));
          const recheck = analyzeStyle({ rows, notes: [], sampleSize: MAX_SELF_ROWS, minSample: 3 });
          if (recheck?.self) merged.self = recheck.self;
          cache.set(chatKey, renderStyleHint(merged, {
            adoptLevel: conf.adoptLevel,
            includeWords: conf.includeWords,
            style: 'full',
            chatName: chatLabel(chatKey, ctx.chatName),
            night: entry.night,
            toneSoftening: conf.toneSoftening,
            memeInject: conf.memeInject
          }));
        }
      }
    } catch (error) {
      warn('学习失败（本轮不注入风格，不影响正常发言）：%s', error?.message ?? error);
    }
  },

  /**
   * 消息数组即将发给模型：在**本次用户消息末尾**再贴一小段紧凑版风格提醒。
   *
   * ⚠️ 为什么只在 user 消息末尾追加、绝不改系统提示词：
   *    系统提示词是缓存前缀的大头，动一个字节就可能让整段按全价重算；
   *    而用户消息本来就每轮都变（【当前时间】精确到秒），追加不产生额外损失。
   *    同时"最靠近发言位置"的指令，模型确实更当真（实测比只放系统提示有效）。
   */
  'before-llm-messages'(ctx = {}) {
    try {
      const conf = settings();
      if (!conf.enabled || !conf.injectToUser) return;
      const messages = ctx?.messages;
      if (!Array.isArray(messages) || !messages.length) return;
      const chatKey = String(ctx?.chatKey || '');
      const full = chatKey ? cache.get(chatKey) : '';
      if (!full) return;

      const compact = renderStyleHint(
        state.profiles[chatKey]?.profile,
        {
          adoptLevel: conf.adoptLevel,
          includeWords: conf.includeWords,
          style: 'compact',
          night: state.profiles[chatKey]?.night,
          toneSoftening: conf.toneSoftening,
          memeInject: conf.memeInject
        }
      );
      if (!compact) return;
      const text = clip(compact, COMPACT_MAX_CHARS);

      // 找最后一条 user 消息：宿主组装的 messages 是 [system, user]，之后还会
      // 追加 assistant/tool 轮次，但"本次输入"永远是最后那条 user。
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content === 'string') {
          // 同一轮可能被调用两次（重试路径），加个标记避免重复叠加
          if (m.content.includes('【本次发言的语言风格要求')) return;
          m.content = `${m.content}\n\n${text}`;
        }
        return;
      }
    } catch (error) {
      warn('注入本次输入失败（不影响发言）：%s', error?.message ?? error);
    }
  },

  /**
   * 每轮模型响应之后：把机器人**真正发出去**的话记下来。
   * 只记账，不发言、不改请求、不做 IO —— 5 秒超时的硬边界内绝对安全。
   */
  'after-response'(ctx = {}) {
    try {
      lastActivityAt = Date.now();   // v1.1：发消息也是活动，夜间任务要让路
      const conf = settings();
      if (!conf.enabled || !conf.observeSelf) return;
      const chatKey = String(ctx?.chatKey || '');
      if (!chatKey) return;
      // 只认宿主显式给的 chatKey —— 会话记账表只用来去重，不用来判归属
      const texts = collectSelfSent(ctx.session, chatKey);
      if (!texts.length) return;
      rememberSelf(chatKey, texts);
    } catch (error) {
      warn('记录自己发言失败（不影响发言）：%s', error?.message ?? error);
    }
  }
};

/** 测试与排障用导出（不是宿主 API，随便改）。 */
export const __internals = {
  settings, learn, loadState,
  get statePath() { return statePath; },
  get profiles() { return state.profiles; },
  get cache() { return cache; },
  // ── v1.1 夜间整理官 ──
  parseRestWindowFromText,
  resolveRestWindow,
  inRestWindow,
  runNightly,
  parseNightlyJson,
  buildNightlyPayload,
  scanAggression,
  matchTrends,
  loadTrends,
  webLookup,
  nightlyLlmCall,
  setLlmCall: (fn) => { llmCallOverride = fn; },
  setWebLookup: (fn) => { webLookupOverride = fn; },
  setTrends: (items) => { trendsOverride = items; },
  touchActivity: (ms = Date.now()) => { lastActivityAt = ms; },
  setLastEnv: (env) => { lastEnv = { ...lastEnv, ...env }; },
  get nightState() { return state.nightly; },
  get dataDir() { return dataDir(); },
  get timerAlive() { return Boolean(nightTimer); },
  stopNightTimer,
  startNightTimer,
  resetForTest: () => {
    state = { version: 1, profiles: {}, nightly: {} };
    cache.clear();
    runSent.clear();
    dirty = false;
    lastFlushAt = 0;
    nightRunning = false;
    lastActivityAt = 0;
    lastEnv = { store: null, memory: null };
    llmCallOverride = null;
    webLookupOverride = null;
    trendsOverride = null;
    restWindowCache = null;
  },
  setStatePath: (p) => { statePath = String(p); },
  setConfig: (fn) => { cfg = fn; }
};
