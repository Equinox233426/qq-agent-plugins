// B站搜索（bilibili-search）
//
// 为什么是「技能」而不是「插件」：按 skill-development.md §0 的三问判断法 ——
//   ① 触发时机能用 if 描述吗？ 「群友让你去B站找XX」要理解语义 → 技能
//   ② 漏触发一次代价？        只是这次没搜，下次还能搜 → 技能
//   ③ 参数从哪来？           关键词要从人话里抠（"搜个赛马娘攻略"）→ 技能
// 三问一致 → LLM 型。
//
// ⚠️ 实测结论（2026-10-05，本机直连）：
//   · search/type      不稳定（3 次里 2 次 HTTP 412 风控）
//   · wbi/search/type  稳定（3/3 成功）→ **必须走 wbi 路径**
//   · 无 referer 必被 412 → **必须带 https://www.bilibili.com/ 作 referer**
//   · duration 字段是字符串 "8:13"，不是秒数 → 要自己解析
//   · 标题含 <em class="keyword"> 高亮标签 → 要清掉再发

let cfg = () => ({});
let log = () => {};
let warn = () => {};
/** api.fetch 是能力引用：清单声明了 permissions: ["web_fetch"] 才会给。 */
let apiFetch = null;

/** 实测唯一稳定的搜索端点。别换成不带 wbi 的那个。 */
const SEARCH_API = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
/** 无 referer 会被 B 站 412，这个头是必须的（不是可选优化）。 */
const BILI_REFERER = 'https://www.bilibili.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SORTS = ['totalrank', 'click', 'pubdate', 'danmaku'];
const SORT_LABEL = { totalrank: '综合', click: '播放量', pubdate: '最新', danmaku: '弹幕数' };
const MAX_LIMIT = 10;
/** 自搜：每页 20 条，最多翻几页（越多越容易被风控）。 */
const MAX_DEEP_PAGES = 5;
/** 自搜最多用几个关键词 —— 防止配了几十个词把 B 站打爆。 */
const MAX_TERMS = 6;
/** 翻页之间的间隔：实测连打会触发 412，必须留。 */
const PAGE_GAP_MS = 1200;

