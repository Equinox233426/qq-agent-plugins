// 画图委派（image-delegate）—— 把画图需求外包给别的模型，主模型一个字都不动。
//
// ── 0.4.0 的思路：不再让你重填 URL 和 Key ────────────────────────────────
// 接口来源只有一个：**软件里已经接好的那些**。
//   · config.providers[]  —— 「设置 → 模型 API（模型管理）」里加过的提供商与模型
//   · config.api          —— 主模型那套（baseUrl / Key / model）
// 本技能把它们读出来，挑出"看起来是画图模型"的，按顺序组成接力链，
// 逐个调用。你不需要在本技能里再填一遍地址和密钥 —— 那些只在软件里维护一份。
//
// 为什么要 import 本体的 src/config.js 和 src/providers.js（而不是自己读 config.json）：
//   · 数据目录可能是安装目录/data、项目/data、data-2（多开）、或 QQ_AGENT_DATA_DIR 指定的
//     —— 自己拼路径必然漏掉某一种；本体模块自己会算对。
//   · 提供商的 Key 已经从 providers[] 挪到了 config.dshProviderKeys[providerId]，
//     currentProviders() 会把真实 Key 解出来；自己读原始配置只会拿到掩码。
// 相对路径 `../../src/...` 是相对**本文件**解析的（技能在 <app>/skills/<id>/），
// 因此和 app 装在哪儿无关。读不到时不做哑失败：报错里会写清原因，见 §补充接口。
//
// ── 三件事 ──────────────────────────────────────────────────────────────
//   ① 自动发现：从已接入的接口里认画图模型（gpt-image / dall-e / flux / seedream /
//      nano-banana / qwen-image …），排除 chat / embedding / whisper 这类明显不是画图的。
//   ② 接力：前一个失败换下一个；每个提供商只出**一个**候选（避免同一个站点被重试五遍）。
//   ③ 钱规则：只在"确定没被受理"时换（4xx/5xx/连不上）；超时、响应中断、200 但没图
//      属于"结果可能已经计费"，default 的 safe 级别不换，除非你改成 aggressive。
//
// ── 其它约定 ────────────────────────────────────────────────────────────
//   · 联网用 api.fetch，清单声明 permissions: ["web_fetch"]
//   · 配置每次执行现读（cfg()），用户改完立刻生效
//   · 图片自己下回来、验魔数、限体积，再走 ctx.sender.sendImage（队列/限频/去重都在里面）
//   · 不导出 available()：缺配置时工具照常在，调用时给一句能直接转达给人看的中文报错

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 构建标记：加载时打进日志，用来区分「修复没生效」和「修复不对」。 */
const BUILD_TAG = 'v0.4.0-use-app-providers'

let cfg = () => ({})
let log = () => {}
let warn = () => {}
// api.fetch 是能力引用（不是配置），可以在 setup 时存下来。
let apiFetch = null

const API_STYLES = ['auto', 'images', 'chat']
const FAILOVER_LEVELS = ['safe', 'aggressive']
const RESPONSE_FORMATS = ['auto', 'url', 'b64_json']
const MAX_PROMPT_CHARS = 2000
const HARD_MAX_COUNT = 4
const MAX_TOTAL_ATTEMPTS = 8
const MODEL_LIST_LIMIT = 12

const DEFAULT_TIMEOUT_MS = 120000
const MIN_TIMEOUT_MS = 5000
const MAX_TIMEOUT_MS = 600000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60000
const MIN_DOWNLOAD_TIMEOUT_MS = 5000
const MAX_DOWNLOAD_TIMEOUT_MS = 300000
const DEFAULT_MAX_RETRIES = 1
const RETRY_DELAY_MS = 2500
const DOWNLOAD_ATTEMPTS = 2         // 下载幂等且免费，重试是净收益
const DOWNLOAD_RETRY_DELAY_MS = 1200
const DEFAULT_MAX_IMAGE_MB = 8
const MAX_IMAGE_MB_CEIL = 32
const DEFAULT_KEEP_LOCAL = 20
const LOCAL_DIR_NAME = 'qq-agent-image-delegate'

// 画图模型名打分：命中得正分，明显不是画图的扣分。
const IMAGE_MODEL_STRONG = /(gpt-image|dall-?e|imagen|seedream|seededit|kolors|flux|sdxl|stable-?diffusion|qwen-image|nano-?banana|image-?gen|text2image|t2i|文生图|绘图)/i
const IMAGE_MODEL_WEAK = /image|画图/i
const NON_IMAGE_MODEL = /(chat|vision|vl\b|embed|whisper|tts|speech|rerank|moderation|ocr|audio|video|asr|translat)/i
// 这几个名字是"在聊天接口里出图"的典型，先按 chat 试，省一次 404
const CHAT_IMAGE_MODEL = /(gemini[^ ]*image|gpt-4o-image|nano-?banana|即梦|jimeng|image-preview|seededit)/i

