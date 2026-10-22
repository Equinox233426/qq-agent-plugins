// Pixiv「来张图」—— 按角色搜插画并发到当前会话，带 PID 索引去重
//
// 为什么 shell 出 curl 而不是用 api.fetch：
//   Pixiv 在国内必须走代理，而 Node 的 undici（globalThis.fetch）**不支持 socks5**，
//   只认 http(s) 代理，所以这里走 `curl --proxy socks5h://...`。
//   curl.exe 是 Windows 10 1803+ 自带的，无需额外安装。
//
// 核心设计：
//   1. 【选前过滤】爬过的作品（按 Pixiv 作品 ID 判定）在**挑选之前**就剔掉，
//      而不是挑完再逐个检查。后者在候选全是旧图时会空手而归、直接报失败。
//   2. 【PID 索引】<数据目录>/pixiv/pid-index.json 记录每个爬过的作品：
//      {pid: {file, folder, tags, author, title, bookmarks, likes,
//             firstSeen, lastSeen, sentCount, lastSent}}。
//      O(1) 查询，能回答"这张以前发过没、谁画的"。原子写，断电不会毁掉整个索引。
//      另有**目录扫描兜底**：按文件名里的 hash 后缀找已存在的文件，
//      这样从别的机器人迁移过来的图库也能被识别为"已入库"。
//   3. 【候选耗尽时降级】新图找完了就明说"这些是以前存过的"，而不是报失败。
//
// tag 翻译：模型在 tag 参数里直接给日文标签（它认识东方角色），工具把映射记进
// tag-dict.json，下次命中零成本。也支持从别处导入既有词典（见 legacyTagDict 设置）。

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PIXIV_REFERER = 'https://www.pixiv.net/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_CANDIDATES = 24;

let cfg = () => ({});

// ── 数据目录（与程序其它数据同源，跟着一起备份）──────────────────────
function dataDir() {
  const base = process.env.QQ_AGENT_DATA_DIR
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'data');
  return path.join(base, 'pixiv');
}

// ── PID 索引 ────────────────────────────────────────────────────────
let ledger = null;

function ledgerFile() { return path.join(dataDir(), 'pid-index.json'); }

function loadLedger() {
  if (ledger) return ledger;
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
    ledger = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    ledger = {};
  }
  return ledger;
}

function saveLedger() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    // 原子写：断电/崩溃时不会留下半截 JSON 把整个索引毁掉
    const p = ledgerFile();
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(ledger, null, 2), 'utf8');
    fs.renameSync(`${p}.tmp`, p);
  } catch { /* 索引写不进去不该让这次爬图失败 */ }
}

function hasPid(pid) { return Boolean(loadLedger()[String(pid)]); }

function recordPid(pid, info = {}) {
  const l = loadLedger();
  const k = String(pid);
  const prev = l[k] || {};
  const sent = Boolean(info.sent);
  l[k] = {
    pid: Number(pid) || pid,
    file: info.file ?? prev.file ?? '',
    folder: info.folder ?? prev.folder ?? '',
    tags: info.tags ?? prev.tags ?? [],
    // 作品信息也一并存档：以后要回答"这张谁画的""有没有发过"时不用再联网查
    author: info.author ?? prev.author ?? '',
    title: info.title ?? prev.title ?? '',
    bookmarks: info.bookmarks ?? prev.bookmarks ?? 0,
    likes: info.likes ?? prev.likes ?? 0,
    firstSeen: prev.firstSeen || Date.now(),
    lastSeen: Date.now(),
    sentCount: (prev.sentCount || 0) + (sent ? 1 : 0),
    lastSent: sent ? Date.now() : (prev.lastSent || 0)
  };
  saveLedger();
}

// ── tag 词典（中/英 → Pixiv 日文标签）────────────────────────────────
let tagDict = null;

function tagDictFile() { return path.join(dataDir(), 'tag-dict.json'); }

function loadTagDict() {
  if (tagDict) return tagDict;
  tagDict = {};
  try {
    // 首次运行：如果配置了外部词典（从别的机器人迁移过来的），导入一次，已有翻译不浪费。
    // 两种格式都认：{"古明地恋": "古明地こいし"} 和 {"古明地恋": {"ja": "古明地こいし"}}
    const legacyPath = String(cfg()?.legacyTagDict || '').trim();
    if (!fs.existsSync(tagDictFile()) && legacyPath && fs.existsSync(legacyPath)) {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      for (const [name, v] of Object.entries(legacy || {})) {
        const ja = typeof v === 'string' ? v : (v && v.ja);
        if (ja) tagDict[name] = String(ja);
      }
      saveTagDict();
    } else {
      const raw = JSON.parse(fs.readFileSync(tagDictFile(), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) tagDict = raw;
    }
  } catch { tagDict = {}; }
  return tagDict;
}

function saveTagDict() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(tagDictFile(), JSON.stringify(tagDict, null, 2), 'utf8');
  } catch { /* 同上，不影响本次 */ }
}