export function setup(api) {
  cfg = api.config;
  log = api.log;
  warn = api.warn;
  // 清单里声明了 permissions: ["web_fetch"]，正常能拿到；拿不到就退回全局 fetch
  apiFetch = typeof api.fetch === 'function' ? api.fetch.bind(api) : null;

  api.registerTool({
    id: 'search_bilibili',
    name: '搜B站视频',
    description:
      '在 B 站搜索视频，返回标题、UP主、播放量、时长和链接。'
      + '当群友让你去 B 站找视频、问「B站有没有XX」「搜个XX的视频」「找个XX的教程」时使用。'
      + 'keyword 要提炼成搜索词（如「赛马娘 攻略」），不要把整句话丢进去。'
      + '本工具只返回结果，不会自己发到群里——是否发、怎么发由你决定（用 send_message）。'
      + '不要编造播放量或标题，一切以返回结果为准。',
    category: 'media',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '搜索关键词。尽量具体，如「赛马娘 攻略」「Vocaloid 新曲」。不要传整句话。',
        },
        limit: {
          type: 'integer',
          description: '返回几条，1~10。不填用技能设置里的值（默认 5）。',
        },
        sort: {
          type: 'string',
          enum: SORTS,
          description: '排序：totalrank=综合（默认）、click=按播放量、pubdate=按最新、danmaku=按弹幕数。群友说「最新的」就用 pubdate，「最火的」用 click。',
        },
      },
      required: ['keyword'],
    },

    async execute(ctx, args) {
      // ── 1) 参数校验 ──
      const keyword = String(args?.keyword ?? '').trim();
      if (!keyword) {
        return { content: '缺少 keyword：请给出要搜的关键词，例如「赛马娘 攻略」。', isError: true };
      }
      if (keyword.length > 60) {
        return { content: `关键词太长了（${keyword.length} 字）。请提炼成 2~6 个词的搜索词。`, isError: true };
      }
      const c = cfg() || {};
      const limit = clampInt(args?.limit ?? c.limit ?? 5, 1, MAX_LIMIT);
      const sort = SORTS.includes(String(args?.sort)) ? String(args.sort) : (SORTS.includes(String(c.sort)) ? String(c.sort) : 'totalrank');

      // 优先走 api.fetch（声明了 web_fetch 权限时可用）；没有就退回全局 fetch。
      const doFetch = apiFetch ? apiFetch : (url, opts) => fetch(url, opts);

      try {
        const res = await fetchSearchPage(doFetch, keyword, 1, sort);

        // 412 = B站风控（请求太频或没带 referer）。要给模型看得懂的话，便于它改说辞。
        if (res.error === '412') {
          return {
            content: 'B 站风控拦截了这次搜索（HTTP 412）。通常是短时间内搜太多次。'
              + '过一会儿再试；如果反复出现，就先别搜了，直接跟群友说搜不到。',
            isError: true,
          };
        }
        if (res.error) {
          return { content: `B 站搜索失败：${res.error}`, isError: true };
        }

        const list = res.list;
        if (!list.length) {
          return { content: `B 站没搜到「${keyword}」相关的视频。可以换个说法再试，或者告诉群友没找到。` };
        }

        const total = res.total || list.length;
        const lines = [
          `B 站搜索「${keyword}」（${SORT_LABEL[sort]}排序，共约 ${total} 个结果，下面是前 ${Math.min(limit, list.length)} 个）：`,
          '',
        ];
        for (const [i, it] of list.slice(0, limit).entries()) {
          const title = cleanTitle(it.title);
          const author = String(it.author ?? '').trim() || '未知UP';
          const play = fmtCount(it.play);
          const dur = normalizeDuration(it.duration);
          const bvid = String(it.bvid ?? '').trim();
          const link = bvid ? `https://www.bilibili.com/video/${bvid}` : String(it.arcurl ?? '').trim();
          const date = fmtDate(it.pubdate);
          lines.push(`${i + 1}. ${title}`);
          lines.push(`   UP：${author}　播放：${play}　时长：${dur}　发布：${date}`);
          if (link) lines.push(`   ${link}`);
          lines.push('');
        }
        lines.push('以上是搜索结果，不是要发给群友的话。要发出去请自己组织语言（清掉标题里的【】等标记），用 send_message 发送。');

        log(`搜到「${keyword}」${list.length} 条，返回 ${Math.min(limit, list.length)} 条`);
        return { content: lines.join('\n') };
      } catch (error) {
        const code = error?.cause?.code || error?.code;
        const hint = code === 'UND_ERR_CONNECT_TIMEOUT' ? '（连不上 B 站，可能是网络问题）' : '';
        return { content: `搜索 B 站失败：${error?.message ?? error}${hint}`, isError: true };
      }
    },
  });

  // ── 工具 2：高强度自搜 ──────────────────────────────────────────────────
  // 与上面那个的区别：搜的是"关于机器人自己"的一组关键词，并且**翻多页**去重合并。
  // 实测（2026-10-05）：4 个关键词 × 3 页 = 12 次请求、去重后 183 条、约 31 秒、0 次风控。
  // 页与页之间必须留间隔 —— 连续快打会触发 412（我在调试时撞到过）。
  api.registerTool({
    id: 'self_search',
    name: '自搜B站',
    description:
      '高强度搜索 B 站上「关于机器人自己」的视频：同时搜多个自己的关键词（大肥鱼 / DeepSeek娘 / 小鲸鱼 等）、'
      + '翻多页、去重后按播放量排序，一次尽量找全。'
      + '当群友说「自搜」「看看有没有人提到你」「B 站上有没有你的视频」「你火不火」时使用。'
      + '比 search_bilibili 慢（可能十几到几十秒）但更全。'
      + '关键词可在技能设置里改（selfSearchTerms）；本工具只读，不会自己发到群里。',
    category: 'media',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        pages: {
          type: 'integer',
          description: '每个关键词翻几页（每页 20 条），1~5。不填用技能设置里的值（默认 3）。页数越多越全，也越慢、越容易被 B 站风控。',
        },
        limit: {
          type: 'integer',
          description: '最终返回几条（按播放量从高到低），1~15。不填默认 10。',
        },
        terms: {
          type: 'string',
          description: '可选：临时改用别的关键词，逗号隔开。不填就用设置里的自搜关键词。',
        },
      },
    },

    async execute(ctx, args) {
      const c = cfg() || {};
      const pages = clampInt(args?.pages ?? c.deepPages ?? 3, 1, MAX_DEEP_PAGES);
      const limit = clampInt(args?.limit ?? 10, 1, 15);
      const terms = String(args?.terms ?? c.selfSearchTerms ?? '')
        .split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_TERMS);
      if (!terms.length) {
        return { content: '没有可用的自搜关键词。请在技能设置里填写 selfSearchTerms，或调用时传 terms。', isError: true };
      }

      const doFetch = apiFetch ? apiFetch : (url, opts) => fetch(url, opts);
      const t0 = Date.now();
      const found = new Map();
      let requests = 0;
      let blocked = 0;
      const perTerm = [];

      try {
        for (const term of terms) {
          let got = 0;
          let total = 0;
          for (let page = 1; page <= pages; page++) {
            const res = await fetchSearchPage(doFetch, term, page, 'totalrank');
            requests++;
            if (res.error) {
              if (res.error === '412') { blocked++; break; }   // 风控了就别硬撞，换下一个词
              break;
            }
            if (page === 1) total = res.total;
            for (const it of res.list) {
              const bvid = String(it?.bvid ?? '').trim();
              if (!bvid || found.has(bvid)) continue;
              found.set(bvid, {
                bvid,
                term,
                title: cleanTitle(it.title),
                author: String(it.author ?? '').trim() || '未知UP',
                playNum: Number(it.play) || 0,
                play: fmtCount(it.play),
                dur: normalizeDuration(it.duration),
                date: fmtDate(it.pubdate),
              });
              got++;
            }
            if (res.list.length < 20) break;                  // 已经到底了
            // ⚠️ 必须留间隔：连打会触发 412（实测）
            if (page < pages) await sleep(PAGE_GAP_MS + Math.random() * 800);
          }
          perTerm.push({ term, got, total });
        }

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        if (!found.size) {
          const why = blocked ? '（B 站风控了，过一会儿再试）' : '';
          return { content: `自搜没找到任何关于自己的视频${why}。搜过的词：${terms.join('、')}`, isError: true };
        }

        const arr = [...found.values()].sort((a, b) => b.playNum - a.playNum);
        const lines = [
          `自搜完成：搜了 ${terms.length} 个词 × 最多 ${pages} 页（${requests} 次请求，${elapsed} 秒）`,
          `去重后共 ${arr.length} 条关于自己的视频，下面按播放量排前 ${Math.min(limit, arr.length)} 条：`,
          '',
        ];
        for (const [i, v] of arr.slice(0, limit).entries()) {
          lines.push(`${i + 1}. 【${v.play} 播放】${v.title}`);
          lines.push(`   UP：${v.author}　时长：${v.dur}　发布：${v.date}`);
          lines.push(`   https://www.bilibili.com/video/${v.bvid}`);
          lines.push('');
        }
        if (blocked) lines.push(`（有 ${blocked} 个关键词被 B 站风控跳过，下次可能搜到更多）`);
        lines.push(`各词命中：${perTerm.map((x) => `${x.term}→${x.got} 新`).join('、')}`);
        lines.push('');
        lines.push('以上是资料，不是要发给群友的话。要发出去请自己组织语言，用 send_message 发送。');

        log(`自搜完成：${arr.length} 条，返回 ${Math.min(limit, arr.length)} 条，耗时 ${elapsed}s，风控 ${blocked}`);
        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `自搜失败：${error?.message ?? error}`, isError: true };
      }
    },
  });
}