export function setup(api) {
  cfg = api.config || (() => ({}))
  log = api.log || (() => {})
  warn = api.warn || (() => {})
  apiFetch = api.fetch || null
  log(`画图委派已加载（${BUILD_TAG}）`)

  api.registerTool({
    id: 'draw',                       // 注册后实际是 image-delegate__draw
    name: '画图（用已接入的接口）',
    description: '文生图：把一段画面描述交给软件里已接入的画图模型渲染成图片，并直接发到当前会话。'
      + '当群友说「画一张…」「帮我画个…」「生成一张…的图」「来张…的图」时用它。'
      + 'prompt 要写清主体 + 风格 + 构图/色调；想多要几张用 count。'
      + '接口由软件里已配置的提供商自动挑选，不用指定用哪个，也不用填 URL/Key。'
      + '图片由本工具直接发出，不需要再调发送工具。',
    category: 'media',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述（中英文都行）：主体、风格、构图、色调' },
        size: { type: 'string', description: '可选：输出尺寸，如 1024x1024 / 1024x1536 / 512x512；留空用设置里的默认尺寸' },
        count: { type: 'number', description: '可选：一次生成几张，1~4，默认 1（受设置里的「单次最多几张」约束）' }
      },
      required: ['prompt']
    },
    async execute(ctx, args) {
      // ── 1) 参数校验 ─────────────────────────────────────────────────────
      const prompt = String(args?.prompt ?? '').trim()
      if (!prompt) return fail('缺少 prompt：把要画的画面描述写进去')
      if (prompt.length > MAX_PROMPT_CHARS) {
        return fail(`prompt 太长（${prompt.length} 字），压到 ${MAX_PROMPT_CHARS} 字以内再试`)
      }

      const settings = readSettings()
      const sources = await collectSources()
      const chain = buildChain(settings, sources)
      if (!chain.length) return fail(noCandidateText(sources))

      const count = clamp(Number(args?.count) || 1, 1, Math.min(settings.maxCount, HARD_MAX_COUNT))
      const size = String(args?.size ?? '').trim() || settings.defaultSize
      const text = settings.promptSuffix ? `${prompt}，${settings.promptSuffix}` : prompt

      try {
        // ── 2) 接力调用 ───────────────────────────────────────────────────
        const picked = await requestWithChain(settings, chain, text, size, count)

        // ── 3) 物化：下载/解码 + 验魔数 + 限体积 + 本地留档 ────────────────
        const ready = []
        const prepFailed = []
        for (const [index, ref] of picked.refs.entries()) {
          try {
            ready.push(await materialize(settings, ref, index))
          } catch (error) {
            prepFailed.push(humanizeError(error))
          }
        }
        if (!ready.length) return fail(`图片拿到了但用不了：${prepFailed.join('；') || '未知原因'}`)

        // ── 4) 发出（一律走 sender：队列 / 限频 / 去重都在它里面）───────────
        const who = `${picked.entry.label}·模型 ${picked.entry.model}`
        let sent = 0
        const sendFailed = []
        for (const image of ready) {
          try {
            // 优先传本地路径：图已落盘，协议端自己读磁盘，body 从 MB 级降到百字节级。
            await ctx.sender.sendImage(
              ctx.chatKey,
              { file: image.filePath, dataUrl: image.dataUrl },
              { note: 'AI绘图' }
            )
            sent += 1
            ctx.session?.sent?.push({
              type: 'image',
              text: '[图片:AI绘图]',
              at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
            })
          } catch (error) {
            sendFailed.push(`${humanizeError(error)}（图已存本地：${image.filePath}）`)
          }
        }
        if (sent) {
          log(`已生成并发送 ${sent} 张（${who}${picked.retried ? '，重试后成功' : ''}）`)
          for (const line of picked.notes) log(`接力记录：${line}`)
          try { ctx.emit?.('session-update', ctx.session?.id) } catch { /* 上报失败不影响已发出的图 */ }
        }
        if (!sent) {
          return fail(`图画出来了但发送失败：${sendFailed.join('；')}。`
            + '这通常是协议端到 QQ 的链路问题（不是画图的问题），不要为此重新生成 —— 那只会再花一次钱。')
        }

        const notes = []
        if (picked.retried) notes.push('（同一个接口第一次失败，重试后成功）')
        if (picked.switched) notes.push(`（前面的接口失败后自动接力到它：${picked.reason}）`)
        if (prepFailed.length) notes.push(`（另有 ${prepFailed.length} 张无效：${prepFailed.join('；')}）`)
        if (sendFailed.length) notes.push(`（另有 ${sendFailed.length} 张发送失败：${sendFailed.join('；')}）`)
        return {
          content: `已生成 ${sent} 张图片并直接发到当前会话（${who}）${notes.join('')}。`
            + '注意：你看不到生成的画面，所以不要描述画面细节、不要编造内容，也不要再调发送工具；'
            + '一句自然的收尾就够了。'
        }
      } catch (error) {
        log(`画图失败：${describeError(error)}`)
        return fail(humanizeError(error))
      }
    }
  })

  // 让"软件里哪些接口会被用来画图"看得见 —— 本套应用的技能没有自己的 HTTP 接口，
  // 用户能看见的唯一入口就是模型能调的工具。
  api.registerTool({
    id: 'models',
    name: '画图接口清单',
    description: '列出软件里已接入的接口中，哪些会被用来画图、按什么顺序接力。'
      + '当用户问「画图能用哪些模型」「怎么画不出来」「画图接口配好了吗」时用它。'
      + '只读，不改配置、不画图、不产生生成费用。',
    category: 'query',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: '可选：true 时把所有已接入的提供商和模型都列出来（含不是画图的），便于手动指定' }
      }
    },
    async execute(_ctx, args) {
      const settings = readSettings()
      const sources = await collectSources()
      const all = args?.all === true
      const chain = buildChain(settings, sources)
      const lines = []

      if (!sources.ok) {
        lines.push(`⚠️ 读不到软件的配置：${sources.error}`)
        lines.push('（补丁/技能放的目录是不是 <app>/skills/<id>/？下面只用「补充接口」凑。）')
      }

      if (chain.length) {
        lines.push(`画图会按这个顺序接力（共 ${chain.length} 个）：`)
        chain.forEach((entry, i) => {
          lines.push(`  ${i + 1}. ${entry.label} · 模型 ${entry.model} · 形态 ${entry.style}`)
          lines.push(`     ${entry.baseUrl}`)
        })
      } else {
        lines.push('目前没有任何可用候选。')
        lines.push(noCandidateText(sources))
      }

      const skipped = []
      for (const provider of sources.providers) {
        const image = pickImageModel(provider.models)
        if (!image) skipped.push(`${provider.name}（${provider.models.length} 个模型，没有像画图的）`)
      }
      lines.push('')
      lines.push(`软件里共接入 ${sources.providers.length} 个提供商；其中没找到画图模型的：${skipped.join('、') || '（无）'}`)
      if (sources.api.model) {
        lines.push(`主模型那套：${sources.api.model}`
          + `${isImageModel(sources.api.model) ? '（看起来是画图模型，已加入候选）' : '（不像画图模型，已跳过）'}`)
      }
      if (settings.useProviders) lines.push(`设置里限定了只用：${settings.useProviders}`)
      if (settings.preferModels) lines.push(`设置里指定了优先模型：${settings.preferModels}`)

      if (all) {
        lines.push('')
        lines.push('── 全部已接入的模型 ──')
        for (const provider of sources.providers) {
          lines.push(`${provider.name}（${provider.baseUrl}）`)
          lines.push(`  ${truncate(provider.models.slice(0, 60).join('、') || '（没有模型）', 900)}`)
        }
      }
      return { content: lines.join('\n') }
    }
  })
}

