// B站热门推送（bilibili-hot-push）
//
// 为什么是「插件」而不是「技能」：按 plugin-development.md §0 的三问判断法 ——
//   ① 触发时机能用 if 描述吗？ 「每 N 分钟检查一次，掷骰子命中就发」是死规则 → 插件
//   ② 漏触发一次代价？        只是少一条分享，下轮还有机会（代价低，但触发时机是死的）
//   ③ 参数从哪来？            群号、概率、间隔全来自设置，不来自人话 → 插件
// 第一问为准 → 确定性型。
//
// ── 两个必须知道的实现约束 ────────────────────────────────────────────────
//
// 1) **不能靠钩子发消息**。plugin-development.md §3.2 写死了：钩子 5 秒超时、
//    不得发请求、不得发消息。所以"抓取 + 发送"放 activate 起的定时器里。
//
// 2) **模块层面拿不到 sender**。所有出站消息必须走 SendQueue（ctx.sender），
//    而它只存在于会话上下文里。范式与 hot-trend-tracker 一致：在 after-response
//    钩子里"顺手捡"一个引用按会话缓存，后台想发时取用。拿不到就降级跳过，
//    绝不绕过 SendQueue 直连 OneBot（那样会跳过限频/去重/留档）。
//
// ── 实测事实（2026-10-05 本机直连）────────────────────────────────────────
//   · popular 接口稳定可用，且**不带 referer 也能通**（与 search 不同）
//   · duration 是**字符串** "8:13"，不是秒数 → 必须自己解析
//   · title 含 <em> 高亮、可能含 HTML 实体 → 发出去前要清

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const BUILD_TAG = 'v1.1.0-self-dailycap';

/** 实测稳定；这是 B 站官方的"当前热门"榜。 */
const POPULAR_API = 'https://api.bilibili.com/x/web-interface/popular';
/** 搜索端点：必须走 wbi 路径（不带 wbi 的 search/type 实测 3 次里 2 次 412）。 */
const SEARCH_API = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BILI_REFERER = 'https://www.bilibili.com/';

const STORE_FILE = () => path.join(DATA_DIR, 'bilibili-hot-push.json');
const MAX_FETCH = 20;              // 热门榜一次抓多少条候选
const MIN_INTERVAL_MIN = 5;        // 最低检查间隔：比这更密没有意义，只会被风控
const MAX_INTERVAL_MIN = 720;
const MAX_SELF_PAGES = 5;
const MAX_SELF_TERMS = 6;
/** 自搜翻页之间的间隔：实测连打会触发 412，必须留。 */
const SELF_PAGE_GAP_MS = 1200;

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let apiFetch = null;
/** api.log 的原始函数，只由 fileLog 调用（见那里的递归警告）。 */
let baseLogFn = null;

/**
 * 插件日志落盘。
 *
 * 为什么不用 api.log：它的实现是 `console.log('[skill:id]', ...)`（见
 * src/plugin-loader.js:120），**只写 stdout、不进 data/logs/**。应用用隐藏窗口
 * 启动时这些输出谁都看不见，插件的运行情况完全不可观测（排查"到底推没推"时
 * 只能靠猜）。所以这里自己追加到 data/logs/ 下一个独立文件。
 *
 * 只做追加、不删旧文件；出错绝不抛出（日志失败不能影响推送本身）。
 */
const LOG_BASENAME = 'bilibili-hot-push.log';
const MAX_LOG_BYTES = 512 * 1024;   // 超过就截断重来，别无限长大

function fileLog(level, ...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(' ');
  try {
    const f = path.join(DATA_DIR, 'logs', LOG_BASENAME);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // 简单轮转：文件太大就先清空，避免长期运行把磁盘写满
    try {
      if (fs.statSync(f).size > MAX_LOG_BYTES) fs.writeFileSync(f, '', 'utf8');
    } catch { /* 文件不存在，无需轮转 */ }
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    fs.appendFileSync(f, `[${stamp}] [${level}] ${text}\n`, 'utf8');
  } catch { /* 日志失败不影响推送 */ }
  // ⚠️ 这里只调 api.log 的原函数（baseLog），绝不能调本模块的 log —— 那会无限递归。
  if (typeof baseLogFn === 'function') {
    try { baseLogFn(text); } catch { /* ignore */ }
  }
}