function rememberTag(name, ja) {
  const n = String(name || '').trim();
  const j = String(ja || '').trim();
  if (!n || !j || n === j) return;
  const d = loadTagDict();
  if (d[n] === j) return;
  d[n] = j;
  saveTagDict();
}

// ── curl 封装 ───────────────────────────────────────────────────────
function curl(url, { proxy = '', referer = '', timeoutMs = 25000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-L', '--max-time', String(Math.max(3, Math.ceil(timeoutMs / 1000)))];
    if (proxy) args.push('--proxy', proxy);
    args.push('-H', `User-Agent: ${UA}`);
    args.push('-H', `Referer: ${referer || PIXIV_REFERER}`);
    args.push('-H', 'X-Requested-With: XMLHttpRequest');
    args.push(url);
    execFile('curl.exe', args, {
      maxBuffer: 48 * 1024 * 1024,
      encoding: binary ? 'buffer' : 'utf8',
      windowsHide: true,
      timeout: timeoutMs + 8000
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// ── 代理保活（移植自 char_img.py 的 _proxy_port_open / _ensure_proxy）──
//
// 注意：这套东西叫 v2rayN，但**核心是 sing-box** —— v2rayN 生成的
// binConfigs\config.json 是 sing-box 格式，所以原版启的是
// bin\sing_box\sing-box.exe run -c <config>，不是 xray。
// 配置里的入站是 mixed 类型监听 127.0.0.1:10808，socks5 和 http 共用这一个口。
let lastEnsureTs = 0;
let lastEnsureOk = null;
let ensureInFlight = null;

/** 代理地址里抽出可探测的 host:port（socks5h://127.0.0.1:10808 → 127.0.0.1:10808） */
function proxyHostPort(proxy) {
  const s = String(proxy || '').trim();
  if (!s) return null;
  const m = /^(?:[a-z0-9+.-]+:\/\/)?([^:/@]+):(\d+)/i.exec(s);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) };
}

function probeTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

async function waitPort(host, port, totalMs) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await probeTcp(host, port, 600)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

/**
 * 确保代理端口可连。端口没开且开了 autoStart 时，后台静默拉起 sing-box。
 * 返回 { ok, started, reason }。
 *
 * 节流 60s + 单飞（in-flight）锁：群聊里连着几个人要图时，
 * 不能每个请求都去 spawn 一次核心 —— 第二次 spawn 会因端口占用直接失败。
 */
async function ensureProxy({ proxy, autoStart, coreDir }) {
  const hp = proxyHostPort(proxy);
  if (!hp) return { ok: false, started: false, reason: '代理地址解析不出来' };

  if (await probeTcp(hp.host, hp.port)) {
    lastEnsureOk = true;
    return { ok: true, started: false };
  }
  if (!autoStart) {
    return { ok: false, started: false, reason: `代理端口 ${hp.host}:${hp.port} 没在监听，且未开启自动拉起` };
  }
  if (ensureInFlight) return ensureInFlight;                 // 已有一次在跑，搭车
  if (Date.now() - lastEnsureTs < 60000 && lastEnsureOk === false) {
    return { ok: false, started: false, reason: '60 秒内已尝试过拉起代理且失败，先不重复试' };
  }
  lastEnsureTs = Date.now();

  ensureInFlight = (async () => {
    const dir = String(coreDir || '').trim();
    const exe = dir ? path.join(dir, 'bin', 'sing_box', 'sing-box.exe') : '';
    const conf = dir ? path.join(dir, 'binConfigs', 'config.json') : '';
    if (!dir || !fs.existsSync(exe) || !fs.existsSync(conf)) {
      lastEnsureOk = false;
      return { ok: false, started: false, reason: `找不到 sing-box 核心或配置（${dir || '未配置 proxyCoreDir'}）` };
    }
    try {
      const child = spawn(exe, ['run', '-c', conf], {
        cwd: path.dirname(exe),
        detached: true,          // 代理是基础设施，不跟着 QQ Agent 一起死
        stdio: 'ignore',         // 不弹窗、不占管道
        windowsHide: true
      });
      child.unref();
    } catch (e) {
      lastEnsureOk = false;
      return { ok: false, started: false, reason: `启动 sing-box 失败：${e?.message ?? e}` };
    }
    const up = await waitPort(hp.host, hp.port, 15000);
    lastEnsureOk = up;
    return up
      ? { ok: true, started: true }
      : { ok: false, started: true, reason: 'sing-box 已启动，但 15 秒内端口仍未就绪' };
  })();

  try { return await ensureInFlight; } finally { ensureInFlight = null; }
}

// ── Pixiv 工具函数（照抄原版语义）────────────────────────────────────
function pixivWorkId(url) {
  const m = /(\d{5,12})_p\d+_/.exec(String(url || ''));
  return m ? m[1] : null;
}

function imageHash(url, workId = null) {
  const key = workId ? `pixiv:${workId}` : String(url);
  return crypto.createHash('md5').update(key, 'utf8').digest('hex').slice(0, 8);
}

function normalizeExt(url) {
  const ext = path.extname(String(url).split('?')[0]).toLowerCase();
  return IMG_EXT.has(ext) ? ext : '.png';
}

/** 旧文件兜底：目录里已有同 hash 的文件就复用它（兼容原图库的命名） */
function findExistingFile(dir, hash, ext) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(ext) && f.includes(`_${hash}${ext}`)) return path.join(dir, f);
    }
  } catch { /* 目录不存在 */ }
  return null;
}