// 刻意不导出 available()：缺候选时工具照常在，调用时给一句写明"去哪儿加接口"的报错。
// 把工具藏起来只会变成"群里说画图，机器人毫无反应，也没人知道为什么"。

// ── 配置 ──────────────────────────────────────────────────────────────────
function readSettings() {
  const c = cfg() || {}
  const format = String(c.responseFormat || '').trim()
  const retries = (c.maxRetries === undefined || c.maxRetries === null || c.maxRetries === '')
    ? DEFAULT_MAX_RETRIES : Number(c.maxRetries)
  const level = String(c.failoverLevel || '').trim().toLowerCase()
  return {
    useProviders: String(c.useProviders || '').trim(),
    preferModels: String(c.preferModels || '').trim(),
    extraBaseUrl: String(c.extraBaseUrl || '').trim(),
    extraApiKey: String(c.extraApiKey || '').trim(),
    extraModel: String(c.extraModel || '').trim(),
    extraStyle: normalizeStyle(c.extraStyle),
    failoverLevel: FAILOVER_LEVELS.includes(level) ? level : 'safe',
    defaultSize: String(c.defaultSize || '').trim(),
    promptSuffix: String(c.promptSuffix || '').trim(),
    maxCount: clamp(Number(c.maxCount) || 2, 1, HARD_MAX_COUNT),
    responseFormat: RESPONSE_FORMATS.includes(format) ? format : 'auto',
    extraBody: parseExtraBody(c.extraBody),
    timeoutMs: clamp(Number(c.timeoutMs) || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    downloadTimeoutMs: clamp(
      Number(c.downloadTimeoutMs) || DEFAULT_DOWNLOAD_TIMEOUT_MS,
      MIN_DOWNLOAD_TIMEOUT_MS,
      MAX_DOWNLOAD_TIMEOUT_MS
    ),
    maxRetries: clamp(Number.isFinite(retries) ? retries : DEFAULT_MAX_RETRIES, 0, 3),
    maxImageBytes: clamp(Number(c.maxImageMB) || DEFAULT_MAX_IMAGE_MB, 1, MAX_IMAGE_MB_CEIL) * 1024 * 1024,
    keepLocal: Math.max(0, Number(c.keepLocal ?? DEFAULT_KEEP_LOCAL) || 0)
  }
}

function normalizeStyle(style) {
  const value = String(style || '').trim().toLowerCase()
  return API_STYLES.includes(value) ? value : 'auto'
}

function parseExtraBody(raw) {
  const text = String(raw || '').trim()
  if (!text) return {}
  const parsed = safeParse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`extraBody 不是合法的 JSON 对象，已忽略：${truncate(text, 80)}`)
    return {}
  }
  return parsed
}

// ── 数据来源：软件里已经接好的接口 ────────────────────────────────────────
/**
 * 读软件自己的配置。
 *
 * 这里刻意**不自己读 config.json**：数据目录有四种可能（安装目录/data、项目/data、
 * 多开时的 data-N、QQ_AGENT_DATA_DIR 指定的），自己拼路径必然漏；而且提供商的 Key
 * 已经从 providers[] 挪到了 dshProviderKeys，currentProviders() 才会解出真实 Key。
 * 所以直接问本体的模块 —— 它算得对，而且拿的是内存里的实时配置。
 *
 * 读不到时**不哑失败**：返回 ok:false + 原因，由调用方写进报错里。
 */