let timer = null;
// ⚠️ 2026-10-21 补丁：启动检查那枚 setTimeout 原来没有存句柄。
// 原写法 `setTimeout(..., 20000).unref?.()` 让 deactivate()/dispose() 只能清 interval，
// 每次 activate 都会在 20 秒后留下一个取消不掉的「启动检查」——热重载几次就叠几个，
// 同一轮里重复抓取、重复推同一条视频。
// 实测：2026-10-21 22:35:39/40/54/58 四次重载，对应的检查分别在
// 22:35:59 / 22:36:00 / 22:36:14 / 22:36:18 全部落地，一次都没被取消；
// 2026-10-20 12:27:31~32 更是 4 秒内叠了 10 次检查。
// 现在存成 bootTimer，activate 开头先清旧的，deactivate/dispose 一起清。
let bootTimer = null;
let lastRunAt = 0;

/**
 * 发送通道缓存 —— 见文件头第 2 条。
 * chatKey（"group:123"）-> { sender, at }
 */
const senderCache = new Map();

// ───────────────────────────── 设置 ─────────────────────────────

function settings() {
  const c = cfg() || {};
  const num = (v, dflt, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    enabled: c.enabled !== false,
    groups: parseGroups(c.targetGroups),
    probability: num(c.pushProbability, 0.2, 0, 1),
    intervalMin: num(c.checkIntervalMin, MIN_INTERVAL_MIN, MIN_INTERVAL_MIN, MAX_INTERVAL_MIN),
    maxPerDay: Math.round(num(c.maxPerDay, 8, 0, 200)),
    perRound: Math.round(num(c.perRound, 1, 1, 3)),
    // ── 自搜模式 ──
    onlySelf: c.onlySelf === true,
    // 字段名不带 "key"：含 key 的字段会被核心密文规则脱敏成 ******，
    // 且"清空"会被"空串=不修改"挡住（excludeKeywords 踩过这个坑）。
    selfTerms: String(c.selfTerms ?? c.selfSearchTerms ?? '')
      .split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_SELF_TERMS),
    selfPages: Math.round(num(c.selfPages, 2, 1, MAX_SELF_PAGES)),
    minDuration: Math.max(0, Number(c.minDurationSec) || 0),
    maxDuration: Math.max(0, Number(c.maxDurationSec) || 0),
    // 字段名叫 titleBlocklist 而不是 excludeKeywords：
    // 后者含 "key"，会命中核心的密文规则 /key|token|secret|password|cookie/i，
    // 被当密钥脱敏显示成 ******，而且"清空它"会被"空串=不修改"挡住，永远清不掉。
    titleBlocklist: String(c.titleBlocklist ?? c.excludeKeywords ?? '')
      .split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    quietStart: Math.round(num(c.quietStartHour, 1, 0, 23)),
    quietEnd: Math.round(num(c.quietEndHour, 8, 0, 23)),
    keepHistory: Math.round(num(c.keepHistory, 500, 20, 5000)),
  };
}

