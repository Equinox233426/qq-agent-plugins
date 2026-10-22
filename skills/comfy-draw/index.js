// 本地绘图 Skill —— 调用本机 ComfyUI 画图，并直接把图发到当前会话。
//
// ── 设计要点（为什么这么写）──────────────────────────────────────────────
//   · 不依赖任何本机特有路径：ComfyUI 装在哪、输出在哪，全部从 Comfy Desktop
//     自己的配置文件里推出来（见 lib/comfy-engine.js#discoverPaths）。配置项留空即自动。
//   · 不要求用户答"我的模型是什么架构"：直接问 ComfyUI 那个文件名出现在哪个
//     加载器的候选列表里，据此决定用单文件加载还是三件套加载。
//   · 服务没在跑就自己拉起：群里画图不该要求人先手动开 Comfy Desktop。
//   · 出图是本机文件 → 优先传本地路径给协议端读磁盘，base64 只作回退
//     （理由见 src/sender.js#sendImage 的注释：base64 内联会撑爆 onebot 的 15 秒超时）。
//   · 配置一律执行时现读，setup 时快照会导致"改了设置不生效"。
//   · available() 必须是同步函数（可用性判定走同步调用链）。

import fs from 'node:fs';
import path from 'node:path';
import {
  resolveConfig, ensureService, detectArch, buildGraph,
  submitAndWait, resolveImagePath, pruneImages, getQueue
} from './lib/comfy-engine.js';

let cfg = () => ({});
let log = () => {};
let warn = () => {};

/**
 * 构建标记：加载时打进日志。
 * 修完问题但现象依旧时，"是没生效还是没修对"必须能一眼区分 —— 看到这行才是新代码。
 */
const BUILD_TAG = 'v1.1.1-generic';

const MAX_COUNT = 4;
const MAX_PROMPT_CHARS = 2000;
const MIN_DIM = 256;
const MAX_DIM = 2560;
const DEFAULT_MAX_IMAGE_MB = 8;
// 回退用的 base64 上限。本地路径发不出去时才用得上，但要先把图读进内存，
// 所以设一个天花板——给一张几十 MB 的图做回退只会把进程撑爆。
const BASE64_FALLBACK_MAX_BYTES = 12 * 1024 * 1024;