async function searchPixiv(query, opt) {
  const { proxy, timeoutMs, pages, mode, type, skipMultiPage, apiBase } = opt;
  const kw = encodeURIComponent(query);
  const cands = [];
  const seen = new Set();
  for (let page = 1; page <= pages; page++) {
    if (cands.length >= MAX_CANDIDATES) break;
    const url = `${apiBase}/ajax/search/illustrations/${kw}`
      + `?word=${kw}&order=date_d&mode=${mode}&p=${page}&s_mode=s_tag&type=${type}&lang=zh`;
    let data;
    try { data = JSON.parse(await curl(url, { proxy, timeoutMs })); } catch { continue; }
    const body = data?.body || {};
    const items = body.illust?.data || body.illustManga?.data || [];
    for (const it of items) {
      const id = String(it?.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let u = it?.urls?.regular || it?.url || '';
      if (!u) continue;
      // 缩略图 -> master1200 大图
      u = u.replace('/c/250x250_80_a2/', '/').replace('_square1200.', '_master1200.');
      const pageCount = Number(it?.pageCount) || 1;
      if (skipMultiPage && pageCount > 1) continue;
      const tags = (Array.isArray(it?.tags) ? it.tags : [])
        .map((t) => (t && typeof t === 'object' ? t.tag : String(t || '')))
        .filter(Boolean);
      cands.push({ id, url: u, bookmarks: 0, likes: 0, pageCount, tags });
      if (cands.length >= MAX_CANDIDATES) break;
    }
  }
  return cands;
}

/** 并发拉详情补收藏量/点赞量（原版用 6 线程，这里用 6 个协程等价实现） */
async function fetchDetails(cands, { proxy, timeoutMs, apiBase }) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < cands.length) {
      const c = cands[cursor++];
      try {
        const d = JSON.parse(await curl(`${apiBase}/ajax/illust/${c.id}`, { proxy, timeoutMs }));
        const b = d?.body || {};
        c.bookmarks = Number(b.bookmarkCount) || 0;
        c.likes = Number(b.likeCount) || 0;
        // 发图时要把这些一并带出去，所以在这一趟里取全（详情接口本来就返回了）
        c.author = String(b.userName || '').trim();
        c.authorId = String(b.userId || '').trim();
        c.title = String(b.title || '').trim();
        c.views = Number(b.viewCount) || 0;
        c.created = String(b.createDate || '').trim();
      } catch { /* 单张失败就保持 0，不拖垮整批 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, cands.length) }, worker));
}

/** 按收藏+点赞加权不放回抽样（权重越大概率越高） */
function weightedSelect(items, n) {
  const pool = [...items];
  const picked = [];
  while (picked.length < n && pool.length) {
    const weights = pool.map((it) => Math.max(Number(it.bookmarks) || 0, 0) + Math.max(Number(it.likes) || 0, 0) + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let chosen = null;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) { chosen = pool.splice(i, 1)[0]; break; }
    }
    picked.push(chosen || pool.pop());
  }
  return picked;
}

async function downloadImage(url, destDir, { proxy, timeoutMs, name, workId, pageCount = 1 }) {
  fs.mkdirSync(destDir, { recursive: true });
  let realUrl = url;
  if (pageCount > 1) {
    const idx = Math.floor(Math.random() * pageCount);
    realUrl = url.replace(/_p\d+_/, `_p${idx}_`);
  }
  const ext = normalizeExt(realUrl);
  const hash = imageHash(realUrl, workId);

  const existing = findExistingFile(destDir, hash, ext);
  if (existing) return { file: existing, reused: true };

  const safe = String(name || 'img').replace(/[^\w\u4e00-\u9fff-]/g, '_').slice(0, 30) || 'img';
  const dest = path.join(destDir, `${Date.now()}_${safe}_${hash}${ext}`);
  const buf = await curl(realUrl, { proxy, referer: PIXIV_REFERER, timeoutMs, binary: true });
  if (!buf || buf.length < 200) return null;   // 太小的基本是错误页
  fs.writeFileSync(dest, buf);
  return { file: dest, reused: false };
}

// ── 发图时附带的作品信息 ─────────────────────────────────────────────
/** 把万位数压成「1.2万」，聊天里比 12345 好读 */
function compactNum(n) {
  const v = Number(n) || 0;
  if (v < 10000) return String(v);
  return `${(v / 10000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, '')}万`;
}

function formatInfo(it) {
  const title = String(it.title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const head = title ? `🎨 ${title}` : `🎨 pixiv #${it.id}`;
  const bits = [];
  if (it.author) bits.push(`👤 ${it.author}`);
  if (it.bookmarks) bits.push(`❤️ ${compactNum(it.bookmarks)}`);
  if (it.likes) bits.push(`⭐ ${compactNum(it.likes)}`);
  if (it.views) bits.push(`👁 ${compactNum(it.views)}`);
  bits.push(`#${it.id}`);
  return `${head}\n${bits.join(' ｜ ')}`;
}

// ── 工具注册 ────────────────────────────────────────────────────────
export function setup(api) {
  cfg = api.config;
  const d = loadLedger();
  const dict = loadTagDict();
  api.log(`Pixiv 技能已注册｜索引 ${Object.keys(d).length} 个 PID｜tag 词典 ${Object.keys(dict).length} 条`);

  api.registerTool({
    id: 'pixiv_image',
    name: 'Pixiv 来张图',
    description:
      '从 Pixiv 按角色搜一张插画并发到当前会话，爬过的作品不会重复爬。' +
      '当群友说「来张 XX」「来一张 XX」「给我来张 XX」「找张 XX」时调用。' +
      'character 填角色名；如果你知道该角色在 Pixiv 上的日文标签，一并填进 tag（例如 古明地恋→古明地こいし），能明显提高命中率。',
    category: 'media',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        character: { type: 'string', description: '角色名，例如「古明地恋」「博丽灵梦」。' },
        tag: {
          type: 'string',
          description: '该角色在 Pixiv 的日文标签（可选但强烈建议）。多个标签用空格分隔表示 AND。'
        },
        count: { type: 'number', description: '发几张，1~3，默认 1。' }
      },
      required: ['character']
    },
    async execute(ctx, args) {
      const c = cfg() || {};
      const apiBase = String(c.apiBase || 'https://www.pixiv.net').trim().replace(/\/+$/, '');
      const proxy = String(c.proxy || '').trim();
      // 留空 = 存到程序数据目录下，随数据一起备份，开箱即用
      const imageDir = String(c.imageDir || '').trim() || path.join(dataDir(), 'images');
      const minBm = Math.max(0, Number(c.minBookmarks) || 0);
      const pages = Math.min(3, Math.max(1, Number(c.candidatePages) || 3));
      const skipMultiPage = c.skipMultiPage !== false;
      const mode = String(c.mode || 'safe').trim();
      const type = String(c.type || 'artwork').trim();
      const timeoutMs = Math.min(60000, Math.max(5000, Number(c.timeoutMs) || 25000));

      const character = String(args?.character ?? '').trim();
      if (!character) return { content: '缺少 character：请告诉我要哪个角色的图。', isError: true };

      const count = Math.min(3, Math.max(1, Number(args?.count) || 1));

      // tag 解析：模型给的日文标签 > 词典 > 原名直接用
      const dict = loadTagDict();
      const given = String(args?.tag ?? '').trim();
      const jaTag = given || dict[character] || character;
      if (given) rememberTag(character, given);

      // 代理可能没开：先探测，必要时按设置把 sing-box 拉起来
      const pre = await ensureProxy({
        proxy,
        autoStart: c.autoStartProxy === true,
        coreDir: String(c.proxyCoreDir || '').trim()
      });
      if (!pre.ok) {
        return {
          content: `拿不到图：${pre.reason}。请在技能设置里把代理开起来，或打开「代理没开时自动拉起」。`,
          isError: true
        };
      }

      const t0 = Date.now();
      let cands;
      try {
        cands = await searchPixiv(jaTag, { proxy, timeoutMs, pages, mode, type, skipMultiPage, apiBase });
      } catch (e) {
        const msg = String(e?.message || e);
        if (/could not resolve|Failed to connect|Connection refused|proxy/i.test(msg)) {
          return {
            content: `连不上 Pixiv（${msg}）。这个功能必须走代理，请确认代理已启动，`
              + `当前设置是「${proxy || '直连'}」。`,
            isError: true
          };
        }
        return { content: `搜索 Pixiv 失败：${msg}`, isError: true };
      }
      if (!cands.length) {
        return { content: `没搜到「${jaTag}」的图。可以换个日文标签再试。`, isError: true };
      }

      await fetchDetails(cands, { proxy, timeoutMs, apiBase });

      let pool = minBm > 0 ? cands.filter((x) => x.bookmarks >= minBm) : cands;
      if (!pool.length) pool = cands;   // 收藏门槛太高就放宽，有图总比没有强

      // ★ 核心改动：选之前先按 PID 索引剔除爬过的
      const fresh = pool.filter((x) => !hasPid(x.id));
      const stale = pool.filter((x) => hasPid(x.id));

      let picked = weightedSelect(fresh, count);
      let reusedOld = false;
      if (picked.length < count && stale.length) {
        // 新图不够了：拿以前爬过的补，复用本地文件而不是重新下载
        picked = picked.concat(weightedSelect(stale, count - picked.length));
        reusedOld = true;
      }

      const folder = character.replace(/[^\w\u4e00-\u9fff-]/g, '_').slice(0, 24) || 'misc';
      const destDir = path.join(imageDir, folder);
      const sent = [];
      const failed = [];

      const showInfo = c.showInfo !== false;
      for (const it of picked) {
        try {
          const got = await downloadImage(it.url, destDir, {
            proxy, timeoutMs, name: folder, workId: it.id, pageCount: it.pageCount
          });
          if (!got) { failed.push(it.id); continue; }
          await ctx.sender.sendImage(ctx.chatKey, { file: got.file }, { note: `Pixiv ${it.id}` });
          // 作品信息紧跟图片单独发一条：图片气泡里塞不下文字，
          // 而模型的文本输出不会进 QQ，所以必须由工具自己发。
          if (showInfo) {
            try {
              await ctx.sender.sendTextBatch(ctx.chatKey, [formatInfo(it)]);
            } catch { /* 信息发失败不该把"图已经发出去了"变成失败 */ }
          }
          sent.push({ pid: it.id, file: got.file, reused: got.reused, bm: it.bookmarks, author: it.author });
          recordPid(it.id, {
            file: got.file, folder, tags: it.tags.slice(0, 8), sent: true,
            author: it.author, title: it.title, bookmarks: it.bookmarks, likes: it.likes
          });
        } catch (e) {
          failed.push(it.id);
        }
      }

      if (!sent.length) {
        return {
          content: `找到 ${pool.length} 个作品，但都没能下载成功（可能是代理不稳）。稍后再试。`,
          isError: true
        };
      }

      const list = sent.map((s) => `PID ${s.pid}${s.bm ? `（收藏 ${s.bm}）` : ''}${s.reused ? '[复用已存的]' : ''}`).join('；');
      return {
        content: `已发送 ${sent.length} 张「${character}」的图（标签 ${jaTag}，耗时 ${Math.round((Date.now() - t0) / 1000)}s）：${list}。`
          + (reusedOld ? '其中包含以前爬过的作品——这个标签下的新图基本翻完了，改用已存图。' : '')
          + (failed.length ? `另有 ${failed.length} 张下载失败。` : '')
          + '图已经发出去了，你只要配一句短话，不要复述 PID 或标签。'
      };
    }
  });
}

export function available() {
  return true;
}