/**
 * 抓一页搜索结果。两个工具共用。
 * 返回 { list, total } 或 { error }（error 为 '412' 表示风控）。
 */
async function fetchSearchPage(doFetch, keyword, page, order) {
  const url = `${SEARCH_API}?search_type=video&keyword=${encodeURIComponent(keyword)}`
    + `&page=${page}&order=${encodeURIComponent(order)}`;
  let res;
  try {
    res = await doFetch(url, {
      headers: { 'user-agent': UA, referer: BILI_REFERER },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { error: e?.cause?.code || e?.message || 'network' };
  }
  if (res.status === 412) return { error: '412' };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0) {
    return { error: String(json?.code) === '-412' ? '412' : `code=${json?.code ?? '未知'}` };
  }
  return {
    list: Array.isArray(json?.data?.result) ? json.data.result : [],
    total: Number(json?.data?.numResults) || 0,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 工具函数 ──

/** 标题清污：去掉 <em> 高亮、HTML 实体，压平空白。 */
function cleanTitle(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')          // <em class="keyword">…</em>
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * duration 的实际形态是字符串 "8:13" 或 "1:02:33"，不是秒数。
 * （实测确认；把它当数字用会得到 NaN。）
 */
function normalizeDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return fmtSeconds(v);
  const s = String(v ?? '').trim();
  if (!s) return '未知';
  if (/^\d+$/.test(s)) return fmtSeconds(Number(s));
  // "8:13" / "01:02:33"
  const parts = s.split(':').map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n))) return s;
  const total = parts.reduce((acc, n) => acc * 60 + n, 0);
  return fmtSeconds(total);
}

function fmtSeconds(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${ss}秒`;
  return `${ss}秒`;
}

/** B站给的是中文计数（"1.2万"）或数字，统一成好读的形态。 */
function fmtCount(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
    if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
    return String(v);
  }
  const s = String(v ?? '').trim();
  return s || '未知';
}

function fmtDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '未知';
  try {
    return new Date(n * 1000).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return '未知';
  }
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** 可用性：不需要外部依赖，恒可用。必须同步。 */
export function available() {
  return true;
}
