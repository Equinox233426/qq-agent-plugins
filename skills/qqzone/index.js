// QQ 空间动态 —— **自包含** Skill（QQ Agent 0.3.1 规范）
//
// 这个文件会被**原样拷进别人的 app 目录**，那份 app 的 src/ 结构与我们的不同，
// 所以这里**不 import 任何 `../../src/...`**，只用 Node 内置模块。
//
// ── 能力 ────────────────────────────────────────────────────────────────
//   qqzone__post_mood      发说说（文字，可带聊天里的图）
//   qqzone__list_feeds     刷好友动态（只读）
//   qqzone__like_feed      点赞某条说说
//   qqzone__comment_feed   评论某条说说
//   qqzone__collect_diary  收集今天的日记素材（只读，不出网）
//   qqzone__post_diary     日记正文 → 长文排版图 → 发说说
//
// ── 日记这条线（v2.0 改装）────────────────────────────────────────────
//   collect_diary 把三样原料喂给模型：当天全部会话的聊天记录（热段+冷段，按天过滤、
//   按条数/字数封顶）、「世界与事件」插件的世界观（config.skills['life-system'].worldbook）
//   和近况账本（data/life-events.json，只取今天的条目）。日记正文由模型自己写——
//   第一人称、它今天的经历和感受，工具不代笔。
//   post_diary 复用「长文排版图」的渲染管线（skills/text-image 的 renderPages，
//   软依赖：模块不在就自动把日记发成纯文字说说，不报错拦人），PNG 字节直接走本文件
//   已有的 uploadQzoneImage 上 Qzone 图床再发说说——不经聊天记录，所以不受
//   "模型拿不到任意图"那条铁律约束：图是本地渲染出来的，不是模型塞进来的字节。
//   日记按天限频（diaryPerDay，默认 1 篇），与 postsPerDay 是两条独立的闸。
//
// ── 前置依赖（v2.1 起全部软性，manifest.requires 留空）─────────────────
//   「世界与事件」插件（plugins/life-system）和「长文排版图」技能（skills/text-image）
//   都**不强制**：没装世界与事件，collect_diary 照常回素材（注明跳过世界观与账本）；
//   没装长文排版图（或渲染失败），post_diary 自动把日记发成纯文字说说。
//   装了就增强，没装就降级，任何一个缺失都不挡工具注册。
//
// ── 带图说说的图片只从聊天记录里来（铁律，别开口子）────────────────────
//   模型给的**不是**路径 / 网址 / base64，而是聊天记录里的消息号（#12345，
//   多张图用 #12345:2）。定位符由我们从 ctx.store 的存档里取 —— 与 src/tools.js
//   的 send_voice 一个口径：模型只给白名单键，出网的东西全由应用侧解析。
//   这样"任意本地文件被当图上传"这条路根本不存在，坏引用在碰网络之前就死。
//
// ── 登录态从哪来 ─────────────────────────────────────────────────────────
//   Qzone 网页接口只认 cookie。bot 账号在 SnowLuma 里登录着，OneBot 的 get_cookies
//   能直接把它取出来（注意：SnowLuma 对 get_cookies 这类敏感接口强制校验
//   accessToken，所以调用必须带 Bearer——先从 ctx.onebot 的常规通道走，
//   被 1401 拒了再去读 snowluma 的配置文件自己拿 token 拼请求）。
//   对本项目"API Key 不回显"的铁律：token 只存在内存变量里，绝不写日志、绝不进返回值。
//
// ── available() 的铁律：必须同步 ────────────────────────────────────────
//   只 existsSync 探测"登录态有没有可能拿到"，绝不做网络 IO。结果缓存 30 秒，
//   因为 bot 掉线/重连会改变答案。
//
// ── 为什么解析器是个状态机而不是 JSON.parse ──────────────────────────────
//   Qzone 的动态接口返回的是 **JS 对象字面量**（key 不带引号、字符串用单引号、
//   还有 \xNN / \uNNNN 转义和裸 undefined），JSON.parse 会直接抛。正则替换试过，
//   会在"双引号字符串里套单引号"的数据上把文本改坏——只有逐字符 tokenizer 才稳。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))   // …/skills/qqzone
const SKILL_ID = 'qqzone'
const TOOL = (n) => `${SKILL_ID}__${n}`

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const QZONE = 'https://user.qzone.qq.com'
const HTTP_TIMEOUT_MS = 15000
const COOKIE_CACHE_MS = 5 * 60 * 1000

// 图片上传走独立域名（不是 /proxy/domain 那套代理），字段口径照 SnowLuma 桥里
// region src/bridge/apis/qzone.ts 的实现抄——那份是真跑通的。
const QZONE_UPLOAD = 'https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image'
const IMG_PER_POST_DEFAULT = 3
const IMG_PER_POST_HARD_MAX = 9      // 空间单条说说的图上限
const IMG_MB_DEFAULT = 8
const IMG_DOWNLOAD_TIMEOUT_MS = 30000   // 下图比调接口慢，给足时间

// ── setup 里存下来的引用（available / diagnose 可能在任何时候被调用）──
let cfgOf = () => ({})
let log = () => {}
let onebotRef = null
const debugLog = []
function dbg(step, ok, detail) {
  debugLog.push({ t: Date.now(), step, ok: !!ok, detail: String(detail ?? '').slice(0, 120) })
  if (debugLog.length > 30) debugLog.splice(0, debugLog.length - 30)
  if (ok == null) return
  const msg = `[qqzone] ${step}: ${detail ?? ''}`
  try { ok ? log(msg) : console.warn(msg) } catch { /* 日志失败不影响主流程 */ }
}

/* ══════════════════════════════════════════════════════════════════════
   一、布局探测：找到 app 根（resources/app）与 data 目录
   ══════════════════════════════════════════════════════════════════════ */

let cachedAppRoot = null
function findAppRoot() {
  if (cachedAppRoot !== null) return cachedAppRoot || null
  // 技能在 <app>/resources/app/skills/<id>，往上找带 src/skills.js 的那级
  let dir = path.resolve(HERE, '..', '..')
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(path.join(dir, 'src', 'skills.js'))) {
        cachedAppRoot = dir
        return dir
      }
    } catch { /* 权限等，继续往上 */ }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  cachedAppRoot = false
  return null
}

// data 目录候选：标准布局是 <app>/resources/app/data；净版 zip 多包了一层目录也照样命中。
function dataDirCandidates() {
  const appRoot = findAppRoot()
  const fromEnv = String(process.env.QQ_AGENT_DATA_DIR || '').trim()
  return [
    fromEnv || null,
    appRoot ? path.join(appRoot, 'data') : null,
    path.resolve(HERE, '..', '..', 'data'),
  ].filter(Boolean)
}

function dataDir() {
  for (const c of dataDirCandidates()) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c } catch { /* 继续试 */ }
  }
  return dataDirCandidates()[0]
}

// snowluma 配置目录候选（拿 accessToken 用）。同一个"陈旧副本"教训见 doujin-lookup。
function snowConfigCandidates() {
  const appRoot = findAppRoot()
  return [
    appRoot ? path.join(appRoot, 'snowluma', 'config') : null,
    path.resolve(HERE, '..', '..', 'snowluma', 'config'),
  ].filter(Boolean)
}

/* ══════════════════════════════════════════════════════════════════════
   二、纯函数工具（测试直接打这些，不打网络）
   ══════════════════════════════════════════════════════════════════════ */

/** g_tk：p_skey 的 5381 哈希，Qzone 所有接口的防伪参数。 */
export function gtk(skey) {
  let h = 5381
  const s = String(skey || '')
  for (let i = 0; i < s.length; i++) h += (h << 5) + s.charCodeAt(i)
  return (h & 0x7fffffff).toString()
}

/**
 * JS 对象字面量 → 可 JSON.parse 的字符串。逐字符扫描，同时吃得下：
 * 单/双引号字符串、\xNN、\uNNNN、\n \t \r 等控制转义、裸 true/false/null/undefined。
 */