async function collectSources() {
  try {
    const configModule = await import('../../src/config.js')
    const providersModule = await import('../../src/providers.js')
    const appConfig = configModule.getConfig() || {}
    const providers = (providersModule.currentProviders() || []).map((p) => ({
      id: String(p.id || ''),
      name: String(p.displayName || p.id || '未命名提供商'),
      baseUrl: String(p.baseURL || '').trim().replace(/\/+$/, ''),
      apiKey: String(p.apiKey || '').trim(),
      models: normalizeModelIds(p.models)
    })).filter((p) => p.baseUrl)

    const api = appConfig.api || {}
    return {
      ok: true,
      providers,
      api: {
        baseUrl: String(api.baseUrl || '').trim().replace(/\/+$/, ''),
        apiKey: String(api.apiKey || '').trim(),
        model: String(api.model || '').trim()
      }
    }
  } catch (error) {
    return {
      ok: false,
      providers: [],
      api: { baseUrl: '', apiKey: '', model: '' },
      error: `${humanizeError(error)}（本技能要靠本体的 src/config.js 与 src/providers.js 读接口；`
        + '技能目录得是 <app>/skills/image-delegate/）'
    }
  }
}

function normalizeModelIds(models) {
  const out = []
  for (const m of Array.isArray(models) ? models : []) {
    const id = typeof m === 'string' ? m.trim() : String(m?.id ?? m?.model ?? '').trim()
    if (id) out.push(id)
  }
  return [...new Set(out)]
}

function isImageModel(name) {
  return scoreModelName(name) > 0
}

function scoreModelName(name) {
  const value = String(name || '').toLowerCase()
  if (!value) return 0
  let score = 0
  if (IMAGE_MODEL_STRONG.test(value)) score += 10
  if (IMAGE_MODEL_WEAK.test(value)) score += 4
  if (NON_IMAGE_MODEL.test(value)) score -= 6
  return score
}

/** 一个提供商里挑出最像画图的那个模型（同站点只出一个候选，免得被重试五遍）。 */
function pickImageModel(models) {
  let best = ''
  let bestScore = 0
  for (const id of models || []) {
    const score = scoreModelName(id)
    if (score > bestScore) {
      best = id
      bestScore = score
    }
  }
  return best
}

/** 模型名 → 接口形态。auto 已经能兜底（先图片接口、404 才聊天），这里只是省一次请求。 */
function guessStyle(model) {
  return CHAT_IMAGE_MODEL.test(String(model || '')) ? 'chat' : 'auto'
}

// ── 组接力链 ──────────────────────────────────────────────────────────────
/**
 * 候选顺序：
 *   1. 软件里的提供商（顺序 = 模型管理里的顺序），每个提供商出一个最像画图的模型
 *   2. 主模型那套（只有它的模型像画图模型时才算）
 *   3. 你在设置里填的「补充接口」（如果有）
 * 然后用 useProviders（只用哪些）过滤、用 preferModels（优先哪些）调序。
 */
function buildChain(settings, sources) {
  const entries = []
  const seen = new Set()
  const push = (entry) => {
    const key = `${entry.baseUrl}|${entry.model}`.toLowerCase()
    if (!entry.baseUrl || !entry.model || seen.has(key)) return
    seen.add(key)
    entries.push(entry)
  }

  const wanted = splitList(settings.useProviders).map((s) => s.toLowerCase())
  const providers = sources.providers.filter((p) => {
    if (!wanted.length) return true
    return wanted.some((w) => w.includes(p.id.toLowerCase()) || p.name.toLowerCase().includes(w))
  })
  // useProviders 里写了顺序时，按写的顺序排
  if (wanted.length) {
    providers.sort((a, b) => rankOf(a, wanted) - rankOf(b, wanted))
  }

  for (const provider of providers) {
    const model = pickImageModel(provider.models)
    if (!model) continue
    push({
      kind: 'provider',
      label: `提供商「${provider.name}」`,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model,
      style: guessStyle(model)
    })
  }

  if (sources.api.baseUrl && isImageModel(sources.api.model)) {
    push({
      kind: 'api',
      label: '主模型那套',
      baseUrl: sources.api.baseUrl,
      apiKey: sources.api.apiKey,
      model: sources.api.model,
      style: guessStyle(sources.api.model)
    })
  }

  if (settings.extraBaseUrl && settings.extraModel) {
    push({
      kind: 'extra',
      label: '补充接口',
      baseUrl: settings.extraBaseUrl,
      apiKey: settings.extraApiKey,
      model: settings.extraModel,
      style: settings.extraStyle
    })
  }

  // preferModels：按填的顺序把匹配的候选提到前面；匹配到的模型名直接替换候选模型
  const preferred = splitList(settings.preferModels)
  if (preferred.length) {
    const rank = new Map()
    preferred.forEach((name, i) => rank.set(name.toLowerCase(), i))
    const scoreOf = (entry) => {
      const hit = preferred.findIndex((name) => entry.model.toLowerCase().includes(name.toLowerCase()))
      return hit >= 0 ? hit : 999
    }
    entries.sort((a, b) => scoreOf(a) - scoreOf(b))
  }
  return entries
}

function rankOf(provider, wanted) {
  const idx = wanted.findIndex((w) => w.includes(provider.id.toLowerCase()) || provider.name.toLowerCase().includes(w))
  return idx < 0 ? 999 : idx
}