/** "100000000, 100000000" → ["group:100000000", "group:100000000"] */
function parseGroups(raw) {
  const out = [];
  for (const piece of String(raw ?? '').split(/[,，\s]+/)) {
    const p = piece.trim();
    if (!p) continue;
    const digits = p.replace(/^group:/i, '').trim();
    if (!/^\d{5,12}$/.test(digits)) continue;
    const key = `group:${digits}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

// ───────────────────────────── 去重存档 ─────────────────────────────

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_FILE(), 'utf8');
    const j = JSON.parse(raw);
    return {
      pushed: Array.isArray(j?.pushed) ? j.pushed : [],
      lastPushAt: Number(j?.lastPushAt) || 0,
      // 每日计数：{ day: '2026-10-05', count: 3 }
      day: String(j?.day ?? ''),
      dayCount: Number(j?.dayCount) || 0,
    };
  } catch {
    return { pushed: [], lastPushAt: 0, day: '', dayCount: 0 };
  }
}

/** 今天（本地日期）的键，用于每日上限的跨天重置。 */
function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 取今天的已推条数，跨天自动归零。 */
function todayCount(store) {
  const key = todayKey();
  if (store.day !== key) { store.day = key; store.dayCount = 0; }
  return store.dayCount;
}

function saveStore(store) {
  try {
    const s = settings();
    if (store.pushed.length > s.keepHistory) {
      store.pushed = store.pushed.slice(-s.keepHistory);
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STORE_FILE()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_FILE());
  } catch (e) {
    warn(`保存去重记录失败：${e?.message ?? e}`);
  }
}

// ───────────────────────────── 抓取 ─────────────────────────────

async function fetchPopular() {
  const list = await biliGet(`${POPULAR_API}?ps=${MAX_FETCH}&pn=1`);
  return list;
}

/**
 * 自搜：用一组关键词翻多页，去重后返回候选。
 * 与 skills/bilibili-search 的 self_search 工具同一套实测结论：
 *   · 必须走 wbi 路径 + bilibili referer（否则 412）
 *   · 翻页之间必须留间隔（连打会 412）
 *   · duration 是字符串 "8:13"
 */
async function fetchSelfVideos(s) {
  const out = [];
  const seen = new Set();
  for (const term of s.selfTerms) {
    for (let page = 1; page <= s.selfPages; page++) {
      let list;
      try {
        list = await biliGet(`${SEARCH_API}?search_type=video&keyword=${encodeURIComponent(term)}&page=${page}&order=totalrank`);
      } catch (e) {
        // 被风控就放弃这个词，换下一个（别硬撞）
        warn(`自搜「${term}」第 ${page} 页失败：${e?.message ?? e}`);
        break;
      }
      for (const it of list) {
        const bvid = String(it?.bvid ?? '').trim();
        if (!bvid || seen.has(bvid)) continue;
        seen.add(bvid);
        out.push(it);
      }
      if (list.length < 20) break;              // 到底了
      if (page < s.selfPages) await sleep(SELF_PAGE_GAP_MS + Math.random() * 800);
    }
  }
  return out;
}

/** 抓一个 B 站 JSON 接口，返回 data.list 或 data.result。失败抛错。 */
async function biliGet(url) {
  const doFetch = apiFetch ? apiFetch : (u, o) => fetch(u, o);
  const res = await doFetch(url, {
    headers: { 'user-agent': UA, referer: BILI_REFERER },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 412) throw new Error('B 站风控（412）');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json().catch(() => null);
  if (!j || j.code !== 0) throw new Error(`接口返回 code=${j?.code ?? '未知'} ${j?.message ?? ''}`);
  const d = j?.data;
  if (Array.isArray(d?.list)) return d.list;      // popular
  if (Array.isArray(d?.result)) return d.result;  // search
  return [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 标题清污：去 <em> 高亮、HTML 实体，压平空白。 */
function cleanTitle(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

/** duration 实测是字符串 "8:13" / "1:02:33"。当数字用会得到 NaN。 */
function durationSec(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v ?? '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function fmtCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '未知');
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

/**
 * 把两个接口（popular 的 owner/stat、search 的 author/play）统一成一种形态。
 * ⚠️ 不统一就会出现"抓到了却全被过滤掉"的静默失效：pickCandidates 读 owner.name，
 * 而搜索接口返回的是 author —— 自搜模式下候选永远是 0 条。
 */
function normalizeItem(it, sourceTerm = '') {
  const sec = durationSec(it?.duration);
  const bvid = String(it?.bvid ?? '').trim();
  return {
    bvid,
    title: cleanTitle(it?.title),
    author: String(it?.owner?.name ?? it?.author ?? '').trim() || '未知UP',
    playNum: Number(it?.stat?.view ?? it?.play) || 0,
    play: fmtCount(it?.stat?.view ?? it?.play),
    sec,
    durText: fmtDuration(sec),
    link: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
    tname: String(it?.tname ?? '').trim(),
    sourceTerm,
  };
}

/** 按设置过滤候选（时长、排除词、已推过）。入参需先过 normalizeItem。 */
function pickCandidates(list, store, s) {
  const seen = new Set(store.pushed.map((x) => String(x?.bvid ?? '')));
  const out = [];
  for (const raw of list) {
    const it = normalizeItem(raw, raw?.__term ?? '');
    if (!it.bvid || !it.title) continue;
    if (seen.has(it.bvid)) continue;
    if (s.minDuration && it.sec < s.minDuration) continue;
    if (s.maxDuration && it.sec > s.maxDuration) continue;
    if (s.titleBlocklist.some((kw) => it.title.includes(kw))) continue;
    out.push(it);
  }
  return out;
}

// ───────────────────────────── 安静时段 ─────────────────────────────

function inQuietHours(s, now = new Date()) {
  const a = s.quietStart, b = s.quietEnd;
  if (a === b) return false;
  const h = now.getHours();
  return a < b ? (h >= a && h < b) : (h >= a || h < b);
}

// ───────────────────────────── 发送 ─────────────────────────────

function buildText(item, first, selfMode) {
  const head = selfMode
    ? (first ? '自搜了一下，B 站上居然有人提到我：' : '又翻到一个：')
    : (first ? '刷到个 B 站热门的，分享一下：' : '再补一个：');
  return `${head}\n${item.title}\nUP：${item.author}　播放：${item.play}　时长：${item.durText}\n${item.link}`;
}

/**
 * 往一个会话发一条。走缓存的 SendQueue（限频/去重/留档都在里面）。
 * 拿不到通道就返回 false —— 调用方据此跳过，绝不绕过队列直发。
 */
function sendTo(chatKey, text) {
  const entry = senderCache.get(chatKey);
  if (!entry?.sender?.sendTextBatch) {
    log(`想在 ${chatKey} 推送，但还没见过该会话的发送通道`
      + '（机器人得先在那个群里说过话）。已跳过这一条。');
    return false;
  }
  Promise.resolve(entry.sender.sendTextBatch(chatKey, [text]))
    .then((r) => log(`已推送到 ${chatKey}（发出 ${r?.sent?.length ?? 0} 条）`))
    .catch((e) => warn(`推送失败（${chatKey}）：${e?.message ?? e}`));
  return true;
}

// ───────────────────────────── 主流程 ─────────────────────────────

let running = false;

async function checkAndPush(reason = 'timer') {
  const s = settings();
  if (!s.enabled) return;
  if (running) { log('上一轮还在跑，跳过本次检查'); return; }
  if (!s.groups.length) { log('没有配置推送目标群（settings.targetGroups 为空），本次跳过'); return; }
  if (inQuietHours(s)) { log(`现在是安静时段（${s.quietStart}~${s.quietEnd} 点），不推送`); return; }
  if (Math.random() >= s.probability) { log(`掷骰子未命中（概率 ${s.probability}），本轮不推`); return; }

  running = true;
  lastRunAt = Date.now();
  try {
    const store = loadStore();

    // ── 每日上限（安全阀）——必须在抓取之前判断，省一次请求 ──
    const used = todayCount(store);
    if (s.maxPerDay > 0 && used >= s.maxPerDay) {
      log(`今天已经推了 ${used} 条，达到每日上限 ${s.maxPerDay}，明天再推`);
      saveStore(store);   // 跨天归零要落盘
      return;
    }

    // ── 抓候选：自搜模式 or 热门榜 ──
    const list = s.onlySelf ? await fetchSelfVideos(s) : await fetchPopular();
    const cands = pickCandidates(list, store, s);
    if (!cands.length) {
      log(`抓到 ${list.length} 条${s.onlySelf ? '（自搜）' : '（热门）'}，但都被过滤或推过了`);
      return;
    }

    // 随机挑（让每次推的不一样），条数受 perRound 限制，且不超每日上限
    const room = s.maxPerDay > 0 ? Math.max(0, s.maxPerDay - used) : s.perRound;
    const want = Math.min(s.perRound, room, cands.length);
    const shuffled = cands.slice().sort(() => Math.random() - 0.5);
    const picks = shuffled.slice(0, want);

    let sentCount = 0;
    for (const item of picks) {
      // 每轮每个群最多一条，避免刷屏
      const targets = s.groups.slice().sort(() => Math.random() - 0.5);
      let delivered = false;
      for (const key of targets) {
        if (sendTo(key, buildText(item, sentCount === 0, s.onlySelf))) { delivered = true; break; }
      }
      if (!delivered) {
        log('所有目标群都拿不到发送通道，本轮放弃（机器人先在那几个群说句话就会恢复）');
        break;
      }
      store.pushed.push({ bvid: item.bvid, title: item.title, at: Date.now() });
      store.dayCount = (store.dayCount || 0) + 1;   // 计入当日配额
      sentCount++;
    }
    if (sentCount) {
      store.lastPushAt = Date.now();
      saveStore(store);
      const left = s.maxPerDay > 0 ? `，今日还剩 ${Math.max(0, s.maxPerDay - store.dayCount)} 条` : '';
      log(`推送完成：${sentCount} 条（${reason}${s.onlySelf ? '，自搜模式' : ''}）${left}`);
    }
  } catch (e) {
    warn(`${s.onlySelf ? '自搜' : '抓取热门'}失败：${e?.message ?? e}`);
  } finally {
    running = false;
  }
}

function startTimer() {
  stopTimer();
  const s = settings();
  const ms = Math.max(MIN_INTERVAL_MIN, s.intervalMin) * 60 * 1000;
  timer = setInterval(() => {
    checkAndPush('timer').catch((e) => warn(`定时检查异常：${e?.message ?? e}`));
  }, ms);
  // 不阻塞进程退出（与 hot-trend-tracker 同一约定）
  timer.unref?.();
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** ⚠️ 2026-10-21 补丁：清除「启动后 20 秒的首次检查」（见文件上方 bootTimer 注释）。 */
function stopBoot() {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
}

// ───────────────────────────── 生命周期 / 扩展点 ─────────────────────────────

export function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  // 本插件的 log/warn 全走 fileLog：写 data/logs/bilibili-hot-push.log，
  // 同时转发给 api.log 的原函数（有终端时仍能看见）。
  baseLogFn = typeof api?.log === 'function' ? api.log : null;
  log = (...a) => fileLog('INFO', ...a);
  warn = (...a) => fileLog('WARN', ...a);
  apiFetch = typeof api?.fetch === 'function' ? api.fetch.bind(api) : null;
  // ⚠️ 2026-10-21 补丁：这里原来会打一条「已就绪｜模式…｜目标群…」的自述。
  // 但 setup() 跑在插件配置解析好之前，settings() 此刻拿到的是 schema 默认值，
  // 于是启动日志出现自相矛盾的画面：
  //   「模式 全站热门｜目标群（未配置）｜每 5 分钟检查，命中概率 0.2」
  //   「定时器已启动：每 30 分钟检查一次」        ← 同一秒，两条不同答案
  // 容易被误读成"设置丢了"。自述挪到 activate()（那时配置已就绪）。
}

export function activate() {
  const s = settings();
  // 真实状态自述（配置已就绪，与 data/config.json 一致）
  log(`${BUILD_TAG} 已就绪｜${s.enabled ? '自动推送开' : '自动推送关'}`
    + `｜模式 ${s.onlySelf ? `自搜（${s.selfTerms.length} 个词 × ${s.selfPages} 页）` : '全站热门'}`
    + `｜目标群 ${s.groups.length ? s.groups.join('、') : '（未配置）'}`
    + `｜每 ${s.intervalMin} 分钟检查，命中概率 ${s.probability}`
    + `｜每日上限 ${s.maxPerDay || '不限'}`);
  if (!s.enabled) {
    log('自动推送是关闭状态：定时器不启动');
    return;
  }
  if (!s.groups.length) {
    log('已启用但没配目标群（targetGroups）——定时器照常跑，但永远不会发出去');
  }
  startTimer();
  // ⚠️ 2026-10-21 补丁：句柄存进 bootTimer 并先清旧的，否则取消不掉（见文件上方注释）
  stopBoot();
  // 启动后延迟 20 秒再检查第一次：别和启动抢 IO，也给会话留出"捡发送通道"的时间
  bootTimer = setTimeout(() => {
    bootTimer = null;
    checkAndPush('startup').catch((e) => warn(`启动检查异常：${e?.message ?? e}`));
  }, 20000);
  bootTimer.unref?.();
  log('定时器已启动');
}

export function deactivate() {
  stopTimer();
  stopBoot();          // ⚠️ 2026-10-21 补丁：启动检查也要清（原来只清 interval）
  senderCache.clear();
  log('定时器已停止、发送通道缓存已清空（禁用/重载时调用，不会留下幽灵定时器）');
}

export function dispose() {
  stopTimer();
  stopBoot();          // ⚠️ 2026-10-21 补丁
  senderCache.clear();
}

/** 同步返回。不依赖网络：抓不到只是没有新内容，插件本身照常可用。 */
export function available() {
  return true;
}

export const hooks = {
  /**
   * 顺手捡发送通道（见文件头第 2 条）。
   * 只缓存一个引用：不发消息、不改内容、失败也不影响会话。
   */
  async 'after-response'(ctx = {}) {
    try {
      const key = String(ctx.chatKey || '');
      if (!key || !ctx.sender?.sendTextBatch) {
        // ⚠️ 2026-10-21：原来这里静默 return，导致"推送不出去"完全无从查起。
        //    内核已给 hook 补上 sender（orchestrator.js 的 skillContext），
        //    这行只在**真的拿不到**时才打，正常情况不该出现。
        if (key && !ctx.sender?.sendTextBatch) fileLog('WARN', `after-response 没拿到 ctx.sender（${key}），主动推送将不可用`);
        return;
      }
      const isNew = !senderCache.has(key);
      senderCache.set(key, { sender: ctx.sender, at: Date.now() });
      // 每个会话只在**第一次**缓存时记一行，之后不刷屏；这是验证"通道到底通没通"的唯一凭据。
      if (isNew) fileLog('INFO', `发送通道已缓存：${key}（之后可以主动推送）`);
      // 只留最近的若干个，避免长期运行无限增长
      if (senderCache.size > 30) {
        const oldest = [...senderCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) senderCache.delete(oldest[0]);
      }
    } catch { /* 捡不到就降级，推送功能失效而已 */ }
  },
};
