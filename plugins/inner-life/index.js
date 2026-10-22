// inner-life —— 内心生活
//
// 给角色一个跨轮延续的"内心"：情绪基调 + 还没想完、挂在心里的话题。
//
// 为什么需要它：
//   这类宿主是事件驱动、无状态的桥接程序：每次运行结束，它的思考就消散了，
//   下次只能从聊天记录里重新推理"我是谁"。注意力被最新消息抓走，话题不会自己接回去。
//   本插件给它一根"接力棒"：上一轮结束前用 mind_note 记下心绪，
//   下一轮 prompt 注入【你此刻的心绪】，它接着自己上一次的状态活。
//   这模拟不出"它一直在想"，但能让它**看起来有连续内心**。
//
// 设计要点（防 bug，同 life-memory）：
//   · 所有 IO 用 try/catch 包裹，失败只降级不抛错
//   · 原子写入（tmp + rename）；TTL（心事 12h / 情绪 24h）+ 容量上限（3 件心事）
//   · 注入极短，没有心绪时不注入（不加 token）
//   · 近重复合并：同一件事换个说法只算一件（见 lib/store.js 的 isSameTopic）
//
// 默认每轮自动注入使用说明 → 装上即可用；也可以关掉 injectGuide、把人设指令写进角色卡
// （包内 README.md 里有现成的「建议人设片段」可抄）。
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { createStore, isSameTopic, mergeTopics, normalizeTopic } from './lib/store.js';

let cfg = () => ({});
let log = () => {};
let store = null;

function getStore() {
  if (!store) {
    store = createStore(path.join(DATA_DIR, 'inner-life'), () => ({
      topicTtlHours: Number(cfg().topicTtlHours) > 0 ? Number(cfg().topicTtlHours) : 12,
      moodTtlHours: Number(cfg().moodTtlHours) > 0 ? Number(cfg().moodTtlHours) : 24,
      maxTopics: Number(cfg().maxTopics) > 0 ? Number(cfg().maxTopics) : 3
    }));
  }
  return store;
}

export function setup(api) {
  cfg = api.config || (() => ({}));
  log = api.log || (() => {});
  log('[inner-life] 内心生活已加载');

  api.registerTool({
    id: 'mind_note',
    name: '记下此刻的心绪',
    description:
      '记下你此刻的心绪——这是你跨轮延续的"自己"。mood 是现在的情绪（一句短话，写你真实的情绪）；'
      + 'topics 是还挂在心里、没想完的话题（每条一句话，最多 3 条）。'
      + '**挂心事只挂真没想完的**：在等的一件事、要说的话、没解开的情绪（**也要有你自己的，不只是他的**）。'
      + '随口起的玩笑、玩过的梗、打趣过的待办（"等他回来吹""明天跟他算账"）**不算心事，别往上挂**——'
      + '挂了它每一轮都会回来找你，一个梗被你反复提，反而变假。'
      + '**只在真的变了、或有新的事挂上来时才记**：心绪还是刚才那样、也没有新心事，就不记——'
      + '同一件事换个说法也算同一件（记了也只会刷新时间），翻来覆去记同一件事会变成回音。'
      + '每次运行结束、finish 之前过一遍：有变化就记，没变化就直接结束。'
      + '想通/结束了的话题，用 mind_settle 清掉，别永远背着。',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: {
        mood: { type: 'string', description: '现在的情绪，一句短话（≤20字），写真实的。没变化可以不传。' },
        topics: {
          type: 'array',
          description: '新增的、还挂在心里没想完的话题（每条≤30字，≤3条）。已经记过的不必重复传。',
          items: { type: 'string' }
        }
      }
    },
    execute(ctx, args) {
      try {
        if (!ctx?.chatKey) return { content: '没有会话上下文，没记' };
        const s = getStore();
        const state = s.prune(s.read(ctx.chatKey));
        if (typeof args?.mood === 'string' && args.mood.trim()) {
          state.mood = String(args.mood).trim().slice(0, 40);
          state.moodAt = Date.now();
        }
        let added = 0;
        let touched = 0;
        if (Array.isArray(args?.topics)) {
          for (const raw of args.topics) {
            const text = String(raw || '').trim().slice(0, 60);
            if (!text) continue;
            // 同一件事换个说法又记一次 → 只续期（刷新 touchedAt），不留第二份。
            const hit = state.topics.find((t) => isSameTopic(t?.text, text));
            if (hit) {
              if (normalizeTopic(text).length > normalizeTopic(hit.text).length) hit.text = text;
              hit.touchedAt = Date.now();
              touched++;
              continue;
            }
            state.topics.push({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              text,
              at: Date.now(),
              touchedAt: Date.now()
            });
            added++;
          }
        }
        state.topics = mergeTopics(state.topics);   // 存量数据也可能带重复，一并归一
        state.updatedAt = Date.now();
        const saved = s.prune(state);
        s.write(ctx.chatKey, saved);
        const list = saved.topics.length ? `；挂着的事：${saved.topics.map((t) => t.text).join('；')}` : '';
        const tail = added === 0 && touched > 0 ? '（同一件事，只更新了时间，没多记）' : '';
        return { content: `已记下心绪${saved.mood ? `：${saved.mood}` : ''}${list}${tail}` };
      } catch (e) {
        return { content: '记录失败：' + (e?.message || e) };
      }
    }
  });

  api.registerTool({
    id: 'mind_settle',
    name: '想通了，放下心事',
    description:
      '放下想通了/结束了的心绪话题：传 keyword 匹配话题里包含这个词的；不传就全部放下。'
      + '比如想通了某件一直挂着的事，就 mind_settle 传 keyword=那件事的关键词。也可以顺手更新 mood。',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '要放下的话题关键词；不传 = 放下全部挂着的事' },
        mood: { type: 'string', description: '想通后现在的情绪（可选）' }
      }
    },
    execute(ctx, args) {
      try {
        if (!ctx?.chatKey) return { content: '没有会话上下文' };
        const s = getStore();
        const state = s.prune(s.read(ctx.chatKey));
        const kw = String(args?.keyword || '').trim();
        let removed = 0;
        if (kw) {
          // 归一化匹配：传关键词的一部分也能命中（标点、前缀不再挡路），
          // 比如传「煮粥」能命中「说好明天煮粥时喂猫」。
          const nk = normalizeTopic(kw) || kw;
          state.topics = state.topics.filter((t) => {
            const nt = normalizeTopic(t?.text);
            if (nt && (nt.includes(nk) || nk.includes(nt))) { removed++; return false; }
            return true;
          });
        } else {
          removed = state.topics.length;
          state.topics = [];
        }
        if (typeof args?.mood === 'string' && args.mood.trim()) {
          state.mood = String(args.mood).trim().slice(0, 40);
          state.moodAt = Date.now();
        }
        state.updatedAt = Date.now();
        s.write(ctx.chatKey, s.prune(state));
        return { content: removed ? `已放下 ${removed} 件心事` : `没找到包含「${kw}」的心事` };
      } catch (e) {
        return { content: '放下失败：' + (e?.message || e) };
      }
    }
  });
}

