// lib/store.js —— 生活事件存储（纯逻辑，root 可注入，便于测试）
//
// 与 index.js 解耦：不依赖 config.js / Electron，测试脚本直接 import。
// 设计原则（防 bug）：IO 全 try/catch、原子写入、TTL + 容量双保险、失败只降级不抛错。
//
// 2026-10-04 补（对齐 inner-life 的「再次触发才忘记」）：
//   原来按「创建时间 at」24 小时硬过期，且没有去重、ongoing 永不自动过期。这导致三个真问题：
//     1) 近重复的小事被记成两条，白占容量；
//     2) 记了 ongoing 却忘了 life_done 的事，会**永远**挂在「进行中」注入里
//        （"等他回来吹"那类梗被焊死就是同款机制）；
//     3) 一件她还在惦记的事，会因为「创建时间过了 24 小时」就凭空消失（其实她想接着）。
//   现在改成：去重（归一化近重复合并）+ 按「最近触碰 touchedAt」过期 + ongoing 也有长兜底（不再永久挂）。
import fs from 'node:fs';
import path from 'node:path';

/** 归一化：去空白、去标点/符号，只留文字数字（大小写折叠）。 */
export function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/**
 * 两条事件是不是"同一件"（复刻 inner-life 的 isSameTopic 口径）：
 *   · 归一化后完全相等 → 是；
 *   · 一方包含另一方，且短的那条 ≥6 字、占长句的 ≥50% → 是。
 */
export function isSameEvent(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 6) return false;
  return long.includes(short) && short.length / long.length >= 0.5;
}

/**
 * 把近似重复的事件并成一条：
 *   文本留"信息更多"的那个说法，时间按最早排队，触碰时间按最新续期，ongoing 取"或"。
 * 纯函数、不改入参；顺带按时间升序排好（容量裁剪取最后 N 条才稳定）。
 */
export function mergeEvents(events) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    const text = String(e?.text || '').trim();
    if (!text) continue;
    const at = Number(e?.at) || 0;
    const touchedAt = Number(e?.touchedAt) || at;
    const ongoing = !!e?.ongoing;
    const hit = out.find((o) => isSameEvent(o.text, text));
    if (!hit) {
      out.push({ id: e?.id, text, at, touchedAt, ongoing });
      continue;
    }
    if (normalizeText(text).length > normalizeText(hit.text).length) hit.text = text;
    hit.at = hit.at ? Math.min(hit.at, at || hit.at) : at;
    hit.touchedAt = Math.max(hit.touchedAt, touchedAt);
    hit.ongoing = hit.ongoing || ongoing;
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

/**
 * @param {string} rootDir 存储根目录
 * @param {() => {ttlHours?:number, ongoingTtlHours?:number, maxEvents?:number}} getOptions 每次现读配置
 */
export function createStore(rootDir, getOptions = () => ({})) {
  const root = path.resolve(String(rootDir || ''));

  function ensureDir() {
    try { fs.mkdirSync(root, { recursive: true }); } catch { /* ignore */ }
  }

  function fileOf(chatKey) {
    const safe = String(chatKey || '').replace(/[^a-zA-Z0-9_]/g, '_') || '_default';
    return path.join(root, `${safe}.json`);
  }

  // 今天的规划单独存一个文件，和 events 完全隔离（避免读改写互相覆盖）。
  function planFileOf(chatKey) {
    const safe = String(chatKey || '').replace(/[^a-zA-Z0-9_]/g, '_') || '_default';
    return path.join(root, `${safe}.plan.json`);
  }

  function readEvents(chatKey) {
    try {
      const f = fileOf(chatKey);
      if (!fs.existsSync(f)) return [];
      let t = fs.readFileSync(f, 'utf8');
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      const j = JSON.parse(t);
      return Array.isArray(j?.events) ? j.events : [];
    } catch {
      return [];
    }
  }

  function writeEvents(chatKey, events) {
    try {
      ensureDir();
      const f = fileOf(chatKey);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ events }, null, 1), 'utf8');
      fs.renameSync(tmp, f);
      return true;
    } catch {
      return false;
    }
  }

  function readPlan(chatKey) {
    try {
      const f = planFileOf(chatKey);
      if (!fs.existsSync(f)) return null;
      let t = fs.readFileSync(f, 'utf8');
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      const j = JSON.parse(t);
      return j && typeof j === 'object' ? j : null;
    } catch {
      return null;
    }
  }

  function writePlan(chatKey, plan) {
    try {
      ensureDir();
      const f = planFileOf(chatKey);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(plan, null, 1), 'utf8');
      fs.renameSync(tmp, f);
      return true;
    } catch {
      return false;
    }
  }

  function opts() {
    const o = getOptions() || {};
    const ttlHours = Number(o.ttlHours) > 0 ? Number(o.ttlHours) : 24;
    // 进行中的事：也给一个长兜底（默认 7 天）。真正在进行的大事不可能 7 天一次都不提；
    // 7 天没被触碰 = 早结束了、只是忘了 life_done —— 该淡忘，不该永久挂。
    const ongoingTtlHours = Number(o.ongoingTtlHours) > 0 ? Number(o.ongoingTtlHours) : 168;
    const maxEvents = Number(o.maxEvents) > 0 ? Number(o.maxEvents) : 60;
    return {
      ttlMs: ttlHours * 3600 * 1000,
      ongoingTtlMs: ongoingTtlHours * 3600 * 1000,
      maxEvents
    };
  }

  /**
   * 清理：
   *   · 先合并近重复；
   *   · 非进行中的小事：按「最近触碰 touchedAt」过期（不是创建时间 at）；
   *   · 进行中的事：按更长的 ongoingTtl 过期（防"忘了 life_done 就永久挂"），life_done 可提前收；
   *   · 裁剪到上限（时间升序，取最后 N 条才稳定）。
   */
  function prune(events) {
    const { ttlMs, ongoingTtlMs, maxEvents } = opts();
    const now = Date.now();
    const merged = mergeEvents(events);
    const kept = merged.filter((e) => {
      const touched = Number(e?.touchedAt) || Number(e?.at) || 0;
      if (e?.ongoing) return (now - touched) <= ongoingTtlMs;
      return (now - touched) <= ttlMs;
    });
    return kept.slice(-maxEvents);
  }

  return { readEvents, writeEvents, readPlan, writePlan, prune, mergeEvents, isSameEvent, normalizeText, root };
}
