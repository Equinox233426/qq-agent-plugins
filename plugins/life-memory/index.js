// life-memory —— 生活事件记忆
//
// 给角色一个"生活事件"存储，补上"人设里的生活线"缺的记忆层：
//   · 当天的小事（吃了什么、去了哪）记一天，隔天自动淡忘
//   · 进行中的大事（稿子卡住、跟人闹了别扭还没和好）一直记到 life_done 结束
// 与宿主自带的"对某人的印象"记忆完全独立，互不挤占。
//
// 设计要点（防 bug）：
//   · 所有 IO 用 try/catch 包裹，失败只降级不抛错
//   · 原子写入（tmp + rename）；容量上限 + 过期清理
//   · 注入提示词极短，只在有"进行中的事"时才注入
//
// 默认每轮自动注入使用说明 → 装上即可用；也可以关掉 injectGuide、把人设指令写进角色卡
// （包内 README.md 里有现成的「建议人设片段」可抄）。
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
// ⚠️ 子模块必须用「带时间戳的动态 import」加载（2026-10-05 踩的坑）：
//    plugin-loader.js:305 只给插件入口加了 `?t=` 强制刷新，入口里静态 import 的子模块
//    仍被 Node 的 ESM 缓存锁住 —— "改了 lib/ 下的文件、reload 后还是旧代码"，而且测试
//    直接读文件会全绿，极难发现。这里自己加时间戳，让 lib 的改动也能热重载。
const { createStore } = await import(`./lib/store.js?t=${Date.now()}`);

let cfg = () => ({});
let log = () => {};
let store = null;

function getStore() {
  if (!store) {
    store = createStore(path.join(DATA_DIR, 'life-events'), () => ({
      ttlHours: Number(cfg().smallTtlHours) > 0 ? Number(cfg().smallTtlHours) : 24,
      ongoingTtlHours: Number(cfg().ongoingTtlHours) > 0 ? Number(cfg().ongoingTtlHours) : 168,
      maxEvents: Number(cfg().maxEvents) > 0 ? Number(cfg().maxEvents) : 60
    }));
  }
  return store;
}

