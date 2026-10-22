// heartbeat —— 心跳
//
// 给角色一颗**会跳的心**：被戳中时心跳变快、会心动会害羞，之后随时间自然平复。
//
// 为什么需要它（和已有插件的分工）：
//   · inner-life  —— 情绪基调 + 挂心事，TTL 按**小时**算，管的是"跨轮的内心"
//   · life-memory —— 仿真实生活、每日规划，TTL 按**天**算
//   · affinity    —— 群友好感度，按**人**累计
//   这三个都是慢变量。缺的是**这一场对话里**的生理反应：被夸了一句心跳就快，
//   被盯着看会脸红，冷场十分钟又平了。慢插件管不了这个时间尺度。
//
// 实现要点（都是踩过的坑）：
//   · **不用定时器**：只存「上次计算时刻 + 当时的数值」，读的时候按经过时间算衰减。
//     定时器要处理 start/stop/dispose/重入，而懒计算永远是准的，进程重启也不丢。
//   · 指数衰减（半衰期），不是线性 —— 刚被戳完掉得快，余温拖得久。
//   · 状态按 chatKey 分文件存，原子写入（tmp + rename），所有 IO 都 try/catch。
//   · 平静时不注入「身体反应」，只留使用说明 —— 否则每轮都在提心跳，反而假。
//   · 注入的是**身体感觉**，明确要求"别报数字"，让它影响语气而不是变成台词。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

let cfg = () => ({});
let log = () => {};

const DIR = path.join(DATA_DIR, 'heartbeat');

// 基线：平常状态下的心率
const BASE_BPM = 68;
// 低于这个值就认为"平了"，不注入身体反应
const CALM_EPS = 0.35;

function settings() {
  const c = cfg() || {};
  return {
    enabled: c.enabled !== false,
    injectGuide: c.injectGuide !== false,
    halfLifeMin: Math.min(180, Math.max(1, Number(c.halfLifeMin) || 8)),
    maxLevel: Math.min(5, Math.max(1, Number(c.maxLevel) || 3)),
    quietWhenCalm: c.quietWhenCalm !== false
  };
}

function fileFor(chatKey) {
  const safe = String(chatKey || 'unknown').replace(/[^a-z0-9_]/gi, '_');
  return path.join(DIR, `${safe}.json`);
}

function emptyState() {
  return { flutter: 0, shy: 0, why: '', at: Date.now() };
}

function readState(chatKey) {
  try {
    const raw = fs.readFileSync(fileFor(chatKey), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        flutter: Number(parsed.flutter) || 0,
        shy: Number(parsed.shy) || 0,
        why: String(parsed.why || '').slice(0, 40),
        at: Number(parsed.at) || Date.now()
      };
    }
  } catch { /* 新会话或文件坏了，按空状态处理 */ }
  return emptyState();
}

function writeState(chatKey, state) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const file = fileFor(chatKey);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { log(`[heartbeat] 写盘失败：${e?.message ?? e}`); } catch { /* 日志也不该炸 */ }
  }
}

/** 指数衰减：每过一个半衰期减半。懒计算入口，不依赖任何定时器。 */
function decayed(chatKey) {
  const s = readState(chatKey);
  const { halfLifeMin } = settings();
  const elapsedMs = Math.max(0, Date.now() - s.at);
  const halfLives = elapsedMs / (halfLifeMin * 60 * 1000);
  const k = Math.pow(0.5, halfLives);
  return {
    flutter: s.flutter > 0 ? s.flutter * k : 0,
    shy: s.shy > 0 ? s.shy * k : 0,
    why: s.why,
    at: s.at
  };
}

function bpmOf(flutter, shy) {
  return Math.round(Math.min(150, BASE_BPM + flutter * 14 + shy * 10));
}

/** 把数值翻成"身体感觉"的自然语言。不出现数字以外的技术词。 */
function feelLines(flutter, shy) {
  const lines = [];
  const bpm = bpmOf(flutter, shy);
  if (flutter >= 0.35) {
    if (flutter < 1) lines.push(`心跳有点快（约 ${bpm}），比平时明显`);
    else if (flutter < 2) lines.push(`心跳快得压不住（约 ${bpm}），说话容易卡壳`);
    else lines.push(`心跳得很厉害（约 ${bpm}），胸口发紧，脑子有点空`);
  }
  if (shy >= 0.35) {
    if (shy < 1) lines.push('有点不好意思，视线想躲一下');
    else if (shy < 2) lines.push('脸在发热，不太敢直视');
    else lines.push('耳朵和脸都烧起来了，很想找句话岔开');
  }
  return lines;
}