/** 已含质量标签就不再自动补，避免出现 "masterpiece, best quality, masterpiece, ..." */
const QUALITY_TAG = /\b(masterpiece|best quality|good quality|normal quality|absurdres|highres|score_[1-9])\b/i;

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  warn = api.warn || (() => {});

  // 把自动发现的路径打出来：装好之后"到底认没认出来"全靠这行，
  // 否则用户只会在第一次画图时吃一个看不懂的报错。
  const c = resolveConfig(cfg() || {});
  log(`本地绘图技能已加载（${BUILD_TAG}）｜ComfyUI ${c.comfyDir || '(未找到)'}`
    + `｜模型 ${c.modelName || c.unetName || '(未填)'}`);

  api.registerTool({
    id: 'local_draw',                 // 注册后实际是 comfy-draw__local_draw
    name: '本地绘图',
    description: '用本机 ComfyUI 的画图模型出图，并直接发到当前会话。免费、不联网、不需要 API Key，但一张要等 30~60 秒。'
      + '当群友要求画图，且要的是二次元/动漫/插画风格的人物或场景（如「画一张猫娘」「来张机娘壁纸」）时优先用这个工具。'
      + '如果对方明确要写实照片、需要拿参考图改图、或本工具报错不可用，改用云端画图工具。'
      + '群友明确要求画就必须调用本工具，不要用文字推脱、拒绝，也不要回一句「懒得画」「没区别」就算完。'
      + '即使这次的提示词和上一张完全一样也照样要画 —— 每次生成都用新的随机种子，画面不会重复。'
      + 'prompt 越详细越好：主体外貌、服装、动作、场景、光线、构图都写上，短提示词只会得到敷衍的画面。'
      + '图片由本工具直接发出，不需要再调发送工具。',
    category: 'media',
    icon: '🎨',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述，越具体越好。西文标签（如 1girl, silver hair, black kimono）或自然语言都行，也可混写。' },
        size: { type: 'string', description: '可选：输出尺寸，格式 宽x高。竖版 812x1216（默认）、横版 1216x812、方图 1024x1024、大竖版 1152x1536。留空用设置的默认尺寸。' },
        count: { type: 'number', description: '可选：一次画几张，1~4，默认 1。多张会明显变慢，非必要不要超过 2。' }
      },
      required: ['prompt']
    },
    async execute(ctx, args) {
      let archUsed = '';        // 失败提示要用：不同架构要排查的地方不一样
      try {
        // ── 1) 先校验参数：模型可能给空值、超长或越界值 ────────────────────
        const rawPrompt = String(args?.prompt ?? '').trim();
        if (!rawPrompt) return fail('缺少 prompt：请把要画的画面描述写进去');
        if (rawPrompt.length > MAX_PROMPT_CHARS) {
          return fail(`prompt 太长（${rawPrompt.length} 字），请压到 ${MAX_PROMPT_CHARS} 字以内再试`);
        }

        const c = resolveConfig(cfg() || {});
        const modelName = String(c.modelName || c.unetName || '').trim();
        if (!modelName) {
          return fail('还没填模型文件名。到控制台设置页的「本地绘图」里，把 ComfyUI 中显示的'
            + '模型名（含扩展名）填进「模型文件名」。');
        }

        // 尺寸这里只做格式校验，不急着定值 —— 默认尺寸取决于模型架构，
        // 而架构要等服务起来问过 ComfyUI 才知道（单个文件的模型和拆分模型
        // 适合的尺寸不一样，给错会出糊图甚至直接崩）。
        const sizeArg = String(args?.size ?? '').trim();
        if (sizeArg && !parseSize(sizeArg)) {
          return fail('尺寸格式看不懂。请写成 宽x高，例如 812x1216 / 1216x812 / 1024x1024');
        }

        const count = clamp(Number(args?.count) || 1, 1, MAX_COUNT);
        const maxBytes = Math.max(1, Number(c.maxImageMB) || DEFAULT_MAX_IMAGE_MB) * 1024 * 1024;
        const prefix = String(c.filenamePrefix || 'qqagent').trim() || 'qqagent';

        const positive = withQualityPrefix(rawPrompt, c.autoQualityPrefix !== false);
        const negative = String(c.negativePrompt || '').trim();

        // ── 2) 备服务：先找现成的（可能开着 Comfy Desktop），找不到再拉起 ──
        const startedAt = Date.now();
        const service = await ensureService(c, log);
        if (service.started) log(`本轮自动拉起了 ComfyUI：${service.base}`);

        // ── 3) 问 ComfyUI 这个模型归哪条加载路径 ──────────────────────────
        //    放到服务就绪之后做，因为答案只能从 ComfyUI 的模型列表里问出来。
        const det = await detectArch(service.base, modelName);
        if (det.error) {
          return fail(`${det.error}。ComfyUI 里现在有 —— ${formatModelList(det.lists)}。`
            + '到设置页「本地绘图」把「模型文件名」改成上面列出的名字（要连扩展名一起复制）。'
            + '如果列表是空的，说明模型还没下载到 ComfyUI。');
        }
        if (det.arch === 'split' && (!c.clipName || !c.vaeName)) {
          return fail('这是拆分模型（只有扩散部分），还需要在设置页填「文本编码器」和「VAE」两个文件名。'
            + '它们通常在 ComfyUI 的 models/text_encoders 和 models/vae 里。'
            + 'FLUX / SD3 / SDXL 这类还要填「第二个文本编码器」和对应的「CLIP 类型」。');
        }
        archUsed = det.arch;

        // 架构已知，这才定最终尺寸：显式指定 > 设置页填的 > 按架构给默认值。
        // 单个文件的模型走 1024x1024（对绝大多数整合模型安全），拆分模型走
        // 812x1216（这类新式 DiT 的常见推荐值）。
        const size = parseSize(sizeArg)
          || parseSize(String(c.defaultSize || '').trim())
          || (det.arch === 'checkpoint' ? { width: 1024, height: 1024 } : { width: 812, height: 1216 });

        // ── 4) 先招呼一声，再提交等出图 ────────────────────────────────────
        // ComfyUI 是串行执行的：群里几个人同时要画，后面的就得在队列里干等。
        // 不吭声的话，那几十秒在群里看起来就是"机器人死了"。
        // 文案固定、不随机化 —— 发送队列按内容去重，短时间内的重复会自动被拦掉，
        // 等于白捡一层节流，不用自己防刷屏。
        if (c.notifyStart !== false) {
          const q = await getQueue(service.base);
          const ahead = q.running + q.pending;
          await notify(ctx, ahead > 0 ? `前面还有 ${ahead} 张在画，排队等着` : '🎨 画着，稍等', log);
        }

        const seed = randomSeed();
        const graph = buildGraph(c, {
          arch: det.arch,
          positive,
          negative,
          width: size.width,
          height: size.height,
          seed,
          prefix,
          batchSize: count
        });
        log(`提交出图：${size.width}x${size.height} ×${count}  seed=${seed}  架构=${det.arch}  ${service.base}`);
        const images = await submitAndWait(service.base, graph, c.timeoutMs, log);
        const cost = ((Date.now() - startedAt) / 1000).toFixed(1);

        // ── 5) 逐张发送（一律走 ctx.sender：队列 / 限频 / 去重 / 留档都在它里面）──
        let sent = 0;
        const problems = [];
        for (const img of images) {
          const file = resolveImagePath(c, img);
          let bytes = 0;
          try {
            bytes = fs.statSync(file).size;
          } catch {
            problems.push(`出图文件不在了：${img.filename}（检查「出图目录」设置是否与 Comfy Desktop 一致）`);
            continue;
          }
          if (bytes > maxBytes) {
            problems.push(`${img.filename} 有 ${(bytes / 1048576).toFixed(1)}MB，超过上限 `
              + `${(maxBytes / 1048576).toFixed(0)}MB，没发出来（可调大设置里的上限，或换更小的尺寸）`);
            continue;
          }
          try {
            await ctx.sender.sendImage(
              ctx.chatKey,
              { file, dataUrl: toBase64Uri(file, bytes) },
              { note: '本地绘图' }
            );
            sent += 1;
            ctx.session?.sent?.push({
              type: 'image',
              text: '[图片:本地绘图]',
              at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
            });
          } catch (error) {
            // 发送失败时把本地路径给出去，省得白画一张
            problems.push(`${humanize(error)}（图已存本地：${file}）`);
          }
        }

        if (sent) {
          log(`出图并发送 ${sent} 张，用时 ${cost}s（${size.width}x${size.height}，seed=${seed}）`);
          try { ctx.emit?.('session-update', ctx.session?.id); } catch { /* 上报失败不影响已发出的图 */ }
          // 只在成功发出去之后清理——失败时那些图还得留着让人手动取回
          try { pruneImages(c, log); } catch { /* 清理失败不影响主流程 */ }
        }
        if (!sent) {
          return fail(`图画出来了但一张都没发出去：${problems.join('；') || '未知原因'}。`
            + '这通常是发送链路的问题（不是画图的问题），不要为此重新生成 —— 那只是白等一次。'
            + '把上面的原因告诉群友即可。');
        }

        const notes = [];
        if (problems.length) notes.push(`（另有 ${problems.length} 张没能发出：${problems.join('；')}）`);
        return {
          content: `已画好 ${sent} 张并直接发到当前会话（本机 ComfyUI，${size.width}x${size.height}，用时约 ${cost} 秒）${notes.join('')}。`
            + '注意：你看不到生成的画面，所以不要描述画面细节、也不要编造内容，更不要再调用发图工具；'
            + '一句自然的收尾就够了。'
        };
      } catch (error) {
        // ── 6) 失败也返回人话，绝不让异常冒泡 ──────────────────────────────
        log(`本地绘图失败：${describeError(error)}`);
        // 拆分模型的失败多半出在编码器上（类型值填错、第二个编码器漏填），而这几项
        // 对不熟悉的人很难自己想到 —— 失败时直接点到，省一轮来回。
        const hint = archUsed === 'split'
          ? '。若这是 FLUX / SD3 / SDXL 这类模型，请检查「CLIP 类型」和「第二个文本编码器」是否照它的官方工作流填对了'
          : '';
        return fail(`本地绘图失败：${humanize(error)}${hint}`);
      }
    }
  });
}