export function setup(api) {
  cfg = api.config || (() => ({}));
  log = api.log || (() => {});
  log('[life-memory] 生活事件记忆已加载');

  api.registerTool({
    id: 'life_note',
    name: '记录生活事件',
    description:
      '记一条你自己的生活事件，比如"今天中午煮了面""在等一个快递""写的东西卡住了""昨天出门走了很久"。'
      + '正在进行、还没结束的事，把 ongoing 传 true（系统会一直帮你记到结束）；已经过去的小事不用传 ongoing。'
      + '跨多轮想接上自己的生活时用它，别光靠脑子记。',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '事件内容，简短一点（≤60 字）' },
        ongoing: { type: 'boolean', description: '是不是"正在进行中"的事，默认 false' }
      },
      required: ['content']
    },
    execute(ctx, args) {
      try {
        const text = String(args?.content || '').trim().slice(0, 120);
        if (!text) return { content: '内容为空，没记' };
        if (!ctx?.chatKey) return { content: '没有会话上下文，没记' };
        const s = getStore();
        const events = s.prune(s.readEvents(ctx.chatKey));
        const ongoing = !!args?.ongoing;
        const now = Date.now();
        // 去重：近重复就续期（刷新 touchedAt），不新增一条 —— 对齐"再次触发才忘记"
        const existing = events.find((e) => s.isSameEvent(e.text, text));
        if (existing) {
          existing.touchedAt = now;
          existing.ongoing = existing.ongoing || ongoing;
          if (s.normalizeText(text).length > s.normalizeText(existing.text).length) existing.text = text;
          s.writeEvents(ctx.chatKey, events);
          return { content: `这条之前记过，续期了：${existing.text}${existing.ongoing ? '（进行中）' : ''}` };
        }
        events.push({
          id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
          at: now,
          touchedAt: now,
          text,
          ongoing
        });
        s.writeEvents(ctx.chatKey, events);
        return { content: `已记下：${text}${ongoing ? '（进行中）' : ''}` };
      } catch (e) {
        return { content: '记录失败：' + (e?.message || e) };
      }
    }
  });

  api.registerTool({
    id: 'life_recall',
    name: '回忆生活事件',
    description:
      '回忆自己最近的生活事件：正在进行的事 + 今天（按设置的小时数内）的小事。'
      + '当你想接上"我之前说过在做什么/在等什么"时用它，别凭空猜。',
    category: 'memory',
    parameters: { type: 'object', properties: {} },
    execute(ctx) {
      try {
        if (!ctx?.chatKey) return { content: '没有会话上下文' };
        const s = getStore();
        const events = s.prune(s.readEvents(ctx.chatKey));
        const now = Date.now();
        const ttlHours = Number(cfg().smallTtlHours) > 0 ? Number(cfg().smallTtlHours) : 24;
        const ttl = ttlHours * 3600 * 1000;
        const ongoing = events.filter((e) => e?.ongoing);
        const recent = events.filter((e) => !e?.ongoing && (now - (Number(e?.touchedAt) || Number(e?.at) || 0)) <= ttl);
        if (!ongoing.length && !recent.length) {
          return { content: '近期没记生活事件（或都过期了）' };
        }
        const parts = [];
        if (ongoing.length) parts.push('进行中的事：' + ongoing.map((e) => e.text).join('；'));
        if (recent.length) parts.push('今天的小事：' + recent.map((e) => e.text).join('；'));
        return { content: parts.join('\n') };
      } catch (e) {
        return { content: '回忆失败：' + (e?.message || e) };
      }
    }
  });

  api.registerTool({
    id: 'life_done',
    name: '结束进行中的事',
    description:
      '把一条"进行中"的生活事件标记为结束。传 content 关键词，匹配 content 里包含这个词的进行中事件。'
      + '比如"稿子写完了"，就用 life_done 结束"写稿卡住了"。',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要结束的事件关键词' }
      },
      required: ['content']
    },
    execute(ctx, args) {
      try {
        const kw = String(args?.content || '').trim();
        if (!kw) return { content: '没给关键词' };
        if (!ctx?.chatKey) return { content: '没有会话上下文' };
        const s = getStore();
        const events = s.readEvents(ctx.chatKey);
        let done = 0;
        for (const e of events) {
          if (e?.ongoing && String(e.text || '').includes(kw)) {
            e.ongoing = false;
            e.endedAt = Date.now();
            done++;
          }
        }
        s.writeEvents(ctx.chatKey, s.prune(events));
        return { content: done ? `已结束 ${done} 条进行中的事` : `没找到包含「${kw}」的进行中的事` };
      } catch (e) {
        return { content: '结束失败：' + (e?.message || e) };
      }
    }
  });

  api.registerTool({
    id: 'life_plan',
    name: '规划今天的生活',
    description:
      '记下今天大致要做什么。每天第一次上线时用它记一下（不用很详细，两三件事就够）。'
      + '可以参考：今天天气、你手头进行中的事、你此刻的心绪。'
      + '偶尔可以有一件突发的小事（不是每天都有），比如"有人来要联系方式""有点感冒""和朋友闹了点小别扭"。',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: {
        day: { type: 'string', description: '今天大致做什么，一两行说清（如"上午写稿，下午去买点东西，傍晚江边走"）' },
        twist: { type: 'string', description: '今天有没有突发的小事（偶尔有，不是每天，没有就留空不传）。参考类型：社交（有人来要联系方式、遇到熟人）、身体（感冒、没睡好、扭到脚）、人际（和朋友小别扭、邻居念叨）、生活（快递出问题、猫闯祸、丢东西）、心情（突然想通、有点emo、心情很好）' },
        weather: { type: 'string', description: '今天天气（可查天气后填，影响出不出门），可留空' }
      },
      required: ['day']
    },
    execute(ctx, args) {
      try {
        const day = String(args?.day || '').trim().slice(0, 200);
        if (!day) return { content: '没写内容，没记' };
        if (!ctx?.chatKey) return { content: '没有会话上下文，没记' };
        const plan = {
          date: Date.now(),
          day,
          twist: String(args?.twist || '').trim().slice(0, 80),
          weather: String(args?.weather || '').trim().slice(0, 40)
        };
        getStore().writePlan(ctx.chatKey, plan);
        return { content: `已记下今天的规划：${day}${plan.twist ? `（偶发：${plan.twist}）` : ''}` };
      } catch (e) {
        return { content: '规划失败：' + (e?.message || e) };
      }
    }
  });
}

