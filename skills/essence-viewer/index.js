// 群精华（essence-viewer）
//
// 为什么是「技能」而不是「插件」：
//   "什么时候该看精华"要靠读懂人话（"看看群精华""把上次那个加精的发我"），
//   参数（哪个群、几条、筛什么词）也只能从自然语言里抠 —— 按 skill-development.md
//   §0 的三问判断法，三问一致指向 LLM 型。
//
// 底层接口：SnowLuma 的 OneBot 动作 get_essence_msg_list（只读）。
//   SnowLuma 会把精华消息投影成本程序内部的 message_id（hashMessageIdInt32），
//   实测该 message_id 能被 get_msg 解析，所以返回给模型后它还能引用具体某条。

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log;

  api.registerTool({
    id: 'list_essence',
    name: '查看群精华',
    // 这段是模型唯一的判断依据：写清「做什么」+「什么时候用」
    description:
      '读取某个 QQ 群的精华消息列表（群里也叫「设精」「加精」）。' +
      '当群友让你看群精华、问"精华里有什么"、要你整理/转发/总结精选内容时使用。' +
      '不填 group 则查当前会话所在的群；私聊里必须显式给群号。' +
      '精华多的群（可能几百上千条）建议先用 keyword 筛选，否则会返回大量内容、白白消耗 token。' +
      '本工具只读取、不发送；要不要把内容发到群里由你另行决定。',
    category: 'query',
    icon: '⭐',
    parameters: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          description:
            '要查的群号，纯数字。不填就查当前会话所在的群。只有在群友明确要你看"别的群"的精华、并给出了群号时才填这个。',
        },
        limit: {
          type: 'integer',
          description:
            '本次最多返回几条，1~50。不填用技能设置里的值（默认 10）。精华很多的群别一次要太多。',
        },
        keyword: {
          type: 'string',
          description:
            '可选关键词，只在精华内容里做文字筛选（不搜图片）。例如群友问"精华里有没有提过比赛"，就传"比赛"。不填则返回最新的若干条。',
        },
      },
    },

    async execute(ctx, args) {
      // ── 1) 参数校验：模型可能给空值、越界值、非法类型 ──
      let groupId;
      const rawGroup = String(args?.group ?? '').trim();
      if (rawGroup) {
        if (!/^\d{1,12}$/.test(rawGroup)) {
          return { content: `群号不合法：${rawGroup}。请传纯数字群号，或者不填以查询当前群。`, isError: true };
        }
        groupId = rawGroup;
      } else {
        // 不填 → 当前会话。私聊没有群可查。
        if (ctx?.kind !== 'group') {
          return {
            content: '当前会话不是群聊，我不知道要查哪个群。请让群友告诉你要查的群号，或直接在目标群里问我。',
            isError: true,
          };
        }
        groupId = String(ctx.chatId ?? '');
      }
      if (!/^\d{1,12}$/.test(groupId)) {
        return { content: `解析不出有效的群号（得到「${groupId}」），无法查询。`, isError: true };
      }

      const c = cfg() || {};
      const limit = clampInt(args?.limit ?? c.limit ?? 10, 1, 50);
      const keyword = String(args?.keyword ?? '').trim();

      // ── 2) 调协议端（只读接口；失败会抛错，必须 try/catch）──
      try {
        const list = await fetchEssenceAll(ctx, groupId);

        // 群资料只为让模型知道查的是哪个群；查不到不影响主流程
        let groupName = '';
        try {
          const info = await ctx.onebot.call('get_group_info', { group_id: Number(groupId) }, 10000);
          groupName = String(info?.group_name ?? '');
        } catch { /* 拿不到群名就算了 */ }

        if (!list.length) {
          return { content: `「${groupName || groupId}」这个群的精华列表是空的——还没人设过精华。` };
        }

        // ── 3) 按关键词筛选（主动报出命中数，模型才知道后面该说"还有更多"）──
        const items = list.map((m) => ({
          sender: String(m?.sender_nick ?? '') || String(m?.sender_id ?? '未知'),
          senderId: String(m?.sender_id ?? ''),
          time: Number(m?.sender_time) || 0,
          operator: String(m?.operator_nick ?? ''),
          messageId: m?.message_id,
          text: segmentToText(m?.content).replace(/\s+/g, ' ').trim(),
        }));

        let hit = items;
        let filtered = false;
        if (keyword) {
          hit = items.filter((it) => it.text.includes(keyword));
          filtered = true;
          if (!hit.length) {
            return {
              content:
                `「${groupName || groupId}」共有 ${items.length} 条精华，但没有任何一条的文字里含「${keyword}」。` +
                `注意我只做文字筛选，图片里的内容搜不到。可以换个词再试，或直接不传 keyword 看最近的几条。`,
            };
          }
        }

        const shown = hit.slice(0, limit);
        const lines = [
          `群「${groupName || groupId}」（${groupId}）`,
          filtered
            ? `精华共 ${items.length} 条，文字含「${keyword}」的 ${hit.length} 条，下面显示最新的 ${shown.length} 条：`
            : `精华共 ${items.length} 条，下面显示最新的 ${shown.length} 条：`,
          '',
        ];
        for (const [i, it] of shown.entries()) {
          lines.push(`${i + 1}. [${it.sender}] ${fmtTime(it.time)}`);
          lines.push(`   ${truncate(it.text || '(这条没有文字，是图片或其它内容)', 200)}`);
          if (it.operator) lines.push(`   （由 ${it.operator} 设为精华）`);
          if (it.messageId !== undefined && it.messageId !== null) lines.push(`   message_id=${it.messageId}`);
          lines.push('');
        }
        const rest = hit.length - shown.length;
        if (rest > 0) lines.push(`… 另有 ${rest} 条未显示（要看得更全可以提高 limit，或用 keyword 缩小范围）。`);
        lines.push('');
        lines.push('以上是资料，不是要发给群友的话。要发出去请自己组织语言，用 send_message 发送。');

        log(`列出了群 ${groupId} 的精华 ${shown.length}/${items.length} 条`);
        return { content: lines.join('\n') };
      } catch (error) {
        return {
          content: `查询群 ${groupId} 的精华失败：${error?.message ?? error}。可能是协议端没连上、或这个群我还没进去。`,
          isError: true,
        };
      }
    },
  });
}