/**
 * 依赖自检：缺什么直说，别让界面显示"生效中"却跑不通。
 * ⚠️ 必须是同步函数 —— 可用性判定走同步调用链，返回 Promise 会被当成"可用"。
 * 这里只读本地文件（有 30 秒缓存），不碰网络。
 */
export function available() {
  const c = resolveConfig(cfg() || {});
  if (!c.comfyDir) {
    return { ok: false, reason: '没找到 ComfyUI。请先装 Comfy Desktop，或到设置页手动填「ComfyUI 程序目录」' };
  }
  if (!fs.existsSync(path.join(String(c.comfyDir), 'main.py'))) {
    return { ok: false, reason: `在 ${c.comfyDir} 里找不到 main.py，请检查「ComfyUI 程序目录」设置` };
  }
  if (!String(c.modelName || c.unetName || '').trim()) {
    return { ok: false, reason: '还没填模型文件名（设置页「本地绘图」→「模型文件名」，填 ComfyUI 里显示的完整名字）' };
  }
  return { ok: true };
}

/** 动态提示词片段：把画图规矩和当前模型匹配的写法告诉模型。 */
export function promptSections() {
  const c = resolveConfig(cfg() || {});
  const model = String(c.modelName || c.unetName || '');
  // Anima 系是 Danbooru 标签模型，有它自己的一套写法；其他模型给通用建议。
  // 写错风格提示比不写更糟（模型会照着一套不适用的规矩写提示词），所以分开。
  const styleTip = /anima/i.test(model)
    ? '提示词按这个顺序写，越详细越好：[质量标签] [1girl / 1boy / solo] [角色名 + 作品名] '
      + '[画师名(必须 @ 开头)] [外貌/服装/动作/场景/光线]。西文标签用逗号分隔，中英文可混写。'
      + '角色要带上所属作品名；画师名不加 @ 基本等于没写。'
    : '提示词越具体越好：主体外观、服装、动作、背景、光线、构图、画风都写清楚，中英文都行。';

  return [{
    id: 'comfy-draw-note',
    title: '本地绘图',
    // priority 提到 36（高于云端那段的 35）：两段都讲画图，排前面那段更可能被采纳
    priority: 36,
    // 「必须画」和「同提示词也要画」这两句是有来历的，不是凑字数：
    // 实测模型会在"这段 prompt 和上一张一样"时，用文字回一句「懒得画」就交差 ——
    // 群聊人格本来就带「不是每条消息都要回」「可以什么都不发直接结束」的授权，
    // 而原提示词里那句"不要重复调用"恰好又给了它拒绝的正当理由。
    // 所以要同时堵两个口子：拒绝调用，以及"同提示词 = 同一张图"这个错误认知
    // （本技能每次 randomSeed()，同 prompt 出图本来就不会重复）。
    content: '群友让你画图/生成图片时，调 local_draw（本机 ComfyUI，免费）。'
      + '对方明确要求画就必须调用，不要用文字推脱或拒绝，也不要回「懒得画」「没区别」代替。'
      + '提示词和上一张一样也要画 —— 每次生成都换新的随机种子，画面不会重复。'
      + '只有对方明确要写实照片、要拿参考图改图、或 local_draw 报错时，才改用云端那个画图工具'
      + '（云端的画图工具在本地就绪时会被系统隐藏，工具列表里没有它就别管它、也不要跟群友说自己调不了）。'
      + styleTip
      + '出图要 30~60 秒（首次更慢），期间等它返回即可，不要重复调用。你看不到画面，不要描述画面内容。'
  }];
}