export function setup(api) {
  cfg = api.config || (() => ({}));
  log = api.log || (() => {});
  log('[heartbeat] 心跳已加载：心动/害羞会随时间自然平复');

  api.registerTool({
    id: 'heart_beat',
    name: '心跳加速 / 心动 / 害羞',
    description:
      '记下你此刻的**身体反应**。被夸、被撩、被盯着看、被说中、被突然靠近的时候用。'
      + 'flutter 是心动程度、shy 是害羞程度，都用 0~3 的绝对档位（0=没有 1=有点 2=明显 3=很厉害），'
      + '**不是加多少**——直接写"现在有多强"，会覆盖上一次的值。'
      + '它只在**真的被戳中**时才用：普通的打招呼、讲事情、开玩笑不算。被戳中过一次之后，'
      + '不用每轮都再记一遍——它会自己慢慢平复。'
      + 'why 写一句话说明是什么让你这样的（≤20字），下一轮你自己会看到它。'
      + '注意：这是给你自己的感觉，不是台词，不要把这个调用说给群友听。',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: {
        flutter: { type: 'integer', minimum: 0, maximum: 5, description: '心动 0~3（0=平复了）' },
        shy: { type: 'integer', minimum: 0, maximum: 5, description: '害羞 0~3（0=平复了）' },
        why: { type: 'string', description: '一句话：什么让你这样（≤20字）' }
      }
    },
    execute(ctx, args) {
      try {
        const chatKey = ctx?.chatKey;
        if (!chatKey) return { content: '没有会话上下文，没记' };
        const { maxLevel } = settings();
        const clamp = (v) => Math.max(0, Math.min(maxLevel, Math.round(Number(v) || 0)));
        const flutter = clamp(args?.flutter);
        const shy = clamp(args?.shy);
        const why = String(args?.why || '').trim().slice(0, 40);
        if (!flutter && !shy) {
          // 显式归零 = 主动平复，直接清掉
          writeState(chatKey, { flutter: 0, shy: 0, why: '', at: Date.now() });
          return { content: '心跳平复了。' };
        }
        writeState(chatKey, { flutter, shy, why, at: Date.now() });
        const bpm = bpmOf(flutter, shy);
        const parts = [];
        if (flutter) parts.push(`心动 ${flutter}/${maxLevel}`);
        if (shy) parts.push(`害羞 ${shy}/${maxLevel}`);
        return { content: `记下了：${parts.join('，')}（约 ${bpm} 下/分）${why ? `，因为${why}` : ''}。大约 ${settings().halfLifeMin * 2} 分钟后会淡得差不多。` };
      } catch (e) {
        return { content: '记录失败：' + (e?.message || e) };
      }
    }
  });
}

// 每轮注入两块：
//   ① 使用说明（默认注入）—— 不注入模型就不知道有这个工具，装上等于没装
//      （inner-life 踩过这个死锁：只在有状态时注入 → 永远没状态）
//   ② 当前的身体感觉（有强度时才有）
const USAGE_GUIDE =
  '【心跳（有反应时才用）】\n'
  + '· 被夸、被撩、被盯着看、被说中、被突然靠近，**心跳会快、会脸红**——这种时候用 heartbeat__heart_beat 记一下'
  + '（flutter 心动 0~3、shy 害羞 0~3；是"现在有多强"不是"加多少"）。\n'
  + '· **只在真被戳中时用**：打招呼、讲事情、普通玩笑都不算。被戳中过一次之后不用每轮再记，它会自己慢慢平复。\n'
  + '· 感觉是给你自己的，**不要说出来**：不说"我心跳 120""我害羞了"，也不提这个工具。'
  + '让它影响语气就好——句子变短、嘴硬、岔开话题、答非所问，都比报数字真。';

export function promptSections(context = {}) {
  try {
    const s = settings();
    if (!s.enabled) return [];
    const chatKey = context?.chatKey;
    const parts = [];
    if (s.injectGuide) parts.push(USAGE_GUIDE);

    const st = chatKey ? decayed(chatKey) : { flutter: 0, shy: 0, why: '' };
    const active = st.flutter >= CALM_EPS || st.shy >= CALM_EPS;
    if (active || !s.quietWhenCalm) {
      const lines = feelLines(st.flutter, st.shy);
      if (lines.length) {
        if (st.why) lines.push(`（因为：${st.why}）`);
        parts.push(
          '【你此刻的身体反应（别报数字、别直接说出来，让它影响语气就行）】\n'
          + lines.map((l) => `· ${l}`).join('\n')
        );
      }
    }

    if (!parts.length) return [];
    return [{
      id: 'heartbeat-feel',
      title: '心跳',
      // 动态段按 priority 降序：60 > inner-life 的 50 —— 身体反应比"心绪"更即时，
      // 应该压在它前面，让模型先感到身体、再谈心事。
      priority: 60,
      content: parts.join('\n\n')
    }];
  } catch {
    return [];
  }
}