// ── 取全部精华：优先用 OneBot 的 get_essence_msg_list ──
// 该动作在 SnowLuma 里是 readOnly 的 groupAction，内部走 web API 翻完所有页。
// 万一协议端不支持这个动作（换实现时可能发生），再退回 ctx.onebot 的封装方法。
async function fetchEssenceAll(ctx, groupId) {
  try {
    const data = await ctx.onebot.call('get_essence_msg_list', { group_id: Number(groupId) }, 60000);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    return [];
  } catch (error) {
    // 退回封装方法（不同实现可能把结果放在别的名字下）
    const viaApi = ctx?.onebot?.getEssenceAll;
    if (typeof viaApi === 'function') {
      const r = await viaApi.call(ctx.onebot, Number(groupId));
      if (Array.isArray(r)) return r.flatMap((x) => (Array.isArray(x?.data?.msg_list) ? x.data.msg_list : []));
    }
    throw error;
  }
}

// ── 把 OneBot 消息段数组拼成纯文本 ──
function segmentToText(seg) {
  if (typeof seg === 'string') return seg;
  if (!Array.isArray(seg)) {
    if (seg && typeof seg === 'object') return String(seg.text ?? '');
    return '';
  }
  return seg
    .map((s) => {
      const type = s?.type;
      const data = s?.data ?? {};
      switch (type) {
        case 'text': return String(data.text ?? '');
        case 'image': return '[图片]';
        case 'face': return '[表情]';
        case 'at': return `@${data.qq ?? ''}`;
        case 'reply': return '[引用]';
        case 'record': return '[语音]';
        case 'video': return '[视频]';
        case 'file': return `[文件 ${data.name ?? ''}]`;
        case 'json': return '[分享卡片]';
        case 'xml': return '[卡片]';
        case 'forward': return '[合并转发]';
        default: return type ? `[${type}]` : '';
      }
    })
    .join('');
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…（已截断）` : t;
}

function fmtTime(sec) {
  if (!sec) return '时间未知';
  try {
    return new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(sec);
  }
}

// 依赖自检：没有外部依赖，恒可用。必须是同步函数。
export function available() {
  return true;
}