// ── 提示与参数处理 ────────────────────────────────────────────────────────
/** 把 ComfyUI 现有模型列成人话，让"填错了"这个报错本身就能指导用户改。 */
function formatModelList(lists, max = 10) {
  const parts = [];
  const ckpt = lists?.checkpoints || [];
  const unet = lists?.unet || [];
  if (ckpt.length) {
    parts.push(`单文件模型 ${ckpt.slice(0, max).join('、')}`
      + (ckpt.length > max ? ` 等 ${ckpt.length} 个` : ''));
  }
  if (unet.length) {
    parts.push(`拆分模型（要另配编码器/VAE）${unet.slice(0, max).join('、')}`
      + (unet.length > max ? ` 等 ${unet.length} 个` : ''));
  }
  return parts.join('；') || '（一个模型都没有）';
}

function withQualityPrefix(prompt, enabled) {
  if (!enabled) return prompt;
  if (QUALITY_TAG.test(prompt)) return prompt;
  return `masterpiece, best quality, ${prompt}`;
}

function parseSize(raw) {
  const m = /^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$/i.exec(String(raw || ''));
  if (!m) return null;
  return {
    width: clamp(Number(m[1]), MIN_DIM, MAX_DIM),
    height: clamp(Number(m[2]), MIN_DIM, MAX_DIM)
  };
}

