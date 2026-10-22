// lib/store.js —— 心绪存储（纯逻辑，root 可注入，便于测试）
//
// 与 index.js 解耦：不依赖 config.js / Electron，测试脚本直接 import。
// 设计原则（防 bug）：IO 全 try/catch、原子写入、TTL + 容量双保险、失败只降级不抛错。
//
// 2026-10-03 补：心事去重从"逐字相等"升级为"归一化后近重复合并"。
//   实测（真实会话数据）：同一件事隔两分钟被记了两次，第二次只少说了两个字
//     （相当于「说好明天煮粥时喂猫」跟「明天煮粥时喂猫」的差别）—— 逐字比对会判成两件，
//     于是注入时同一件事列了两遍、白占 1/3 容量。
//   同时把"过期"口径从"创建时间"改成"最近一次触碰"：她还在惦记的事不该在她
//   还想着的时候淡忘（注入不续期，只有她主动重新记一次才算"还在惦记"）。
import fs from 'node:fs';
import path from 'node:path';

/** 归一化：去空白、去标点/符号，只留文字数字（大小写折叠）。 */
export function normalizeTopic(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/**
 * 两条心事是不是"同一件"：
 *   · 归一化后完全相等 → 是；
 *   · 一方包含另一方，且短的那条 ≥6 字、占长句的 ≥50% → 是（"说好"这类前缀/尾缀差异）。
 * 6 字下限与 50% 比例是保守闸门：不把"吃饭了"和"吃饭了没"这类短句误并成一件。
 */
export function isSameTopic(a, b) {
  const x = normalizeTopic(a);
  const y = normalizeTopic(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 6) return false;
  return long.includes(short) && short.length / long.length >= 0.5;
}

/**
 * 把近似重复的心事并成一条：
 *   文本留"信息更多"的那个说法，时间按最早排队，触碰时间按最新续期。
 * 纯函数、不改入参；顺带按时间升序排好（容量裁剪取最后 N 条才稳定）。
 */
export function mergeTopics(topics) {
  const out = [];
  for (const t of Array.isArray(topics) ? topics : []) {
    const text = String(t?.text || '').trim();
    if (!text) continue;
    const at = Number(t?.at) || 0;
    const touchedAt = Number(t?.touchedAt) || at;
    const hit = out.find((o) => isSameTopic(o.text, text));
    if (!hit) {
      out.push({ id: t?.id, text, at, touchedAt });
      continue;
    }
    if (normalizeTopic(text).length > normalizeTopic(hit.text).length) hit.text = text;
    hit.at = hit.at ? Math.min(hit.at, at || hit.at) : at;
    hit.touchedAt = Math.max(hit.touchedAt, touchedAt);
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

/**
 * @param {string} rootDir 存储根目录
 * @param {() => {topicTtlHours?:number, moodTtlHours?:number, maxTopics?:number}} getOptions 每次现读配置
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

  /** 读回（损坏/不存在一律返回空状态，不抛错）。 */
  function read(chatKey) {
    try {
      const f = fileOf(chatKey);
      if (!fs.existsSync(f)) return { mood: '', moodAt: 0, topics: [], updatedAt: 0 };
      let t = fs.readFileSync(f, 'utf8');
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      const j = JSON.parse(t);
      return {
        mood: typeof j?.mood === 'string' ? j.mood : '',
        moodAt: Number(j?.moodAt) || 0,
        topics: Array.isArray(j?.topics) ? j.topics : [],
        updatedAt: Number(j?.updatedAt) || 0
      };
    } catch {
      return { mood: '', moodAt: 0, topics: [], updatedAt: 0 };
    }
  }

  function write(chatKey, state) {
    try {
      ensureDir();
      const f = fileOf(chatKey);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
      fs.renameSync(tmp, f);
      return true;
    } catch {
      return false;
    }
  }

  function opts() {
    const o = getOptions() || {};
    return {
      topicTtlMs: (Number(o.topicTtlHours) > 0 ? Number(o.topicTtlHours) : 12) * 3600 * 1000,
      moodTtlMs: (Number(o.moodTtlHours) > 0 ? Number(o.moodTtlHours) : 24) * 3600 * 1000,
      maxTopics: Number(o.maxTopics) > 0 ? Number(o.maxTopics) : 3
    };
  }

  /** 清理：合并近重复心事；情绪超时清空；心事超时删除；裁剪到上限。返回新的状态对象。 */
  function prune(state) {
    const { topicTtlMs, moodTtlMs, maxTopics } = opts();
    const now = Date.now();
    const mood = (now - (Number(state?.moodAt) || 0)) <= moodTtlMs
      ? String(state?.mood || '').slice(0, 40)
      : '';
    const topics = mergeTopics(state?.topics)
      .filter((t) => (now - (Number(t?.touchedAt) || Number(t?.at) || 0)) <= topicTtlMs)
      .slice(-maxTopics);
    return {
      mood,
      moodAt: mood ? Number(state?.moodAt) || now : 0,
      topics,
      updatedAt: Number(state?.updatedAt) || 0
    };
  }

  return { read, write, prune, root };
}