export function jsLiteralToJson(s) {
  const str = String(s ?? '')
  let out = ''
  let i = 0
  const n = str.length
  while (i < n) {
    const ch = str[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      let inner = ''
      i++
      while (i < n) {
        const c = str[i]
        if (c === '\\') {
          const nx = str[i + 1]
          if (nx === 'x' && /^[0-9a-fA-F]{2}$/.test(str.slice(i + 2, i + 4))) {
            inner += String.fromCharCode(parseInt(str.slice(i + 2, i + 4), 16)); i += 4; continue
          }
          if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(str.slice(i + 2, i + 6))) {
            inner += String.fromCharCode(parseInt(str.slice(i + 2, i + 6), 16)); i += 6; continue
          }
          const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }[nx]
          inner += simple !== undefined ? simple : (nx ?? ''); i += 2; continue
        }
        if (c === quote) { i++; break }
        inner += c; i++
      }
      out += JSON.stringify(inner)
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let word = ''
      while (i < n && /[A-Za-z0-9_$]/.test(str[i])) { word += str[i]; i++ }
      out += word === 'undefined' || word === 'NaN' ? 'null'
        : word === 'true' || word === 'false' ? word
        : word === 'null' ? 'null'
        : JSON.stringify(word)   // 未知标识符（比如裸枚举值）按字符串保下来，别让解析炸
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 把 Qzone 返回的 `_Callback(...)` / `shine0_Callback(...)` 之类剥掉，取内部 JSON。 */
export function stripCallback(text) {
  const s = String(text ?? '').trim()
  const m = s.match(/^[A-Za-z_$][\w$]*\s*\(([\s\S]*)\)\s*;?\s*$/)
  return m ? m[1].trim() : s
}

/**
 * 从响应里截出第一个括号配平的 {...} / [...] 块。stripCallback 的正则要求
 * `callback(...)` 独占整个响应，但上传接口偶尔会在收尾 `);` 后再吐一段尾巴
 * （或连着第二个 callback），此时正则不匹配、原样放行，jsLiteralToJson 会把
 * 开头的 `callback` 变成 10 字符的字符串 "callback"，JSON.parse 就报
 * "Unexpected non-whitespace character after JSON at position 10"。按字符扫描
 * 配平（跳过引号字符串和 \ 转义）不怕任何前后垃圾。
 */
export function extractJsonBlock(text) {
  const str = String(text ?? '')
  let start = -1
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '{' || str[i] === '[') { start = i; break }
  }
  if (start === -1) return str
  let depth = 0
  let inStr = false
  let quote = ''
  for (let i = start; i < str.length; i++) {
    const ch = str[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === quote) inStr = false
      continue
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return str.slice(start, i + 1)
    }
  }
  return str.slice(start)
}

/** 说说 HTML → 人读摘要：解 \xNN、去标签、解实体、收空白、截断。 */
export function htmlToText(html, maxLen = 300) {
  let s = String(html ?? '')
  s = s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&#[0-9]+;/g, (m2) => { try { return String.fromCharCode(parseInt(m2.slice(2, -1), 10)) } catch { return m2 } })
  s = s.replace(/\s+/g, ' ').trim()
  // Qzone 在正文后依次拼"展开全文"/"N 人觉得很赞"/"浏览 N"等尾巴（去标签后数字和汉字间会有空格），
  // 从最早出现的那一处砍掉
  const cut = s.search(/\d+\s*人觉得很赞|浏览\s*\d|展开全文/)
  if (cut > 0) s = s.slice(0, cut).trim()
  s = s.replace(/[，,、\s]*$/, '').trim()
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…'
  return s
}

export function isValidUin(u) {
  const s = String(u ?? '').trim()
  return /^\d{5,11}$/.test(s)
}

export function isValidTid(t) {
  const s = String(t ?? '').trim()
  return /^[0-9a-f]{24}$/.test(s)
}

/**
 * 图片引用 → { mid, index }。只认聊天记录里的消息号（#12345；一条消息多图时
 * #12345:2 表示第 2 张）。其余形状——路径、URL、base64://、file://、表情 id、
 * 空串——一律 null。这个函数是"模型拿不到任意图"的唯一闸门，别放宽。
 */
export function parseImageRef(v) {
  const m = String(v ?? '').trim().match(/^#?(-?\d{1,19})(?::([1-9]\d{0,2}))?$/)
  if (!m) return null
  const mid = m[1]
  if (Number(mid) === 0) return null            // 0 不是合法消息号
  return { mid, index: m[2] ? Number(m[2]) : 1 }
}

/**
 * 图片魔数校验。Qzone 只吃这几种；顺手挡掉"把任意文件当图上传"
 * （与 src/tts.js 的 isAudio 一个纪律：出网前先验明正身）。
 */
export function imageKindOf(buf) {
  if (!buf || buf.length < 12) return null
  const head = (n) => buf.subarray(0, n).toString('latin1')
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (head(8) === '\x89PNG\r\n\x1a\n') return 'png'
  if (head(6) === 'GIF87a' || head(6) === 'GIF89a') return 'gif'
  if (head(4) === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (head(2) === 'BM') return 'bmp'
  return null
}

/** 清理用户可见文本：去控制字符、压空白、限长。 */
export function sanitizeText(s, maxLen) {
  let t = String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length > maxLen) t = t.slice(0, maxLen)
  return t
}

/** 本地时区 'YYYY-MM-DD HH:mm'，状态文件里给人看的。 */
export function fmtLocal(ts) {
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ══════════════════════════════════════════════════════════════════════
   三、状态与限频：data/qqzone/state.json
   ══════════════════════════════════════════════════════════════════════ */

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function defaultState() {
  return { posts: [], diaries: [], likes: [], comments: [], lastBrowse: 0, feedCache: null, acted: {} }
}

function stateFile() {
  return path.join(dataDir(), SKILL_ID, 'state.json')
}

export function loadState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8')
    const j = JSON.parse(raw)
    return { ...defaultState(), ...j, acted: (j && typeof j.acted === 'object' && j.acted) || {} }
  } catch {
    return defaultState()
  }
}

export function saveState(st) {
  const file = stateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8')
  fs.renameSync(tmp, file)   // 原子替换：崩在半路不会留下半个 JSON
}

/**
 * 限频判定（纯函数，方便测试）。
 *   posts   按"今天 0 点起"计（每天发条数要严格）
 *   likes/comments 按滑动 1 小时窗口计
 * 返回 { ok, reason? }
 */
export function checkCap(st, kind, cfg, now = Date.now()) {
  const dayStart = new Date(now).setHours(0, 0, 0, 0)
  if (kind === 'diary') {
    // 日记单独按天限频：和 postsPerDay 是两条闸，发日记不占普通说说的额度
    const cap = Math.max(0, Number(cfg.diaryPerDay) || 0)
    const n = (st.diaries || []).filter((t) => t >= dayStart).length
    return n < cap ? { ok: true } : { ok: false, reason: `今天的日记已经写过了（每天 ${cap} 篇），明天再来记吧` }
  }
  if (kind === 'post') {
    const cap = Math.max(0, Number(cfg.postsPerDay) || 0)
    const n = (st.posts || []).filter((t) => t >= dayStart).length
    return n < cap ? { ok: true } : { ok: false, reason: `今天已发 ${n} 条说说（上限 ${cap} 条/天），明天再来吧` }
  }
  const key = kind === 'like' ? 'likes' : 'comments'
  const cfgKey = kind === 'like' ? 'likesPerHour' : 'commentsPerHour'
  const cap = Math.max(0, Number(cfg[cfgKey]) || 0)
  const n = (st[key] || []).filter((t) => now - t < HOUR_MS).length
  return n < cap
    ? { ok: true }
    : { ok: false, reason: `最近一小时已${kind === 'like' ? '点赞' : '评论'} ${n} 次（上限 ${cap} 次/小时），歇一会吧` }
}