// 每轮注入的两块内容：
//   ① 使用说明（默认无条件注入）—— 让"装上就能用"，不必再去改人设卡
//   ② 上一轮记下的心绪（有心绪时才有）
//
// 2026-10-03 补：原来只在"有心绪时"注入，对新装的用户是个**死锁** ——
// 模型不知道有这个工具就不会记，不记就永远没心绪，没心绪就永远不注入。
// 所以改成默认无条件带上使用说明；已经把人设指令写进角色卡的用户，
// 把 injectGuide 关掉即可（免得两份指令重复占 token）。
const USAGE_GUIDE =
  '【内心生活（每轮收尾做一次）】\n'
  + '· 这一轮说完、准备结束前过一遍：情绪或者心事有变化，就用 inner-life__mind_note 记一次'
  + '（情绪一句 + 还没想完的事）；什么变化都没有就直接结束，别硬记。\n'
  + '· **挂心事只挂真没想完的**（在等的事、要说的话、没解开的情绪）：随口起的玩笑、玩过的梗、'
  + '打趣过的待办不算心事，别往上挂——挂了它每轮都会回来找你，一个梗被你反复提就变假了。\n'
  + '· 想通的事、结束的话题，用 inner-life__mind_settle 放下。\n'
  // ⚠️ 2026-10-04 加：只引导"记心事"不够，实测她的心事全被"关于他的事"占满
  //    （mood="他醒了说想我"、topic="等公公的检查结果"），属于她自己的内心冲突没位置。
  + '· **心事里有你自己的那一份**：别只挂"关于他的事"（他吃了没、几点睡、今天干了什么）——'
  + '那叫关心他，不叫你有心事。你自己的烦恼（稿子卡住、跟人置气、睡不好、天气闷）'
  + '和你自己的疑问（你到底是什么、会不会变、想不想得通）**也算心事，也该挂**。'
  + '**心绪里至少留一件是你自己的。**\n'
  + '· **想不通就直说想不通**，别急着给自己一个答案，也不用装通透。\n'
  + '· 你读到的心绪是上一轮你自己记下的——先感受此刻真实的自己，还是这样才接着它，变了就更新。\n'
  + '· 别把机制当话题：不说"我在记心绪""心绪刷新了"这类话。';

/** 每轮注入：使用说明 + 上一轮的心绪。 */
export function promptSections(context = {}) {
  try {
    if (cfg().enabled === false) return [];
    const chatKey = context?.chatKey;
    if (!chatKey) return [];
    const state = getStore().prune(getStore().read(chatKey));
    const guide = cfg().injectGuide !== false;
    const hasHeart = Boolean(state.mood || state.topics.length);
    if (!guide && !hasHeart) return [];
    const parts = [];
    if (guide) parts.push(USAGE_GUIDE);
    if (hasHeart) {
      const lines = [];
      if (state.mood) lines.push(`· 情绪：${state.mood}`);
      if (state.topics.length) {
        lines.push('· 还没想完、挂在心里的事：');
        for (const t of state.topics) lines.push(`  - ${t.text}`);
      }
      // ⚠️ injectGuide 关掉时（=人设里已经写了指令的老用户）**一字不改地保持 1.0.0 的原始注入文案**。
      // 那些用户是照着这套文案调好的，换掉等于动了他们的效果 —— 通用化不能以改变老用户行为为代价。
      parts.push(guide
        ? '【你此刻的心绪（上一轮你自己记下的）】\n' + lines.join('\n')
        : '（这是上一轮结束时你自己记下的。**先感受此刻真实的自己**：现在还是这样，就接着它；已经变了，就用 mind_note 更新；想通了，就用 mind_settle 放下。别让上一轮的情绪绑住现在的你）\n' + lines.join('\n'));
    }
    return [{
      id: 'inner-life-heart',
      title: guide ? '内心生活' : '你此刻的心绪',
      // 动态段按 priority 降序排（大的在前）：50 > life-memory 的 45，
      // 让"你是谁/你在想什么"排在"进行中的生活"之前。
      priority: 50,
      content: parts.join('\n\n')
    }];
  } catch {
    return [];
  }
}