// 每轮注入的两块内容：
//   ① 使用说明（默认无条件注入）—— 让"装上就能用"，不必再去改人设卡
//   ② 进行中的事（有才注入）
//
// 2026-10-03 补：原来只在"有进行中的事"时注入，对新装用户是**死锁**（模型不知道有这工具
// 就不会记，不记就永远没有"进行中的事"，于是永远不注入）。改成默认无条件带上使用说明；
// 已经把人设指令写进角色卡的用户，把 injectGuide 关掉即可。
const USAGE_GUIDE =
  '【生活事件记忆（你自己的日子）】\n'
  + '· 每天第一次上线，先花一点时间用 life-memory__life_plan 记下今天大致做什么'
  + '（参考：今天天气、你手头进行中的事、你此刻的心绪；偶尔可以有一件突发的小事，不是每天都有）。\n'
  + '· 遇到"正在进行、还没结束"的事（在等一个快递、东西写卡住了、跟谁还没和好），'
  + '当场用 life-memory__life_note 传 ongoing=true 记下 —— 记了才跨多轮跨天接得上；'
  + '结束了用 life-memory__life_done 收掉。\n'
  + '· 当天的小事（吃了什么、去了哪、买了什么）可以顺手记一条（只记一天就淡忘），不必每件都记。\n'
  + '· 想接上"我之前在做什么、在等什么"，用 life-memory__life_recall 查，别凭空猜。\n'
  + '· 别把机制当话题：不说"我刚记了生活事件"这类话。';

/** 判断时间戳是不是"今天"（按本地日期，镇江=北京时间）。 */
function isToday(ts) {
  const d = new Date(Number(ts) || 0);
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
}

/** 每轮注入：使用说明 + 进行中的生活事件 + 今天做过的事。 */
export function promptSections(context = {}) {
  try {
    if (cfg().enabled === false) return [];
    const chatKey = context?.chatKey;
    if (!chatKey) return [];
    const events = getStore().prune(getStore().readEvents(chatKey));
    const ongoing = events.filter((e) => e?.ongoing).slice(0, 3);
    // ⚠️ 2026-10-05：当天的小事也要注入 —— 否则她回答"今天做了什么"时看不到自己干过什么，
    // 会凭空答、和自己记录矛盾（实测 18:59 记了"傍晚去江边走"，20:24 却答"没出门"）。
    const today = events.filter((e) => !e?.ongoing && isToday(e?.at)).slice(0, 5);
    const plan = getStore().readPlan(chatKey);
    const todayPlan = (plan && isToday(plan.date)) ? plan : null;
    const guide = cfg().injectGuide !== false;
    if (!guide && !ongoing.length && !today.length && !todayPlan) return [];
    const parts = [];
    if (guide) parts.push(USAGE_GUIDE);
    // ⚠️ injectGuide 关掉时（=人设里已经写了指令的老用户）保持 1.0.0 的原始注入文案，一字不改。
    if (ongoing.length) {
      parts.push(guide
        ? '【你正在进行中的生活事件（还没结束，聊到相关话题要接着它，别当成已经过去）】\n' + ongoing.map((e) => `· ${e.text}`).join('\n')
        : '你正在进行中的生活事件（还没结束，聊到相关话题要接着它，别当成已经过去）：' + ongoing.map((e) => e.text).join('；') + '。');
    }
    if (today.length) {
      parts.push(guide
        ? '【你今天做过的事（他问"今天干了什么""出门没""吃没吃"这类，一律以这里为准；这里没写的别编，就说没干或不确定）】\n' + today.map((e) => `· ${e.text}`).join('\n')
        : '你今天做过的事（他问到就以此为准，没写的别编）：' + today.map((e) => e.text).join('；') + '。');
    }
    if (todayPlan) {
      const planLine = `· ${todayPlan.day}` + (todayPlan.weather ? `\n· 天气：${todayPlan.weather}` : '') + (todayPlan.twist ? `\n· 偶发：${todayPlan.twist}` : '');
      parts.push(guide
        ? '【你今天的生活规划（他问"今天打算做什么""今天怎么样"时以这个为底；实际做没做、有没有变化，用 life_note 记实际发生的）】\n' + planLine
        : '你今天的生活规划：' + todayPlan.day + (todayPlan.twist ? `；偶发：${todayPlan.twist}` : '') + '。');
    } else {
      // ⚠️ 今天还没规划 → 每轮都强制提醒，直到她规划（不能等"她懒了"再补，先扼杀在摇篮）
      parts.push(guide
        ? '【今天还没规划】今天是新的一天，你还没规划今天。现在就用 life_plan 记下今天大致做什么'
          + '（参考：今天天气、你手头进行中的事、你此刻的心绪；偶尔可以有一件突发的小事，不是每天都有）。规划完再回他。'
        : '今天还没规划：先用 life_plan 记下今天大致做什么。');
    }
    return [{
      id: 'life-memory-ongoing',
      title: guide ? '生活事件记忆' : '进行中的生活',
      priority: 45,
      content: parts.join('\n\n')
    }];
  } catch {
    return [];
  }
}