/** 记录一次成功写入并落盘。 */
export function recordAct(st, kind, feedId, now = Date.now()) {
  if (kind === 'diary') st.diaries = [...(st.diaries || []), now]
  if (kind === 'post') st.posts = [...(st.posts || []), now]
  if (kind === 'like') st.likes = [...(st.likes || []), now]
  if (kind === 'comment') st.comments = [...(st.comments || []), now]
  if (feedId) {
    st.acted = st.acted || {}
    st.acted[feedId] = { kind, t: now }
    const ids = Object.keys(st.acted)
    if (ids.length > 300) {                    // 老的互动记忆定期清掉
      ids.sort((a, b) => (st.acted[a].t || 0) - (st.acted[b].t || 0))
      for (let i = 0; i < ids.length - 300; i++) delete st.acted[ids[i]]
    }
  }
  saveState(st)
}

/* ══════════════════════════════════════════════════════════════════════
   四、登录态：cookie / g_tk 的获取与缓存
   ══════════════════════════════════════════════════════════════════════ */

let cookieCache = null   // { cookies: Map, gtk2, selfUin, ts }

function cookieHeader(cookies) {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * OneBot get_cookies 的 cookies 字段三种实现三种形状，都得吃：
 *   字符串 "k=v; k=v"（OneBot v11 标准 / SnowLuma 实测）
 *   对象 {k: v, ...}
 *   数组 [{name, value}, ...]
 * 值原样保留（Qzone 要求分号等特殊字符留在值里），这里不做 decodeURIComponent。
 */
export function parseCookiesField(v) {
  const map = new Map()
  if (typeof v === 'string') {
    for (const part of v.split(';')) {
      const idx = part.indexOf('=')
      if (idx <= 0) continue
      const k = part.slice(0, idx).trim()
      const val = part.slice(idx + 1).trim()
      if (k && val) map.set(k, val)
    }
    return map
  }
  if (Array.isArray(v)) {
    for (const c of v) {
      if (c && c.name != null && c.value != null && c.value !== '') map.set(String(c.name), String(c.value))
    }
    return map
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (val != null && val !== '') map.set(String(k), String(val))
    }
  }
  return map
}

async function fetchCookiesViaOnebot(token, base) {
  base = String(base || onebotRef?.httpUrl || '').replace(/\/$/, '')
  if (!base) throw new Error('onebot httpUrl 不可用')
  const res = await fetch(`${base}/get_cookies`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ domain: 'qzone.qq.com' }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || (body.status !== 'ok' && body.retcode !== 0)) {
    throw new Error(`get_cookies 失败: HTTP ${res.status} retcode=${body.retcode ?? body.status}`)
  }
  return parseCookiesField(body.data?.cookies ?? body.data?.cookie)
}

// 从 snowluma 的 onebot_*.json 里收集 http 服务的 {token, base}。
// token 只进内存，绝不写日志——本项目对"密钥回显"有过教训。
// base 取配置里的 host/port（缺省 127.0.0.1:3000），因为这条路恰恰是在
// ctx.onebot 还没拿到手（或不存在）时用的，不能依赖 onebotRef.httpUrl。
function readSnowHttpServices() {
  const out = []
  for (const dir of snowConfigCandidates()) {
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => /^onebot_.*\.json$/i.test(f)) } catch { continue }
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        const servers = j?.networks?.httpServers || j?.httpServers || []
        for (const s of Array.isArray(servers) ? servers : []) {
          if (!s) continue
          const host = s.host || '127.0.0.1'
          const port = Number(s.port) || 3000
          out.push({ token: s.accessToken ? String(s.accessToken) : '', base: `http://${host}:${port}` })
        }
      } catch { /* 单个配置文件坏了不影响别的 */ }
    }
  }
  return out
}

async function acquireCookies() {
  const now = Date.now()
  if (cookieCache && now - cookieCache.ts < COOKIE_CACHE_MS && cookieCache.cookies.get('p_skey')) {
    return cookieCache
  }
  // 第一路：走 ctx.onebot 的常规通道（应用自己配了 token 时一条就通）
  if (onebotRef && typeof onebotRef.call === 'function') {
    try {
      const data = await onebotRef.call('get_cookies', { domain: 'qzone.qq.com' }, HTTP_TIMEOUT_MS)
      const map = parseCookiesField(data?.cookies ?? data?.cookie)
      if (map.get('p_skey')) {
        cookieCache = finishCookies(map, now)
        dbg('cookies', true, '经由 ctx.onebot 拿到 p_skey')
        return cookieCache
      }
      dbg('cookies', null, 'ctx.onebot 通道没拿到 p_skey')
    } catch (e) {
      dbg('cookies', null, `ctx.onebot 通道失败：${e?.message ?? e}`)
    }
  }
  // 第二路：读 snowluma 配置拿 token/base，自己拼 get_cookies（SnowLuma 对敏感接口强制校验 token）
  for (const svc of readSnowHttpServices()) {
    try {
      const map = await fetchCookiesViaOnebot(svc.token, svc.base)
      if (map.get('p_skey')) {
        cookieCache = finishCookies(map, now)
        dbg('cookies', true, '经由 snowluma 配置 token 拿到 p_skey')
        return cookieCache
      }
    } catch { /* 换下一个 token 试 */ }
  }
  dbg('cookies', false, '两路都没拿到 p_skey')
  throw new Error('拿不到 Qzone 登录态（get_cookies 失败）。确认 bot 账号在线、SnowLuma 已登录。')
}

function finishCookies(map, now) {
  const selfUin = (map.get('pt2gguin') || map.get('uin') || '').replace(/^o0*/, '')
  return { cookies: map, gtk2: gtk(map.get('p_skey')), selfUin, ts: now }
}

/* ══════════════════════════════════════════════════════════════════════
   五、Qzone HTTP 封装
   ══════════════════════════════════════════════════════════════════════ */

async function qzoneGet(urlPath, params, cookies) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${QZONE}${urlPath}?${qs}`, {
    headers: { 'user-agent': UA, cookie: cookieHeader(cookies) },
    redirect: 'manual',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const text = await res.text()
  if (res.status >= 300 && res.status < 400) throw new Error('Qzone 把请求重定向到了登录页（登录态失效）')
  return text
}

async function qzonePost(urlPath, form, cookies) {
  // urlPath 允许是绝对地址：图片上传在 up.qzone.qq.com，不在 user.qzone.qq.com 的代理下。
  const url = /^https?:\/\//i.test(urlPath) ? urlPath : `${QZONE}${urlPath}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      cookie: cookieHeader(cookies),
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      referer: `${QZONE}/`
    },
    redirect: 'manual',
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const text = await res.text()
  if (res.status >= 300 && res.status < 400) throw new Error('Qzone 把请求重定向到了登录页（登录态失效）')
  return text
}

/** 统一的成功判定：剥 callback 后 code===0。 */
function parseQzoneJson(text, what) {
  let j
  try {
    j = JSON.parse(jsLiteralToJson(stripCallback(text)))
  } catch (e) {
    throw new Error(`${what} 返回无法解析（${String(e?.message ?? e).slice(0, 80)}）`)
  }
  if (!j || j.code !== 0) {
    throw new Error(`${what} 失败: code=${j?.code ?? '?'} ${j?.message || j?.msg || ''}`.trim())
  }
  return j
}

/**
 * 上传 / 发布这两个接口的响应**不一定带 code 字段**（成功时可能整个没有），
 * 所以不能复用上面那个"必须 code===0"的严格判定，否则成功会被当成失败。
 * 口径照 SnowLuma 桥：code / subcode 只在是数字且非 0 时才算错。
 * 另外上传接口偶尔在 callback( 前面吐一段垃圾、或在收尾 ); 后再挂尾巴/连发
 * 第二个 callback——前面先切到 callback，后面交给 extractJsonBlock 配平截取。
 */