function splitList(text) {
  return String(text || '')
    .split(/[,，\n;；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function noCandidateText(sources) {
  const lines = ['软件里已接入的接口中，没有找到画图模型，所以画不了。可以这样补：']
  lines.push('① 控制台 → 设置 → 模型 API（模型管理）→ 选一个提供商 →「拉取模型列表」，')
  lines.push('   把 gpt-image / dall-e / flux / seedream / nano-banana 这类模型勾进来；')
  lines.push('② 或者在本技能设置里填「优先模型」= 具体模型名（例如 gpt-image-1）；')
  lines.push('③ 或者用「补充接口」那三项直接填一个画图接口（Base URL / Key / 模型）。')
  if (!sources.ok) lines.push(`（另外：读软件配置失败 —— ${sources.error}）`)
  const seen = sources.providers
    .filter((p) => p.models.length)
    .map((p) => `${p.name}(${p.models.length} 个)`)
  if (seen.length) lines.push(`已接入的提供商：${truncate(seen.join('、'), 200)}。想全部列出来就问「画图接口清单」加 all=true。`)
  return lines.join('\n')
}

// ── 请求体 ────────────────────────────────────────────────────────────────
function buildImagesBody(settings, entry, prompt, size, count) {
  const body = { ...settings.extraBody }
  body.model = entry.model
  body.prompt = prompt
  body.n = count
  if (size) body.size = size
  if (settings.responseFormat !== 'auto') body.response_format = settings.responseFormat
  return body
}

/** 聊天式出图刻意不传 size：聊天接口普遍不认，多传容易被严格端点判 400。 */
function buildChatBody(settings, entry, prompt) {
  const body = { ...settings.extraBody }
  body.model = entry.model
  body.messages = [{ role: 'user', content: prompt }]
  return body
}

/** 补全地址（用户的 baseUrl 可能写到域名、/v1，或已经带了完整路径）。 */
function resolveEndpoint(baseUrl, style) {
  let url = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!url) return ''
  url = url.replace(/\/(images\/generations|chat\/completions|models)$/i, '')
  const suffix = style === 'chat' ? '/chat/completions' : '/images/generations'
  if (/\/v\d+(?:\.\d+)?$/i.test(url)) return `${url}${suffix}`
  return `${url}/v1${suffix}`
}

// ── 接力主干 ──────────────────────────────────────────────────────────────
async function requestWithChain(settings, chain, prompt, size, count) {
  const attempts = []
  const notes = []
  let budget = MAX_TOTAL_ATTEMPTS

  for (const [index, entry] of chain.entries()) {
    const styles = entry.style === 'auto' ? ['images', 'chat'] : [entry.style]
    for (const [styleIndex, style] of styles.entries()) {
      if (budget <= 0) {
        throw humanized(`请求次数已达上限（${MAX_TOTAL_ATTEMPTS} 次），停止尝试。已试过：${attempts.join('；')}`)
      }
      budget -= 1
      try {
        const { payload, retried } = await callWithRetry(entry, settings, style, prompt, size, count)
        const refs = extractImages(payload)
        if (!refs.length) {
          // 200 但没图：请求其实已被受理（多半也计费了）→ 归到"结果不确定"那类
          const error = new Error(`接口没返回图片。原始响应（截断）：${truncate(JSON.stringify(payload), 300)}`)
          error.unsafe = true
          throw error
        }
        return {
          refs,
          entry,
          style,
          retried,
          notes,
          switched: attempts.length > 0,
          reason: attempts[attempts.length - 1] || ''
        }
      } catch (error) {
        attempts.push(`${entry.label}·${styleLabel(style)}：${humanizeError(error)}`)

        // 同一站点内的形态切换：只有"这条路不存在"才试另一种（换形态=再发一次请求）
        const nextStyle = styles[styleIndex + 1]
        if (nextStyle && error.routeMissing === true) {
          notes.push(`${entry.label} 的${styleLabel(style)}这条路不存在，改试${styleLabel(nextStyle)}`)
          continue
        }

        if (!shouldFailover(error, settings.failoverLevel)) {
          throw humanized(`${humanizeError(error)}`
            + `（这是第 ${index + 1} 个接口的失败。当前接力级别是 safe，这类"结果不确定"的错误`
            + '不会自动换下一个接口 —— 图可能已经生成并计费了。想无论如何都换下一个，'
            + '把设置里的「失败接力级别」改成 aggressive。）')
        }
        if (index < chain.length - 1) {
          notes.push(`${entry.label} 失败（${humanizeError(error)}），接力到下一个接口`)
        }
        break   // 换下一个候选
      }
    }
  }

  const detail = attempts.length ? `每个接口的失败原因：${attempts.join('；')}` : ''
  throw humanized(`所有画图接口都没成功。${detail}`)
}

/**
 * 要不要换下一个接口。
 * safe（默认）：只有"确定没被受理"的失败才换 —— 4xx/5xx、连不上、DNS 失败。
 * aggressive：连"结果不确定"的（超时、响应中断、200 但没图）也换。
 */
function shouldFailover(error, level) {
  if (error?.unsafe !== true) return true
  return level === 'aggressive'
}

async function callWithRetry(entry, settings, style, prompt, size, count) {
  let lastError = null
  const attempts = Math.max(1, settings.maxRetries + 1)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { payload: await requestOnce(entry, settings, style, prompt, size, count), retried: attempt > 1 }
    } catch (error) {
      lastError = error
      // 只有「确定没被受理」的失败才重试：超时/中断时图可能已生成并计费
      if (error?.unsafe === true || error?.retryable !== true || attempt >= attempts) break
      warn(`第 ${attempt} 次请求失败（${describeError(error)}），${RETRY_DELAY_MS}ms 后重试`)
      await sleep(RETRY_DELAY_MS)
    }
  }
  throw lastError
}