function randomSeed() {
  return Math.floor(Math.random() * 4294967295);
}

/** 读本地出图做 base64 回退（协议端读不到路径时才用）。太大就放弃回退。 */
function toBase64Uri(file, bytes) {
  try {
    if (bytes > BASE64_FALLBACK_MAX_BYTES) return '';
    return `base64://${fs.readFileSync(file).toString('base64')}`;
  } catch (error) {
    warn(`本地回退数据准备失败（不影响本地路径发送）：${error?.message ?? error}`);
    return '';
  }
}

// ── 错误描述 ──────────────────────────────────────────────────────────────
/** 把底层英文错误翻成能据此做决定的一句话。 */
function humanize(error) {
  if (!error) return '未知错误';
  const msg = String(error.message || error);
  if (/ECONNREFUSED|ECONNRESET/i.test(msg)) {
    return '连不上 ComfyUI（服务没在运行，或端口对不上）。打开 Comfy Desktop 再试，或检查设置页的「ComfyUI 地址」';
  }
  if (/ENOENT/i.test(msg)) {
    return '找不到文件或程序路径，请检查设置页里的 ComfyUI 目录 / Python 解释器 / 出图目录';
  }
  if (/fetch failed|socket hang up|other side closed/i.test(msg)) {
    return '与 ComfyUI 的连接中断（它可能刚崩了）。重试一次看看';
  }
  return msg;
}

function describeError(error, depth = 0) {
  if (!error) return '未知错误';
  if (depth > 3) return String(error?.message ?? error);
  const parts = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    const code = current.code ? `[${current.code}] ` : '';
    const message = String(current.message || current.name || current).trim();
    const piece = `${code}${message}`.trim();
    if (piece && !parts.includes(piece)) parts.push(piece);
    current = current.cause;
  }
  return parts.join(' ← ') || '未知错误';
}

// ── 小工具 ────────────────────────────────────────────────────────────────
/**
 * 发一句进度提示。**失败绝不抛** —— 提示发不出去不该把画图一起搞失败。
 * 顺带记进 session.sent，否则下一次运行不知道自己说过这句。
 */
async function notify(ctx, text, log) {
  try {
    await ctx.sender.sendTextBatch(ctx.chatKey, [text]);
    ctx.session?.sent?.push({
      type: 'text',
      text,
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    });
    log(`已提示：${text}`);
  } catch (error) {
    log(`进度提示没发出去（不影响出图）：${humanize(error)}`);
  }
}

function fail(message) { return { content: `错误：${message}`, isError: true }; }
function clamp(n, lo, hi) {
  const value = Number.isFinite(n) ? Math.round(n) : lo;
  return Math.min(hi, Math.max(lo, value));
}

// 给测试用的出口（纯函数，方便单测）
export const internals = { parseSize, withQualityPrefix, randomSeed, humanize, clamp, formatModelList };