export function parseQzoneLooseJson(text, what) {
  let s = String(text ?? '').trim()
  const at = s.indexOf('callback')
  if (at > 0) s = s.slice(at)
  let j
  try {
    j = JSON.parse(jsLiteralToJson(extractJsonBlock(s)))
  } catch (e) {
    throw new Error(`${what}返回无法解析（${String(e?.message ?? e).slice(0, 80)}）`)
  }
  for (const k of ['code', 'subcode']) {
    if (typeof j?.[k] === 'number' && j[k] !== 0) {
      throw new Error(`${what}失败: ${k}=${j[k]} ${j?.message || j?.msg || ''}`.trim())
    }
  }
  return j || {}
}

/* ══════════════════════════════════════════════════════════════════════
   五点五、带图说说：聊天里的图 → Qzone 图床 → richval
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 把模型给的消息号换成"那张图"的定位符。**纯本地读，不出网** ——
 * 坏 id / 没图的消息 / 越界的第 N 张都在这里死掉，绝不带着脏参数去打 Qzone。
 */
export function resolveChatImage(ctx, ref) {
  const store = ctx?.store
  if (!store || typeof store.findByMid !== 'function') {
    return { error: '这个会话拿不到消息存档，引用不了聊天里的图（这次只能发纯文字）' }
  }
  let entry = null
  try {
    entry = store.findByMid(ctx.chatKey, ref.mid)
  } catch (e) {
    return { error: `查消息 #${ref.mid} 时存档报错了（${String(e?.message ?? e).slice(0, 40)}）` }
  }
  if (!entry) return { error: `聊天记录里没有消息 #${ref.mid}。id 只能用聊天记录里真出现过的那个，别编` }
  const imgs = (Array.isArray(entry.media) ? entry.media : []).filter((m) => m && m.kind === 'image' && (m.url || m.file))
  if (!imgs.length) return { error: `消息 #${ref.mid} 里没有图片（[语音]/[文件]/纯文字都当不了图发）` }
  if (ref.index > imgs.length) {
    return { error: `消息 #${ref.mid} 只有 ${imgs.length} 张图，没有第 ${ref.index} 张` }
  }
  const pick = imgs[ref.index - 1]
  return { mid: ref.mid, index: ref.index, url: String(pick.url || ''), file: String(pick.file || ''), total: imgs.length }
}

/**
 * 下载那张图的字节。QQ 的图片直链会过期，所以：先用存档里的地址，
 * 失败了再让 OneBot 重签一次（onebot.freshImageUrlOfMessage），跟 send_sticker 一个思路。
 */
