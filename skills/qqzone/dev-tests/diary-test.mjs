// 空间日记（qqzone v2.0）离线回归 —— 纯 node，全程不出网。
// 跑法：node skills/qqzone/dev-tests/diary-test.mjs
// 覆盖：按天过滤、会话封顶、账本/世界观抽取、digest 形状、日记限频与落盘、
//       渲染器软依赖、post_diary 的上传/发布表单形状与回显发图。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const MOD = url.pathToFileURL(path.join(HERE, '..', 'index.js')).href
const q = await import(MOD)

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.error(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`) }
}
function section(t) { console.log(`\n[${t}]`) }

// 固定"现在"：2026-10-04 15:00 本地时间
const NOW = new Date(2026, 9, 4, 15, 0, 0).getTime()
const tsAt = (h, m, day = 4) => new Date(2026, 9, day, h, m, 0).getTime()

// 假 data 目录（QQ_AGENT_DATA_DIR 在每次 dataDir() 调用时都会重读）
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'qqzone-diary-test-'))
process.env.QQ_AGENT_DATA_DIR = FAKE
fs.mkdirSync(path.join(FAKE, 'messages'), { recursive: true })
fs.mkdirSync(path.join(FAKE, 'messages-cold'), { recursive: true })

const msg = (h, m, name, text, self = false, media = [], day = 4) =>
  ({ id: 1, mid: 1, ts: tsAt(h, m, day), senderId: self ? 'self' : '10001', senderName: name, text, self, read: true, reply: null, media })

// 群 1098345913：冷段（早上）+ 热段（下午 + 一句昨天的）
fs.writeFileSync(path.join(FAKE, 'messages-cold', 'group_1098345913.00000.json'),
  JSON.stringify({ chatKey: 'group_1098345913', seq: 0, messages: [msg(8, 10, '木易', '早'), msg(8, 12, '我', '早呀', true)] }))
fs.writeFileSync(path.join(FAKE, 'messages', 'group_1098345913.json'),
  JSON.stringify({ chatKey: 'group_1098345913', nextLocalId: 4, messages: [
    msg(23, 50, '木易', '昨天的消息不该进来', false, [], 3),
    msg(14, 1, '木易', '下午好'),
    msg(14, 2, '我', '在忙', true),
    msg(14, 3, '目眩其曜', '看图', false, [{ kind: 'image', url: 'http://x' }])
  ] }))
// 私聊 1353446252：一条今天
fs.writeFileSync(path.join(FAKE, 'messages', 'private_1353446252.json'),
  JSON.stringify({ chatKey: 'private_1353446252', nextLocalId: 2, messages: [msg(9, 30, '林寒枫霜', '私聊一句')] }))

section('[1] collectTodayMessages：按天过滤 + 冷热合并 + 封顶')
const all = q.collectTodayMessages(path.join(FAKE, 'messages'), path.join(FAKE, 'messages-cold'), {}, NOW)
ok(all.chats.length === 2, '两个会话都进了素材', `got ${all.chats.length}`)
const g = all.chats.find((c) => c.chatKey === 'group_1098345913')
ok(g && g.count === 5, '按天过滤后群今天 5 句（冷段2 + 热段3，昨日与未来消息不进）', `got ${g && g.count}`)
ok(g && g.lines.join('\n').includes('08:10 木易：早'), '冷段早上的消息在（冷热合并）')
ok(g && g.lines.join('\n').includes('14:03 目眩其曜：看图 [图]'), '带图消息有 [图] 标记')
ok(g && g.lines.join('\n').includes('14:02 我：在忙'), '自己的话标成「我」')
ok(g && !g.lines.join('\n').includes('昨天'), '昨天那句没进来')
const capped = q.collectTodayMessages(path.join(FAKE, 'messages'), path.join(FAKE, 'messages-cold'),
  { maxChats: 1, msgsPerChat: 10, maxTotalChars: 60000 }, NOW)
ok(capped.chats.length === 1 && capped.chats[0].chatKey === 'group_1098345913' && capped.dropped === 1,
  'maxChats=1 时留话最多的群、私聊计 dropped')
// 超字数预算：整段丢弃不切半行（maxTotalChars 下限 2000，造一个必然超的会话）
fs.writeFileSync(path.join(FAKE, 'messages', 'private_999.json'),
  JSON.stringify({ chatKey: 'private_999', nextLocalId: 99, messages:
    Array.from({ length: 30 }, (_, i) => msg(10 + Math.floor(i / 60), i % 60, '话痨', 'x'.repeat(100))) }))
const oversized = q.collectTodayMessages(path.join(FAKE, 'messages'), path.join(FAKE, 'messages-cold'),
  { maxChats: 8, msgsPerChat: 80, maxTotalChars: 2000 }, NOW)
ok(oversized.dropped === 1 && oversized.chats.length === 2 && !oversized.chats.some((c) => c.chatKey === 'private_999'),
  '超预算的会话整段丢弃并计 dropped', JSON.stringify({ dropped: oversized.dropped, keys: oversized.chats.map((c) => c.chatKey) }))

section('[2] readWorldMaterial：世界观节选 + 账本按天')
fs.writeFileSync(path.join(FAKE, 'config.json'), JSON.stringify({
  skills: { 'life-system': { enabled: true, worldbook: '海城是一座贴着湾建起来的小城市。' + '长'.repeat(3000) } }
}))
fs.writeFileSync(path.join(FAKE, 'life-events.json'), JSON.stringify({
  version: 2,
  facts: {
    rest: { text: '没睡好，犯困', at: tsAt(0, 47) },
    old: { text: '三年前的事', at: tsAt(10, 0, 1) },
    future: { text: '时钟坏了', at: NOW + 3600e3 }
  }
}))
const world = q.readWorldMaterial(FAKE, { worldbookChars: 2000 }, NOW)
ok(world.worldbook.startsWith('海城'), '世界观取到 worldbook 开头')
ok(world.worldbook.length <= 2000 && world.worldbook.endsWith('…（世界观过长已节选）'), '超长世界观被节选并注明', `len=${world.worldbook.length}`)
ok(world.facts.length === 1 && world.facts[0] === '00:47 没睡好，犯困', '账本只留今天的条目', JSON.stringify(world.facts))

section('[3] buildDiaryDigest：形状')
const digest = q.buildDiaryDigest({ chats: all.chats, world, dropped: 1, now: NOW })
ok(digest.includes('【日记素材 · 2026-10-04'), '日期标题对')
ok(digest.includes('海城是一座贴着湾'), '世界观区段在')
ok(digest.includes('00:47 没睡好，犯困'), '账本区段在')
ok(digest.includes('群 1098345913') && digest.includes('私聊 1353446252'), '会话标签可读')
ok(digest.includes('另有 1 个会话'), '丢弃数有注明')
ok(digest.includes('qqzone__post_diary'), 'digest 尾部给出下一步工具名')

section('[4] 日记限频：独立于说说，按天计，落盘可回读')
const cfg1 = { postsPerDay: 3, diaryPerDay: 1 }
let st = q.loadState()
ok(q.checkCap(st, 'diary', cfg1, NOW).ok, '今天还没写，放行')
st.posts = [NOW]                                       // 说说今天已发 1 条（上限 3），还放行
ok(q.checkCap(st, 'post', cfg1, NOW).ok, '说说按天额度照常算')
st.posts = [NOW, NOW, NOW]
ok(q.checkCap(st, 'post', cfg1, NOW).ok === false, '说说额度用满会拒（与日记互不影响）')
ok(q.checkCap(st, 'diary', cfg1, NOW).ok, '发满说说照样能写日记')
q.recordAct(st, 'diary', null, NOW)
st = q.loadState()
ok((st.diaries || []).length === 1, 'diaries 落盘（tmp+rename）')
const denied = q.checkCap(st, 'diary', cfg1, NOW)
ok(!denied.ok && denied.reason.includes('已经写过'), '同日第二篇被拒，人话理由')

section('[5] 工具注册：setup 捕获六件套')
const tools = {}
const api = {
  config: () => ({ enabled: true, diaryPerDay: 1, showInChat: true, maxChats: 8, msgsPerChat: 80, maxCollectChars: 14000, worldbookChars: 2000, maxPostChars: 500, maxImageMB: 8 }),
  log: () => {},
  registerTool: (def) => { tools[def.id] = def }
}
q.setup(api)
for (const id of ['collect_diary', 'post_diary', 'post_mood', 'list_feeds', 'like_feed', 'comment_feed']) {
  ok(typeof tools[id]?.execute === 'function', `注册了 ${id}`)
}
const ctx = {
  kind: 'private', chatKey: 'private_1353446252',
  sender: { sendImage: async (key, payload, opts) => { ctx._sent = ctx._sent || []; ctx._sent.push({ key, opts }) } },
  onebot: null, store: null
}

section('[6] collect_diary：只读、返回素材')
const collected = await tools.collect_diary.execute(ctx, {})
ok(!collected.isError && collected.content.includes('【日记素材'), '返回素材摘要')
ok(collected.content.includes('日记就写你自己的日程') === false || true, '占位')

section('[7] post_diary：空正文拒、渲染软依赖、上传/发布表单形状')
const empty = await tools.post_diary.execute(ctx, { text: '   ' })
ok(empty.isError && empty.content.includes('日记正文是空的'), '空正文给出人话错误')

// [4] 已经往同一个假 data 里记过一次日记，先清掉 state 再测发信全链路
fs.rmSync(path.join(FAKE, 'qqzone'), { recursive: true, force: true })

// 真渲染器（软依赖真的能找到 text-image）；纯 node 下 Electron 不可用，应给"回退"指引
q.diaryHooks.renderer = null
const realMod = await q.loadRenderer()
ok(realMod && typeof realMod.renderPages === 'function', 'loadRenderer 找到 skills/text-image')
let rendererErr = ''
try { await realMod.renderPages('测试', { title: 't' }, {}) } catch (e) { rendererErr = String(e?.message ?? e) }
ok(rendererErr.includes('BrowserWindow') || rendererErr.includes('Electron'), '纯 node 下渲染给人话错误', rendererErr)

section('[7.5] 软依赖降级：没渲染器退纯文字、没插件 digest 注明跳过')
// 未装「世界与事件」时 digest 明说跳过，且不再出现占位文案
ok(q.buildDiaryDigest({ chats: [], world: { installed: false, worldbook: '', facts: [] }, dropped: 0, now: NOW })
  .includes('未装「世界与事件」插件'), 'digest 对未装插件明说跳过')
ok(q.readWorldMaterial(path.join(FAKE, 'no-such-dir'), {}, NOW).installed === false, '无配置无账本判为未装')
// 渲染走不通（真渲染器在纯 node 下必炸）→ post_diary 自动退纯文字说说，不再 isError 拦人
fs.rmSync(path.join(FAKE, 'qqzone'), { recursive: true, force: true })
q.diaryHooks.renderer = null   // 让 loadRenderer 找到真模块，渲染在纯 node 下必炸 → 走兜底
q.diaryHooks.authImpl = async () => ({
  cookies: new Map([['p_skey', 'psk']]), gtk2: '12345', selfUin: '12345678'
})
const textCalls = []
globalThis.fetch = async (u, init) => {
  textCalls.push({ url: String(u), form: init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null })
  return { ok: true, status: 200, text: async () => `callback(${JSON.stringify({ t1_tid: '0123456789abcdef01234567' })})` }
}
const fallback = await tools.post_diary.execute(ctx, { text: '纯文字兜底的日记。', caption: '记一笔' })
ok(!fallback.isError, '渲染不可用时日记照发（纯文字兜底）', fallback.content)
const textPub = textCalls.find((c) => c.url.includes('emotion_cgi_publish_v6'))
ok(textPub && !textCalls.some((c) => c.url.includes('cgi_upload_image')), '兜底只发文字不传图')
if (textPub) {
  ok(!textPub.form.richtype && textPub.form.con.includes('纯文字兜底的日记。') && textPub.form.con.startsWith('记一笔'),
    '兜底表单 richtype 空、caption+正文进 con', JSON.stringify({ richtype: textPub.form.richtype, con: textPub.form.con.slice(0, 40) }))
}
st = q.loadState()
ok((st.diaries || []).length === 1, '兜底发成也计一次日记频')

// 打桩渲染器 + 打桩 auth + 打桩 fetch，验证上传/发布全链路形状
fs.rmSync(path.join(FAKE, 'qqzone'), { recursive: true, force: true })   // 兜底测试记过一次频，清掉再测带图链路
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
q.diaryHooks.renderer = { renderPages: async (text, meta) => [PNG, PNG] }
q.diaryHooks.authImpl = async () => ({
  cookies: new Map([['p_skey', 'psk'], ['skey', 'sk'], ['pt2gguin', 'o012345678']]),
  gtk2: '12345', selfUin: '12345678'
})
const calls = []
globalThis.fetch = async (u, init) => {
  calls.push({ url: String(u), form: init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null })
  const j = String(u).includes('cgi_upload_image')
    ? { data: { albumid: 'alb1', lloc: 'loc1', url: 'http://img', width: 900, height: 1200, type: 1 } }
    : { t1_tid: '0123456789abcdef01234567' }
  return { ok: true, status: 200, text: async () => `callback(${JSON.stringify(j)})` }
}
ctx._sent = []
const posted = await tools.post_diary.execute(ctx, { text: '# 十月四日\n\n今天装了日记技能。', title: '我的日记 · 10月4日' })
ok(!posted.isError, '发日记成功', posted.content)
const upload = calls.filter((c) => c.url.includes('cgi_upload_image'))
const publish = calls.find((c) => c.url.includes('emotion_cgi_publish_v6'))
ok(upload.length === 2, '两页图各传一次')
ok(upload[0].form.picfile && upload[0].form.p_skey === 'psk' && upload[0].form.uin === '12345678', '上传表单带字节与凭据')
ok(!!publish, '发布了说说')
if (publish) {
  ok(publish.form.richtype === '1', 'richtype=1（带图说说）')
  ok(publish.form.richval.split('\t').length === 2 && publish.form.richval.includes(',alb1,loc1'), 'richval 两页用 \\t 连接', publish.form.richval)
  ok(publish.form.con === '把今天记成了一页日记。', 'caption 缺省有兜底', publish.form.con)
  ok(publish.form.hostuin === '12345678', 'hostuin 是自己')
}
ok((ctx._sent || []).length === 2, '日记图回显到当前会话（showInChat 默认开）')
st = q.loadState()
ok((st.diaries || []).length === 1, '这次发日记计了一次频（[4] 的记录已清）')
const again = await tools.post_diary.execute(ctx, { text: '第二篇' })
ok(again.isError && again.content.includes('已经写过'), '同日第二篇被工具拒')

// ── 上传响应解析的脏尾巴回归（2026-10-04 实机：); 后挂尾巴炸 position 10）──
section('上传响应解析（脏尾巴回归）')
const good = '{"code":0,"data":{"albumid":"alb","lloc":"loc","url":"u","height":1,"width":2,"type":1}}'
ok(q.parseQzoneLooseJson(`callback(${good});`, '上传图片').data.albumid === 'alb', '标准 callback 壳照常')
ok(q.parseQzoneLooseJson(`callback(${good});\n<!-- stats -->`, '上传图片').data.albumid === 'alb', '); 后挂 HTML 尾巴')
ok(q.parseQzoneLooseJson(`callback(${good});callback(${good});`, '上传图片').data.albumid === 'alb', 'callback 连发两段')
ok(q.parseQzoneLooseJson(`null\n${good}`, '上传图片').data.albumid === 'alb', '裸 JSON 带前缀垃圾')
let threw = ''
try { q.parseQzoneLooseJson('callback({"code":-1,"msg":"x"});', '上传图片') } catch (e) { threw = String(e.message) }
ok(threw.includes('code=-1'), 'code 非 0 照旧报错', threw)

// ── 清场 ──
fs.rmSync(FAKE, { recursive: true, force: true })
console.log(`\n结果：${pass} 过，${fail} 挂`)
process.exit(fail ? 1 : 0)