async function requestOnce(entry, settings, style, prompt, size, count) {
  if (typeof apiFetch !== 'function') {
    throw new Error('联网能力不可用：清单需要声明 permissions: ["web_fetch"]')
  }
  const endpoint = resolveEndpoint(entry.baseUrl, style)
  const body = style === 'chat'
    ? buildChatBody(settings, entry, prompt)
    : buildImagesBody(settings, entry, prompt, size, count)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
  let res
  try {
    res = await apiFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(entry.apiKey ? { Authorization: `Bearer ${entry.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } catch (error) {
    clearTimeout(timer)
    if (controller.signal.aborted || isTimeoutLike(error)) {
      // 结果未知：图可能已经生成并计费 → unsafe，safe 级别下既不重试也不接力
      const timeout = new Error(`接口超时（${Math.round(settings.timeoutMs / 1000)} 秒没返回）`)
      timeout.unsafe = true
      throw timeout
    }
    // 连不上（DNS/拒绝连接/TLS）= 请求根本没发出去 = 安全，可以重试与接力
    const offline = new Error(`连不上接口（${entry.baseUrl}）：${humanizeError(error)}`)
    offline.retryable = true
    throw offline
  }

  // ⚠️ 计时器不能在这里清：生成接口常见「响应头先回、结果 JSON 后到」，
  //    清早了等于给「读 body」这一步摘掉超时，对方一卡住整轮就永久挂起。
  let text = ''
  try {
    text = await res.text()
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = new Error(`接口超时（${Math.round(settings.timeoutMs / 1000)} 秒：响应头已返回但响应体没读完）`)
      timeout.unsafe = true
      throw timeout
    }
    // 读到一半断了 = 对方已经在回内容 = 可能已经计费 → unsafe
    const broken = new Error(`读取接口响应中断：${humanizeError(error)}`)
    broken.unsafe = true
    throw broken
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const error = new Error(`「${styleLabel(style)}」返回 HTTP ${res.status}：${errorText(text)}`)
    error.retryable = isTransientStatus(res.status, text)
    error.routeMissing = isRouteMissing(res.status, text)
    // 服务端明确回了状态码 = 这次请求没生成图 = 安全接力
    error.unsafe = false
    throw error
  }

  const json = safeParse(text)
  if (!json || typeof json !== 'object') {
    const error = new Error(`接口返回的不是 JSON：${truncate(text, 200)}`)
    error.unsafe = true   // 有内容返回，说明对方处理过了
    throw error
  }
  return json
}

/** 5xx / 429 一律可重试；400 要看文案（中转站的「上游暂时不可用」也是 400）。 */
function isTransientStatus(status, text) {
  if (status === 429) return true
  if (status >= 500) return true
  if (status !== 400 && status !== 402 && status !== 408) return false
  return /上游|暂时不可用|稍后重试|请重试|try again|later|timeout|timed out|overload|繁忙|拥挤|rate.?limit|temporar|upstream|unavailable|无可用|智能路由/i
    .test(String(text || ''))
}

/** 「这条路不存在」= 可以安全换形态；其它 4xx 都是真错误。 */
function isRouteMissing(status, text) {
  if (status === 404 || status === 405) return true
  if (status !== 400) return false
  return /unknown (endpoint|route|url|path)|no such (endpoint|route)|route not found|not found.*(route|endpoint|path)|接口不存在|路径不存在|未知接口|不支持的接口/i
    .test(String(text || ''))
}

function errorText(text) {
  const json = safeParse(text)
  const raw = json?.error?.message ?? json?.error ?? json?.message ?? json?.msg ?? json?.detail
  const value = typeof raw === 'object' && raw !== null ? JSON.stringify(raw) : raw
  return truncate(String(value ?? text ?? '').replace(/\s+/g, ' ').trim(), 300)
}

// ── 解析返回里的图片引用 ──────────────────────────────────────────────────
function extractImages(payload) {
  const refs = []
  const seen = new Set()
  const push = (ref) => {
    if (ref && ref.value && !seen.has(ref.value)) {
      seen.add(ref.value)
      refs.push(ref)
    }
  }

  const items = []
  if (Array.isArray(payload)) items.push(...payload)
  for (const key of ['data', 'images', 'output', 'results', 'artifacts']) {
    const value = payload?.[key]
    if (Array.isArray(value)) items.push(...value)
    else if (value && typeof value === 'object') items.push(value)
  }
  for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
    const message = choice?.message ?? choice?.delta ?? {}
    if (Array.isArray(message?.images)) items.push(...message.images)
    else if (message?.images && typeof message.images === 'object') items.push(message.images)
    if (message?.content !== undefined) items.push({ chatContent: message.content })
    else if (typeof choice?.text === 'string') items.push({ chatContent: choice.text })
  }

  for (const item of items) {
    if (item && typeof item === 'object' && 'chatContent' in item) {
      for (const ref of refsFromChatContent(item.chatContent)) push(ref)
      continue
    }
    push(toImageRef(item))
  }
  return refs
}

function refsFromChatContent(content) {
  const out = []
  if (typeof content === 'string') return refsFromText(content)
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') {
        if (typeof part === 'string') out.push(...refsFromText(part))
        continue
      }
      if (typeof part.text === 'string') out.push(...refsFromText(part.text))
      if (part.image_url || part.image || part.url || part.b64_json || part.data) {
        const ref = toImageRef(part)
        if (ref) out.push(ref)
      }
    }
    return out
  }
  const ref = toImageRef(content)
  if (ref) out.push(ref)
  return out
}

/** 从一段文本里抠出图片：markdown 图片、data URL、裸图片链接。 */
function refsFromText(text) {
  const out = []
  const seen = new Set()
  const push = (ref) => {
    if (ref && ref.value && !seen.has(ref.value)) {
      seen.add(ref.value)
      out.push(ref)
    }
  }
  const value = String(text)

  for (const match of value.matchAll(/!\[[^\]]*\]\(\s*(<?)([^)\s>]+)\1\s*\)/g)) {
    push(refFromValue(match[2]))
  }
  for (const match of value.matchAll(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{64,}/gi)) {
    push({ kind: 'base64', value: match[0] })
  }
  for (const match of value.matchAll(/https?:\/\/[^\s"'<>()]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>()]*)?/gi)) {
    push({ kind: 'url', value: match[0] })
  }
  return out
}

function toImageRef(item) {
  if (typeof item === 'string') return refFromValue(item)
  if (!item || typeof item !== 'object') return null

  // base64 优先：接口给的链接常常带防盗链或很快过期
  const rawB64 = firstString(item.b64_json, item.base64, item.image_base64, item.b64)
  if (rawB64) return { kind: 'base64', value: rawB64 }

  const rawUrl = firstString(
    item.url,
    item.image_url && typeof item.image_url === 'object' ? item.image_url.url : item.image_url,
    item.image,
    item.file,
    item.url_path,
    item.imageUrl
  )
  return rawUrl ? refFromValue(rawUrl) : null
}

function refFromValue(value) {
  const text = String(value || '').trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text)) return { kind: 'url', value: text }
  if (/^data:image\//i.test(text)) return { kind: 'base64', value: text }
  // 裸 base64：够长且只含 base64 字符才认，免得把「无图」的说明文字当成图
  const compact = text.replace(/\s+/g, '')
  if (compact.length >= 256 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return { kind: 'base64', value: compact }
  return null
}

// ── 物化：把引用变成协议端能直接用的本地文件 ───────────────────────────────
async function materialize(settings, ref, index) {
  const buffer = ref.kind === 'url'
    ? await downloadImage(settings, ref.value)
    : decodeBase64(ref.value, settings)

  if (!buffer.length) throw new Error('图片内容为空')
  if (buffer.length > settings.maxImageBytes) throw tooLargeError(settings.maxImageBytes)

  const mime = detectMime(buffer)
  if (!mime) throw new Error('拿到的不是图片（可能是防盗链页或错误页），已丢弃')

  const filePath = saveLocal(buffer, mime, index, settings)
  return { filePath, dataUrl: `base64://${buffer.toString('base64')}`, mime, bytes: buffer.length }
}

/**
 * 下载一张图（带一次免费重试）。
 * 超时覆盖**整条请求**（响应头 + 响应体）：海外图床「响应头秒回、body 慢慢滴」是常态，
 * 只在 fetch 那一步设超时会导致 abort 发生在读 body 时、错误信息还看不出卡在哪。
 * 所以报错里带**阶段**与**已收字节数**：这两条决定处置方式。
 */
async function downloadImage(settings, url) {
  let problem = null
  let progress = { bytes: 0, stage: 'connect' }

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    progress = { bytes: 0, stage: 'connect' }
    const startedAt = Date.now()
    try {
      return await downloadOnce(settings, url, progress)
    } catch (error) {
      if (error?.tooLarge) throw error
      problem = describeDownloadError(error, settings.downloadTimeoutMs, progress, startedAt)
      if (attempt >= DOWNLOAD_ATTEMPTS) break
      warn(`下载图片失败（${problem}），${DOWNLOAD_RETRY_DELAY_MS}ms 后重试（下载免费，重试不额外计费）`)
      await sleep(DOWNLOAD_RETRY_DELAY_MS)
    }
  }
  throw new Error(problem || '下载图片失败')
}

async function downloadOnce(settings, url, progress) {
  if (typeof apiFetch !== 'function') throw new Error('联网能力不可用')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.downloadTimeoutMs)
  let res
  try {
    res = await apiFetch(url, { method: 'GET', headers: { Accept: 'image/*,*/*' }, signal: controller.signal })
  } catch (error) {
    progress.stage = 'connect'
    if (controller.signal.aborted || isTimeoutLike(error)) throw timeoutError('connect')
    const wrapped = new Error(`连接图片地址失败：${humanizeError(error)}`)
    wrapped.stage = 'connect'
    throw wrapped
  }

  if (!res.ok) {
    clearTimeout(timer)
    const wrapped = new Error(`下载图片返回 HTTP ${res.status}`)
    wrapped.stage = 'connect'
    wrapped.retryable = res.status === 429 || res.status >= 500
    throw wrapped
  }

  try {
    return await readLimited(res, settings.maxImageBytes, progress, controller)
  } catch (error) {
    if (error?.tooLarge) throw error
    if (controller.signal.aborted || isTimeoutLike(error)) throw timeoutError('body')
    error.stage = error.stage || 'body'
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 边读边卡上限：宁可中途断开，也不要为一个超限的大图吃满内存。 */
async function readLimited(res, maxBytes, progress, controller) {
  const reader = res.body?.getReader?.()
  if (!reader) {
    const buffer = Buffer.from(await res.arrayBuffer())
    progress.bytes = buffer.length
    if (buffer.length > maxBytes) throw tooLargeError(maxBytes)
    return buffer
  }

  const chunks = []
  let total = 0
  for (;;) {
    let step
    try {
      step = await reader.read()
    } catch (error) {
      if (controller?.signal?.aborted) throw timeoutError('body')
      throw error
    }
    if (step.done) break
    total += step.value.byteLength
    progress.bytes = total
    if (total > maxBytes) {
      try { await reader.cancel() } catch { /* 断开失败不影响结论 */ }
      throw tooLargeError(maxBytes, true)
    }
    chunks.push(Buffer.from(step.value))
  }
  return Buffer.concat(chunks)
}

function timeoutError(stage) {
  const error = new Error('下载超时')
  error.timeout = true
  error.stage = stage
  error.retryable = true
  return error
}

function tooLargeError(maxBytes, midway = false) {
  const error = new Error(`图片超过体积上限 ${(maxBytes / 1048576).toFixed(0)}MB${midway ? '（下载中途截断）' : ''}。`
    + '换个更小的尺寸，或把设置里的「图片体积上限」调大。')
  error.tooLarge = true
  return error
}

function describeDownloadError(error, timeoutMs, progress, startedAt) {
  const secs = startedAt ? Math.max(1, Math.round((Date.now() - startedAt) / 1000)) : null
  const mb = (progress?.bytes || 0) / 1048576
  if (error?.timeout && progress?.stage === 'body') {
    return `下载超时（${Math.round(timeoutMs / 1000)} 秒：响应头已回，图片只收到 ${mb.toFixed(1)}MB）`
      + '——对方是活的只是慢，把「图片下载超时」调大通常就好了。'
  }
  if (error?.timeout) {
    return `下载超时（${Math.round(timeoutMs / 1000)} 秒：连响应头都没收到）`
      + '——多半是图床被墙或路由不通，换网络/换接口更有效。'
  }
  if (secs !== null && mb > 0) return `${humanizeError(error)}（已收到 ${mb.toFixed(1)}MB，用时 ${secs} 秒）`
  return humanizeError(error)
}

function decodeBase64(value, settings) {
  const text = String(value || '').trim()
  const marked = /^data:[^;,]*;base64,(.*)$/is.exec(text)
  const b64 = (marked ? marked[1] : text).replace(/\s+/g, '')
  if (!b64) throw new Error('图片 base64 为空')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error('图片 base64 格式不合法')
  const estimated = Math.floor(b64.length * 3 / 4)
  if (estimated > settings.maxImageBytes * 1.2) throw tooLargeError(settings.maxImageBytes)
  return Buffer.from(b64, 'base64')
}

/** 魔数校验：挡掉「图片链接其实返回防盗链 HTML 页」这种情况。 */
function detectMime(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png'
  const head6 = buf.subarray(0, 6).toString('latin1')
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

/** 本地留档：发送失败时这张图还能捞回来，也方便人工排查。 */
function saveLocal(buffer, mime, index, settings) {
  try {
    const dir = path.join(os.tmpdir(), LOCAL_DIR_NAME)
    fs.mkdirSync(dir, { recursive: true })
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${index + 1}.${ext}`
    const filePath = path.join(dir, name)
    fs.writeFileSync(filePath, buffer)
    pruneLocal(dir, settings.keepLocal)
    return filePath
  } catch (error) {
    warn(`本地留档失败（不影响发送）：${error?.message ?? error}`)
    return '(未能留档)'
  }
}

function pruneLocal(dir, keep) {
  if (!keep) return
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f)).sort()
    for (const stale of files.slice(0, Math.max(0, files.length - keep))) {
      fs.unlinkSync(path.join(dir, stale))
    }
  } catch { /* 清不动就算了，不该影响主流程 */ }
}

// ── 小工具 ────────────────────────────────────────────────────────────────
function styleLabel(style) {
  if (style === 'chat') return '聊天式出图'
  if (style === 'images') return '图片接口'
  return '接口'
}

/**
 * Node 的 fetch 失败只给一句「fetch failed」，真正的原因（ECONNRESET / DNS 失败 /
 * 连接被对端关闭）藏在 error.cause 里 —— 不挖出来就没法定位。
 */
function describeError(error, depth = 0) {
  if (!error) return '未知错误'
  if (depth > 3) return String(error?.message ?? error)
  const parts = []
  let current = error
  const seen = new Set()
  while (current && !seen.has(current) && parts.length < 4) {
    seen.add(current)
    const text = String(current?.message ?? current)
    if (text && !parts.includes(text)) parts.push(text)
    current = current?.cause
  }
  return parts.join(' ← ')
}

function humanizeError(error) {
  const text = describeError(error)
  // 已经拼成人话的（带解释的那几处），原样透出，别再被前缀顶掉
  if (error?.humanized === true) return truncate(text, 600)
  if (/terminated|other side closed|ECONNRESET|socket hang up/i.test(text)) {
    return `连接被对端断开（${truncate(text, 120)}）—— 常见于中转站限流或网络不稳`
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) {
    return `域名解析不了（${truncate(text, 120)}）—— 检查该提供商的 Base URL`
  }
  if (/certificate|self-signed|UNABLE_TO_VERIFY/i.test(text)) {
    return `HTTPS 证书校验失败（${truncate(text, 120)}）—— 确认地址是官方或可信中转`
  }
  return truncate(text, 600)
}

/** 把已经拼成人话的错误标一下，交给 humanizeError 时原样透出。 */
function humanized(message) {
  const error = new Error(message)
  error.humanized = true
  return error
}

function isTimeoutLike(error) {
  const text = describeError(error)
  return /aborted|timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|DOMException/i.test(text)
}

function fail(message) {
  return { content: `错误：${message}`, isError: true }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clamp(n, lo, hi) {
  const value = Number(n)
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, value))
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