async function downloadChatImage(img, maxBytes) {
  const attempt = async (u) => {
    const res = await fetch(u, {
      headers: { 'user-agent': UA, referer: `${QZONE}/` },
      signal: AbortSignal.timeout(IMG_DOWNLOAD_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error('下回来是空的')
    return buf
  }

  const urls = img.url ? [img.url] : []
  let lastErr = '存档里没有可用的图片地址'
  for (const u of urls) {
    try {
      const buf = await attempt(u)
      return finishDownload(buf, maxBytes)
    } catch (e) { lastErr = String(e?.message ?? e).slice(0, 60) }
  }
  // 直链过期兜底：问 OneBot 要这条消息的新地址
  if (typeof onebotRef?.freshImageUrlOfMessage === 'function') {
    try {
      const fresh = await onebotRef.freshImageUrlOfMessage(img.mid, img.file)
      if (fresh && !urls.includes(fresh)) {
        const buf = await attempt(fresh)
        return finishDownload(buf, maxBytes)
      }
    } catch (e) { lastErr = String(e?.message ?? e).slice(0, 60) }
  }
  return { error: `图片下载不了：${lastErr}` }
}

function finishDownload(buf, maxBytes) {
  if (buf.length > maxBytes) {
    return { error: `图片 ${(buf.length / 1048576).toFixed(1)}MB，超过上限 ${(maxBytes / 1048576).toFixed(0)}MB，发不了` }
  }
  const kind = imageKindOf(buf)
  if (!kind) return { error: '那张图不是 Qzone 认的格式（只支持 jpg/png/gif/webp/bmp）' }
  return { buf, kind }
}

/**
 * 传到 Qzone 图床，换回 richval（发说说时靠它挂图）。
 * 返回的 richval 形如 `,albumid,lloc,lloc,type,height,width,,height,width`；
 * 多图就把多个 richval 用 \t 连起来交给发布接口。
 */
async function uploadQzoneImage(auth, buf) {
  const { cookies, gtk2, selfUin } = auth
  const form = {
    filename: 'filename',
    uin: selfUin,
    skey: cookies.get('skey') || '',
    zzpaneluin: selfUin,
    p_uin: selfUin,
    p_skey: cookies.get('p_skey') || '',
    uploadtype: '1',
    albumtype: '7',
    exttype: '0',
    refer: 'shuoshuo',
    output_type: 'jsonhtml',
    charset: 'utf-8',
    output_charset: 'utf-8',
    upload_hd: '1',
    hd_width: '2048',
    hd_height: '10000',
    hd_quality: '96',
    backUrls: `http://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image,http://119.147.64.75/cgi-bin/upload/cgi_upload_image&url=${QZONE_UPLOAD}?g_tk=${gtk2}`,
    base64: '1',
    jsonhtml_callback: 'callback',
    picfile: buf.toString('base64'),
    qzreferrer: `${QZONE}/${selfUin}/main`
  }
  const j = parseQzoneLooseJson(await qzonePost(`${QZONE_UPLOAD}?g_tk=${gtk2}`, form, cookies), '上传图片')
  const d = j?.data
  if (!d?.albumid || !d?.lloc || !d?.url) throw new Error('上传图片失败：响应缺少 albumid/lloc/url')
  const h = Number(d.height) || 0
  const w = Number(d.width) || 0
  const t = Number(d.type) || 0
  return {
    richval: `,${d.albumid},${d.lloc},${d.lloc},${t},${h},${w},,${h},${w}`,
    url: String(d.url),
    width: w,
    height: h
  }
}

/* ══════════════════════════════════════════════════════════════════════
   六、四个工具的实现
   ══════════════════════════════════════════════════════════════════════ */

async function doPostMood(content, images, ctx) {
  const cfg = cfgOf()
  const text = sanitizeText(content, Math.max(1, Number(cfg.maxPostChars) || 500))
  if (!text) return { content: '说说内容不能为空', isError: true }

  // ── 图片：全部本地校验/解析完再出网（顺序别调，脏参数不许碰网络）──
  const wanted = Array.isArray(images) ? images : (images == null || images === '' ? [] : [images])
  const picked = []
  if (wanted.length) {
    if (cfg.allowChatImages === false) {
      return { content: '带图说说被关掉了（设置里"允许引用聊天里的图"是关的），这次只能发纯文字', isError: true }
    }
    const cap = Math.min(IMG_PER_POST_HARD_MAX, Math.max(1, Number(cfg.maxImagesPerPost) || IMG_PER_POST_DEFAULT))
    if (wanted.length > cap) {
      return { content: `一条说说最多带 ${cap} 张图，这次给了 ${wanted.length} 张`, isError: true }
    }
    for (const raw of wanted) {
      const ref = parseImageRef(raw)
      if (!ref) {
        return {
          content: `图片引用「${String(raw ?? '').slice(0, 40)}」不认。只能给聊天记录里的消息号（如 #12345，一条消息多图时用 #12345:2 指第 2 张）；路径、网址、base64 一律不收`,
          isError: true
        }
      }
      const got = resolveChatImage(ctx, ref)
      if (got.error) return { content: got.error, isError: true }
      picked.push(got)
    }
  }

  const st = loadState()
  const capCheck = checkCap(st, 'post', cfg)
  if (!capCheck.ok) return { content: capCheck.reason, isError: true }

  const auth = await acquireCookies()
  if (!auth.selfUin) return { content: '识别不出自己的 QQ 号（cookie 里缺 pt2gguin/uin）', isError: true }

  // 全部图传成功再发说说：传一半就发，空间里会留下一条缺图的说说，收不回来
  const maxBytes = Math.min(32, Math.max(1, Number(cfg.maxImageMB) || IMG_MB_DEFAULT)) * 1024 * 1024
  const richvals = []
  for (const img of picked) {
    const dl = await downloadChatImage(img, maxBytes)
    if (dl.error) {
      dbg('image', false, `#${img.mid} 下载失败：${dl.error}`)
      return { content: dl.error, isError: true }
    }
    try {
      const up = await uploadQzoneImage(auth, dl.buf)
      richvals.push(up.richval)
      dbg('image', true, `#${img.mid} 已上传（${dl.kind} ${up.width}x${up.height}）`)
    } catch (e) {
      dbg('image', false, `#${img.mid} 上传失败：${String(e?.message ?? e).slice(0, 100)}`)
      return { content: `图片上传失败：${String(e?.message ?? e).slice(0, 120)}`, isError: true }
    }
  }

  const withPic = richvals.length > 0
  const form = {
    syn_tweet_verson: '1',
    paramstr: '1',
    pic_template: '',
    richtype: withPic ? '1' : '',
    richval: richvals.join('\t'),
    special_url: '',
    subrichtype: '',
    who: '1',
    con: text,
    feedversion: '1',
    ver: '1',
    ugc_right: '1',
    to_sign: '0',
    hostuin: auth.selfUin,
    code_version: '1',
    format: 'json',
    qzreferrer: `${QZONE}/${auth.selfUin}`
  }
  let tid = ''
  try {
    const j = parseQzoneLooseJson(
      await qzonePost(`/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${auth.gtk2}`, form, auth.cookies),
      '发说说'
    )
    // 没有 tid 就是没发成：空间拒稿时也返回 200，只有 tid 是"服务器真收下了"的凭据
    tid = String(j?.t1_tid ?? j?.tid ?? '')
    if (!tid) throw new Error('发说说失败：响应里没有 tid（多半被空间拒了，比如内容含敏感词或发得太频繁）')
  } catch (e) {
    dbg('post_mood', false, String(e?.message ?? e).slice(0, 120))
    return { content: String(e?.message ?? e).slice(0, 200), isError: true }
  }
  recordAct(st, 'post', null)
  dbg('post_mood', true, `tid=${tid}，${text.length} 字${withPic ? `，${richvals.length} 图` : ''}`)
  return {
    content: `已发到你的 QQ 空间：「${text.slice(0, 60)}${text.length > 60 ? '…' : ''}」${withPic ? `（带 ${richvals.length} 张图）` : ''}`
  }
}

function feedToItem(f) {
  const uin = String(f?.uin ?? '')
  const tid = String(f?.key ?? '')
  if (!isValidUin(uin) || !isValidTid(tid)) return null
  const abstime = Number(f?.abstime) || 0
  const nick = String(f?.nickname ?? '').trim() || uin
  const text = htmlToText(f?.html ?? '')
  if (!text) return null
  // 从 HTML 尾巴里数"N 人觉得很赞"
  const rawHtml = String(f?.html ?? '').replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  const likeM = rawHtml.match(/(\d+)\s*人觉得很赞/)
  const likes = likeM ? Number(likeM[1]) : 0
  const cmts = Array.isArray(f?.mergeData) ? f.mergeData.length : (f?.commentcount != null ? Number(f.commentcount) : 0)
  return { uin, tid, nick, time: fmtLocal(abstime * 1000), likes, comments: cmts, text }
}

async function fetchFeeds(count) {
  const { cookies, gtk2, selfUin } = await acquireCookies()
  if (!selfUin) throw new Error('识别不出自己的 QQ 号（cookie 里缺 pt2gguin/uin）')
  const text = await qzoneGet('/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more', {
    uin: selfUin,
    scope: '0',
    view: '1',
    filter: 'all',
    flag: '1',
    applist: 'all',
    pagenum: '1',
    aisortEndTime: '0',
    aisortOffset: '0',
    aisortBeginTime: '0',
    begintime: '0',
    format: 'json',
    g_tk: gtk2,
    useutf8: '1',
    outputhtmlfeed: '1'
  }, cookies)
  const j = parseQzoneJson(text, '拉取动态')
  const rawItems = j?.data?.data
  if (!Array.isArray(rawItems)) return { items: [], hasMore: false }
  const items = []
  for (const f of rawItems) {
    if (items.length >= count) break
    if (String(f?.appid ?? '311') !== '311') continue   // 只认"说说"，过滤相册/分享等多媒体动态
    const it = feedToItem(f)
    if (it) items.push(it)
  }
  return { items, hasMore: !!j?.data?.main?.hasMoreFeeds }
}

async function doListFeeds(countArg) {
  const cfg = cfgOf()
  const count = Math.min(20, Math.max(1, Number(countArg) || Number(cfg.maxFeeds) || 10))
  const st = loadState()
  const now = Date.now()
  const interval = Math.max(0, Number(cfg.browseIntervalMinutes) || 0) * 60000

  // 刷动态是只读但带"打扰度"：太频繁的调用直接喂上一次缓存
  if (interval > 0 && now - (st.lastBrowse || 0) < interval && st.feedCache) {
    const cached = st.feedCache.items.slice(0, count)
    return { content: formatFeeds(cached, st, true) }
  }

  const { items, hasMore } = await fetchFeeds(count)
  st.lastBrowse = now
  st.feedCache = { t: now, items }
  saveState(st)
  dbg('list_feeds', true, `${items.length} 条`)
  return { content: formatFeeds(items, st, false, hasMore) }
}

function formatFeeds(items, st, fromCache, hasMore = false) {
  if (!items.length) return '好友动态里暂时没有能看懂的说说（可能有图片/转发类动态被跳过了）。'
  const acted = st.acted || {}
  const lines = items.map((f, i) => {
    const mark = acted[`${f.uin}:${f.tid}`] ? '（已互动过）' : ''
    const likePart = f.likes > 0 ? `，${f.likes} 人觉得很赞` : ''
    const cmtPart = f.comments > 0 ? `，${f.comments} 条评论` : ''
    return `${i + 1}. [${f.nick}(${f.uin}) ${f.time}${likePart}${cmtPart}] ${f.text}（tid: ${f.tid}）${mark}`
  })
  const head = fromCache ? '（距上次刷动态不久，这是缓存的上一次结果）' : ''
  const tail = hasMore ? '\n还有更早的动态，需要的话可以说"再看几条"。' : ''
  return `${head}刷到 ${items.length} 条好友说说：\n${lines.join('\n')}\n想点赞用 qqzone__like_feed，想评论用 qqzone__comment_feed，uin 和 tid 照抄上面。${tail}`.trim()
}

async function doLikeFeed(uin, tid) {
  const cfg = cfgOf()
  if (!isValidUin(uin)) return { content: `uin 不合法：${String(uin).slice(0, 20)}（必须是 5~11 位纯数字 QQ 号）`, isError: true }
  if (!isValidTid(tid)) return { content: `tid 不合法：${String(tid).slice(0, 30)}（必须是 24 位十六进制，从 list_feeds 原样抄回）`, isError: true }
  const feedId = `${String(uin).trim()}:${String(tid).trim()}`

  const st = loadState()
  if (st.acted?.[feedId]) return { content: '这条已经互动过了，别重复点。', isError: true }
  const cap = checkCap(st, 'like', cfg)
  if (!cap.ok) return { content: cap.reason, isError: true }

  const { cookies, gtk2, selfUin } = await acquireCookies()
  const unikey = `${QZONE}/${uin}/mood/${tid}`
  const form = {
    qzreferrer: `${QZONE}/${selfUin}`,
    opuin: selfUin,
    unikey,
    curkey: unikey,
    appid: '311',
    from: '1',
    typeid: '0',
    abstime: String(Math.floor(Date.now() / 1000)),
    fid: String(tid),
    active: '0',
    format: 'json',
    fupdate: '1'
  }
  parseQzoneJson(
    await qzonePost(`/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=${gtk2}`, form, cookies),
    '点赞'
  )
  recordAct(st, 'like', feedId)
  dbg('like_feed', true, feedId)
  return { content: `已给 ${uin} 的这条说说点赞。` }
}

async function doCommentFeed(uin, tid, content) {
  const cfg = cfgOf()
  if (!isValidUin(uin)) return { content: `uin 不合法：${String(uin).slice(0, 20)}（必须是 5~11 位纯数字 QQ 号）`, isError: true }
  if (!isValidTid(tid)) return { content: `tid 不合法：${String(tid).slice(0, 30)}（必须是 24 位十六进制，从 list_feeds 原样抄回）`, isError: true }
  const text = sanitizeText(content, Math.max(1, Number(cfg.maxCommentChars) || 200))
  if (!text) return { content: '评论内容不能为空', isError: true }
  const feedId = `${String(uin).trim()}:${String(tid).trim()}`

  const st = loadState()
  if (st.acted?.[feedId]) return { content: '这条已经互动过了，别重复刷评论。', isError: true }
  const cap = checkCap(st, 'comment', cfg)
  if (!cap.ok) return { content: cap.reason, isError: true }

  const { cookies, gtk2, selfUin } = await acquireCookies()
  const form = {
    topicId: `${uin}_${tid}__1`,
    uin: selfUin,
    hostUin: String(uin),
    feedsType: '100',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    plat: 'qzone',
    source: 'ic',
    platformid: '52',
    format: 'fs',
    ref: 'feeds',
    content: text
  }
  parseQzoneJson(
    await qzonePost(`/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${gtk2}`, form, cookies),
    '评论'
  )
  recordAct(st, 'comment', feedId)
  dbg('comment_feed', true, `${feedId} «${text.slice(0, 20)}»`)
  return { content: `已在 ${uin} 的说说下评论：「${text}」` }
}

/* ══════════════════════════════════════════════════════════════════════
   六点九、日记：素材收集（纯本地） + 排版出图 + 发说说
   ══════════════════════════════════════════════════════════════════════ */

export function localDayStart(now = Date.now()) {
  return new Date(now).setHours(0, 0, 0, 0)
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** 存档里所有会话的 chatKey（热段 + 冷段文件名并集）。 */
export function listArchiveChats(messagesDir, coldDir) {
  const keys = new Set()
  try {
    for (const f of fs.readdirSync(messagesDir)) {
      if (/^(group|private)_.+\.json$/.test(f)) keys.add(f.replace(/\.json$/, ''))
    }
  } catch { /* 目录不存在就当没有 */ }
  try {
    for (const f of fs.readdirSync(coldDir)) {
      const m = f.match(/^((?:group|private)_.+)\.\d{5}\.json$/)
      if (m) keys.add(m[1])
    }
  } catch { /* 同上 */ }
  return [...keys]
}

function chatLabel(chatKey) {
  const m = String(chatKey).match(/^(group|private)_(\d+)$/)
  if (!m) return String(chatKey)
  return m[1] === 'group' ? `群 ${m[2]}` : `私聊 ${m[2]}`
}

/** 一条存档消息 → 「HH:mm 谁：内容」一行。控制字符、超长、CQ 噪音都在这里收掉。 */
export function chatLineOf(m) {
  const d = new Date(Number(m?.ts) || 0)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const who = m?.self ? '我' : String(m?.senderName || '某人').replace(/\s+/g, ' ').slice(0, 14)
  let text = String(m?.text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > 100) text = text.slice(0, 99) + '…'
  const media = Array.isArray(m?.media) && m.media.length ? ' [图]' : ''
  return `${hhmm} ${who}：${text || (media ? media.trim() : '…')}${text ? media : ''}`
}

/**
 * 当天的聊天素材。messagesDir 是热段目录（<data>/messages），冷段在
 * <data>/messages-cold（<chatKey>.NNNNN.json，seq 升序）——两段都读，按天过滤。
 * 每个会话最多取最近 msgsPerChat 条，会话按今天消息数排座次，最多 maxChats 个，
 * 全部行加起来不超 maxTotalChars（超了就整段会话丢弃，不切半行）。
 */
export function collectTodayMessages(messagesDir, coldDir, opts = {}, now = Date.now()) {
  const dayStart = localDayStart(now)
  const msgsPerChat = Math.min(500, Math.max(10, Number(opts.msgsPerChat) || 80))
  const maxChats = Math.min(30, Math.max(1, Number(opts.maxChats) || 8))
  const maxTotalChars = Math.min(60000, Math.max(2000, Number(opts.maxTotalChars) || 14000))

  const perChat = []
  for (const chatKey of listArchiveChats(messagesDir, coldDir)) {
    const files = []
    try {
      files.push(...fs.readdirSync(coldDir)
        .filter((f) => f.startsWith(chatKey + '.') && /\.\d{5}\.json$/.test(f))
        .sort())                                   // 字典序 == seq 升序（补零定长）
    } catch { /* 冷段读不了就只有热段 */ }
    files.push(chatKey + '.json')                  // 热段一定在最后（文件名不带 .NNNNN，不会混进上面那批）
    const today = []
    for (const f of files) {
      const j = readJsonSafe(/\.\d{5}\.json$/.test(f) ? path.join(coldDir, f) : path.join(messagesDir, f))
      const list = Array.isArray(j?.messages) ? j.messages : []
      for (const m of list) {
        const ts = Number(m?.ts) || 0
        if (ts >= dayStart && ts <= now + 60000) today.push(m)
      }
    }
    if (today.length) perChat.push({ chatKey, count: today.length, latest: today[today.length - 1], today })
  }

  // 今天话最多的会话排前面；同样多比谁最后说话
  perChat.sort((a, b) => (b.count - a.count) || (b.latest.ts - a.latest.ts))

  const chats = []
  let dropped = 0
  let used = 0
  for (const c of perChat) {
    if (chats.length >= maxChats) { dropped += 1; continue }
    const picked = c.today.slice(-msgsPerChat)
    const lines = picked.map(chatLineOf)
    const cost = lines.join('\n').length + 40
    if (used + cost > maxTotalChars) { dropped += 1; continue }
    used += cost
    chats.push({ chatKey: c.chatKey, label: chatLabel(c.chatKey), count: c.count, lines })
  }
  return { chats, dropped }
}

/**
 * 「世界与事件」插件的两样原料，软依赖：插件没装 / 没写世界观 / 账本文件不存在，
 * 都返回空串，日记照写——只是少了背景。
 */
export function readWorldMaterial(dataDir, cfg = {}, now = Date.now()) {
  const dayStart = localDayStart(now)
  const worldbookChars = Math.min(8000, Math.max(200, Number(cfg.worldbookChars) || 2000))

  const conf = readJsonSafe(path.join(dataDir, 'config.json'))
  const lsConf = conf?.skills?.['life-system']
  const ledger = readJsonSafe(path.join(dataDir, 'life-events.json'))
  // 插件在不在的判据：config 里有它的配置段，或落过账本文件。两个都没有视为没装。
  const installed = lsConf != null || ledger != null

  let worldbook = ''
  const raw = String(lsConf?.worldbook ?? '').trim()
  if (raw) {
    const marker = '…（世界观过长已节选）'
    worldbook = raw.length > worldbookChars
      ? raw.slice(0, Math.max(1, worldbookChars - marker.length - 1)) + marker
      : raw
  }

  const facts = []
  const map = ledger?.facts && typeof ledger.facts === 'object' ? ledger.facts : {}
  for (const entry of Object.values(map)) {
    const at = Number(entry?.at) || 0
    const text = String(entry?.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    // 只取今天记下的（账本自带半衰期，昨天的旧事不该进今天的日记）
    if (at >= dayStart && at <= now + 60000) {
      const d = new Date(at)
      facts.push({ at, line: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${text}` })
    }
  }
  facts.sort((a, b) => a.at - b.at)
  return { installed, worldbook, facts: facts.map((f) => f.line) }
}

export function buildDiaryDigest({ chats, world, dropped, now = Date.now() }) {
  const d = new Date(now)
  const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const p2 = (x) => String(x).padStart(2, '0')
  const dateLabel = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${weeks[d.getDay()]}`

  const out = []
  out.push(`【日记素材 · ${dateLabel}】`)
  out.push('（这是给你写日记用的原料，不是日记本身。写完调 qqzone__post_diary 发出。）')
  out.push('')
  if (world.installed === false) {
    // 没装「世界与事件」：两段原料都没有，明说跳过，别让模型对着占位文案编世界观
    out.push('【你所处的世界】（未装「世界与事件」插件，世界观与近况账本这次跳过——别编世界观，就写普通日常）')
    out.push('')
  } else {
    out.push('【你所处的世界（世界观节选，用来对齐"你在哪、今天是什么日子"）】')
    out.push(world.worldbook || '（「世界与事件」插件里还没有世界观文本）')
    out.push('')
    out.push('【你的近况账本（今天）】')
    out.push(world.facts.length ? world.facts.map((l) => `- ${l}`).join('\n') : '（今天账本还没有新条目）')
    out.push('')
  }
  if (chats.length) {
    out.push(`【今天的聊天】共 ${chats.length} 个会话${dropped ? `（另有 ${dropped} 个会话超出上限没放进来）` : ''}`)
    for (const c of chats) {
      out.push(`── ${c.label}（今天 ${c.count} 句${c.count > c.lines.length ? `，取最近 ${c.lines.length} 句` : ''}）──`)
      out.push(c.lines.join('\n'))
    }
  } else {
    out.push('【今天的聊天】今天还没有任何会话的记录，日记就写你自己的日程和心境。')
  }
  return out.join('\n')
}

async function doCollectDiary(ctx) {
  const deny = gateByContext(ctx)
  if (deny) return { content: deny, isError: true }
  const cfg = cfgOf()
  const messagesDir = path.join(dataDir(), 'messages')
  const coldDir = path.join(dataDir(), 'messages-cold')
  const { chats, dropped } = collectTodayMessages(messagesDir, coldDir, cfg)
  const world = readWorldMaterial(dataDir(), cfg)
  dbg('collect_diary', true, `${chats.length} 会话，账本 ${world.facts.length} 条`)
  return {
    content: buildDiaryDigest({ chats, world, dropped })
      + '\n\n写日记的口径：第一人称、你自己的口气，写你今天经历了什么、情绪和有感触的点，把世界观和账本里的事织进去；'
      + '不是聊天记录的流水账。别人的原话不要原文照搬（空间全体好友可见），概括或用昵称。'
      + '写完调 qqzone__post_diary：text=日记全文，title=如「我的日记 · 10月4日」，caption=说说正文的一句话。'
  }
}

/** 软依赖加载「长文排版图」的渲染管线；找不到给 null，调用方给人话错误。 */
export async function loadRenderer() {
  if (diaryHooks.renderer) return diaryHooks.renderer
  const candidates = [
    path.join(HERE, '..', 'text-image', 'index.js'),
    path.join(HERE, '..', '..', 'skills', 'text-image', 'index.js')
  ]
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue
      const mod = await import(pathToFileURL(p).href)
      if (typeof mod.renderPages === 'function') return mod
    } catch { /* 换下一个候选路径 */ }
  }
  return null
}

// 测试注入点：authImpl 换掉 acquireCookies，renderer 换掉排版图模块。生产路径完全不碰。
export const diaryHooks = { authImpl: null, renderer: null }

function cleanDiaryText(s, maxLen) {
  let t = String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  t = t.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return t.length > maxLen ? t.slice(0, maxLen) : t
}

async function doPostDiary(text, title, caption, ctx) {
  const deny = gateByContext(ctx)
  if (deny) return { content: deny, isError: true }
  const cfg = cfgOf()
  const diary = cleanDiaryText(text, Math.min(18000, Math.max(500, Number(cfg.maxDiaryChars) || 8000)))
  if (!diary) return { content: '日记正文是空的。先想好写什么，或者先调 qqzone__collect_diary 看今天的素材。', isError: true }

  const st = loadState()
  const capCheck = checkCap(st, 'diary', cfg)
  if (!capCheck.ok) return { content: capCheck.reason, isError: true }

  // 排版图是软依赖（v2.1）：找不着渲染器或渲染炸了都不拦人，日记退成纯文字说说照发
  const renderer = await loadRenderer()
  let pages = null
  let renderNote = ''
  if (!renderer) {
    renderNote = '未装「长文排版图」技能（skills/text-image）'
  } else {
    try {
      pages = await renderer.renderPages(diary, { title: cleanDiaryText(title, 60) || '日记' }, {})
    } catch (e) {
      renderNote = `排版失败（${String(e?.message ?? e).slice(0, 80)}）`
    }
    if (!Array.isArray(pages) || !pages.length) {
      pages = null
      renderNote = renderNote || '排版结果为空'
    }
  }

  const auth = await (diaryHooks.authImpl ? diaryHooks.authImpl() : acquireCookies())
  if (!auth.selfUin) return { content: '识别不出自己的 QQ 号（cookie 里缺 pt2gguin/uin）', isError: true }

  if (!pages) {
    const con = sanitizeText(`${caption || '把今天记成了一页日记。'}\n\n${diary}`, 5000)
    const form = {
      syn_tweet_verson: '1',
      paramstr: '1',
      pic_template: '',
      richtype: '',
      richval: '',
      special_url: '',
      subrichtype: '',
      who: '1',
      con,
      feedversion: '1',
      ver: '1',
      ugc_right: '1',
      to_sign: '0',
      hostuin: auth.selfUin,
      code_version: '1',
      format: 'json',
      qzreferrer: `${QZONE}/${auth.selfUin}`
    }
    let tid = ''
    try {
      const j = parseQzoneLooseJson(
        await qzonePost(`/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${auth.gtk2}`, form, auth.cookies),
        '发日记说说'
      )
      tid = String(j?.t1_tid ?? j?.tid ?? '')
      if (!tid) throw new Error('响应里没有 tid（多半被空间拒了，比如内容含敏感词或发得太频繁）')
    } catch (e) {
      dbg('post_diary', false, `纯文字兜底也失败：${String(e?.message ?? e).slice(0, 120)}`)
      return { content: `日记没能发出（${renderNote}，退纯文字也没发成：${String(e?.message ?? e).slice(0, 120)}）`, isError: true }
    }
    recordAct(st, 'diary', null)
    dbg('post_diary', true, `tid=${tid}，纯文字兜底（${renderNote}）`)
    return {
      content: `${renderNote}——这篇日记退成了纯文字说说发到 QQ 空间（超 5000 字截断）。装上「长文排版图」后日记会自动排成图，不用改用法。`
    }
  }

  const maxBytes = Math.min(32, Math.max(1, Number(cfg.maxImageMB) || IMG_MB_DEFAULT)) * 1024 * 1024
  const richvals = []
  for (const buf of pages) {
    const kind = imageKindOf(buf)
    if (!kind) return { content: '排出来的日记图不是 Qzone 认的图片格式，发不了', isError: true }
    if (buf.length > maxBytes) return { content: `日记图 ${(buf.length / 1048576).toFixed(1)}MB 超过上限，调小每页字数再试`, isError: true }
    try {
      const up = await uploadQzoneImage(auth, buf)
      richvals.push(up.richval)
      dbg('diary', true, `第 ${richvals.length}/${pages.length} 页已上传（${up.width}x${up.height}）`)
    } catch (e) {
      dbg('diary', false, `上传失败：${String(e?.message ?? e).slice(0, 100)}`)
      return { content: `日记图上传失败（第 ${richvals.length + 1} 页）：${String(e?.message ?? e).slice(0, 120)}`, isError: true }
    }
  }

  const cap = Math.max(1, Number(cfg.maxPostChars) || 500)
  const con = sanitizeText(caption || '把今天记成了一页日记。', cap) || '把今天记成了一页日记。'
  const form = {
    syn_tweet_verson: '1',
    paramstr: '1',
    pic_template: '',
    richtype: '1',
    richval: richvals.join('\t'),
    special_url: '',
    subrichtype: '',
    who: '1',
    con,
    feedversion: '1',
    ver: '1',
    ugc_right: '1',
    to_sign: '0',
    hostuin: auth.selfUin,
    code_version: '1',
    format: 'json',
    qzreferrer: `${QZONE}/${auth.selfUin}`
  }
  let tid = ''
  try {
    const j = parseQzoneLooseJson(
      await qzonePost(`/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${auth.gtk2}`, form, auth.cookies),
      '发日记说说'
    )
    tid = String(j?.t1_tid ?? j?.tid ?? '')
    if (!tid) throw new Error('响应里没有 tid（多半被空间拒了，比如内容含敏感词或发得太频繁）')
  } catch (e) {
    dbg('post_diary', false, String(e?.message ?? e).slice(0, 120))
    return { content: `发日记说说失败：${String(e?.message ?? e).slice(0, 180)}`, isError: true }
  }
  recordAct(st, 'diary', null)
  dbg('post_diary', true, `tid=${tid}，${pages.length} 页图`)

  // 日记图同时落到当前会话，让对面看得见。这一步失败不影响"说说已发出"的事实。
  if (cfg.showInChat !== false && ctx && (ctx.sender || ctx.onebot)) {
    try {
      const osMod = await import('node:os')
      const dir = path.join(osMod.tmpdir(), 'qq-agent-diary')
      fs.mkdirSync(dir, { recursive: true })
      for (let i = 0; i < pages.length; i++) {
        const file = path.join(dir, `${Date.now()}-diary-${i + 1}.png`)
        fs.writeFileSync(file, pages[i])
        try {
          if (ctx?.sender && typeof ctx.sender.sendImage === 'function') {
            await ctx.sender.sendImage(ctx.chatKey, { file, note: `日记第 ${i + 1}/${pages.length} 页` }, { note: `日记第 ${i + 1}/${pages.length} 页` })
          } else if (ctx?.onebot && typeof ctx.onebot.sendImage === 'function') {
            await ctx.onebot.sendImage(ctx.kind, ctx.chatId, file)
          }
        } finally {
          try { fs.unlinkSync(file) } catch { /* 清理失败不影响主结果 */ }
        }
      }
    } catch (e) {
      dbg('diary', null, `回显到会话失败（说说已发出）：${String(e?.message ?? e).slice(0, 80)}`)
    }
  }

  return {
    content: `今天的日记已排成 ${pages.length} 页图发到 QQ 空间（说说：${con.slice(0, 40)}${con.length > 40 ? '…' : ''}）。日记图也发到当前会话了，不要再复述日记正文。`
  }
}

/* ══════════════════════════════════════════════════════════════════════
   七、技能契约：setup / available / dispose / diagnose
   ══════════════════════════════════════════════════════════════════════ */


// orchestrator 的 ctx 里有 onebot；setup 的 api 没有。所以第一次执行工具时把它记下来，
// 之后取 cookie 都走它的常规通道（被 SnowLuma 1401 拒了再退到读配置文件那条路）。
function rememberOnebot(ctx) {
  if (!onebotRef && ctx && typeof ctx.onebot?.call === 'function') onebotRef = ctx.onebot
}

// 群聊闸门（与 doujin-lookup 同一套约定）
function gateByContext(ctx) {
  const cfg = cfgOf()
  if (cfg.allowInGroup === false && ctx?.kind === 'group') {
    return '此功能只在私聊可用'
  }
  return ''
}

// 同步：不设硬门槛。真正的句柄在每次工具执行时从运行期 ctx 拿（rememberOnebot），
// 通道不通时调用本身会报人话错误；在这里拦，只会把"设置页开关激活拿不到句柄"
// 的宿主口径差异放大成"依赖不满足"，工具连注册都注册不上。
export function available() {
  return true
}

export function diagnose() {
  const steps = debugLog.slice(-8).map((d) => `${fmtLocal(d.t)} ${d.ok == null ? '…' : d.ok ? '✓' : '✗'} ${d.step} ${d.detail}`)
  return [
    `可用性: ${available() ? '是' : '否'}（onebot 通道见下行）`,
    `onebot 通道: ${onebotRef && onebotRef.httpUrl ? '有' : '无'}`,
    `data 目录: ${dataDir()}`,
    `state 文件: ${fs.existsSync(stateFile()) ? '存在' : '尚未创建'}`,
    steps.length ? `最近动态:\n  ${steps.join('\n  ')}` : '尚无调用记录'
  ].join('\n')
}

export function dispose() {
  cookieCache = null
  onebotRef = null
}

export function setup(api) {
  cfgOf = () => (api.config && typeof api.config === 'function' ? (api.config() || {}) : {})
  log = (...a) => { try { api.log(...a) } catch { /* ignore */ } }
  onebotRef = api.onebot || api.context?.onebot || null

  api.registerTool({
    id: 'collect_diary',
    name: '收集日记素材',
    description: '收集写日记要用的素材（只读，不出网）：今天的全部聊天记录，加上「世界与事件」插件的世界观与近况账本（没装这个插件就只给聊天记录，并注明跳过）。返回的是原料摘要，日记正文由你自己写。',
    category: 'social',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      rememberOnebot(ctx)
      return doCollectDiary(ctx)
    }
  })

  api.registerTool({
    id: 'post_diary',
    name: '发日记说说',
    description: '把日记正文用「长文排版图」的管线排成图片，发成一条带图的 QQ 空间说说（一天一篇，工具会按天限频）。日记图也会发到当前会话。没装排版图技能或渲染失败时，会自动把日记发成纯文字说说，不用改道。',
    category: 'social',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '日记全文，第一人称、你自己的口气。支持简单 markdown（标题/列表/引用/粗体）。' },
        title: { type: 'string', description: '可选，图片顶部的标题，如「我的日记 · 10月4日」' },
        caption: { type: 'string', description: '说说正文的一句话（图下面配的字），默认「把今天记成了一页日记。」' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      rememberOnebot(ctx)
      return doPostDiary(args?.text, args?.title, args?.caption, ctx)
    }
  })

  api.registerTool({
    id: 'post_mood',
    name: '发说说',
    description: '以你自己的身份发一条 QQ 空间说说。内容要真是你想发的，一两句、你的语气。可以带图：images 里放**聊天记录里的消息号**（如 "#12345"，那条消息有多张图时用 "#12345:2" 指第 2 张），只能引用你已经看到过的图，不接受路径、网址或 base64。',
    category: 'social',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '说说正文，第一人称、你自己的语气' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '要一起发的图，每项是聊天记录里的消息号（"#12345" 或 "#12345:2"）。不发图就别传。'
        }
      },
      required: ['content']
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doPostMood(args?.content, args?.images, ctx)
    }
  })

  api.registerTool({
    id: 'list_feeds',
    name: '刷好友动态',
    description: '刷好友的 QQ 空间动态（只读），返回作者/时间/摘要/点赞数，供你决定要不要点赞评论。',
    category: 'social',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '想看几条（默认取配置，上限 20）' }
      }
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doListFeeds(args?.count)
    }
  })

  api.registerTool({
    id: 'like_feed',
    name: '点赞说说',
    description: '给指定好友的一条说说点赞。uin/tid 从 list_feeds 的返回里原样抄。',
    category: 'social',
    parameters: {
      type: 'object',
      properties: {
        uin: { type: 'string', description: '作者 QQ 号' },
        tid: { type: 'string', description: '说说的 tid' }
      },
      required: ['uin', 'tid']
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doLikeFeed(args?.uin, args?.tid)
    }
  })

  api.registerTool({
    id: 'comment_feed',
    name: '评论说说',
    description: '给指定好友的一条说说写评论。uin/tid 从 list_feeds 的返回里原样抄，评论要短、像你本人。',
    category: 'social',
    parameters: {
      type: 'object',
      properties: {
        uin: { type: 'string', description: '作者 QQ 号' },
        tid: { type: 'string', description: '说说的 tid' },
        content: { type: 'string', description: '评论内容' }
      },
      required: ['uin', 'tid', 'content']
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doCommentFeed(args?.uin, args?.tid, args?.content)
    }
  })
}
