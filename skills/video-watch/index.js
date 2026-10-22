// 视频与动图识读（video-watch）
//
// ── 这个技能解决什么 ──────────────────────────────────────────────────────
// 模型只能看单张静态图。给它一个视频，它只知道「这是一条视频」，说不出内容；
// 给它抽几帧，它又看不出动作——因为**抽哪几帧是瞎猜的**，两帧之间发生了什么
// 完全空白，模型只能编。
//
// 本技能的做法是**分两步看**，对应人看视频的真实方式：
//
//   第一步 速览：把整段铺成一张 5×5 联络表（25 格，每格左上角烧帧号）。
//                这一张图就代表全片，模型一眼建立「大概是什么」的印象。
//   第二步 细看：对说不清的地方，指定「第 20~28 秒」单独铺一张 3×3 大格图。
//                帧数少、单格大，才看得清表情、文字、动作。
//
// ── 为什么不用「均匀抽 6 帧」那种常见做法 ────────────────────────────────
// 因为 6 帧是**采样点**，不是**覆盖**。48 秒视频取 6 帧，每 8 秒一个点，
// 中间 8 秒的黑屏、转场、关键动作全在缝里。模型拿到这 6 张图只能说
// 「似乎是……」，然后开始编。
//
// 联络表的价值不在「帧多」，在于**把全片压成一个可以一次看完的整体**，
// 并且每格都带索引——模型能指着第 13 格说「这里出现了 PPT 标题」。
//
// ── 为什么不自己调 ffmpeg ────────────────────────────────────────────────
// relay 到 video-watch 项目的 vw.py。它在全片上做量测（切点、冻结段、
// 逐秒运动量），并用 tile 滤镜一次铺完，还顺手输出「第几行第几列 = 第几秒」
// 的 manifest。这些细节自己重写一遍只会更容易错。
// 我们只负责：找到它、给它正确的参数、把结果翻译成人话和图片。
//
// ── 依赖 ──────────────────────────────────────────────────────────────────
// 必需：python 3.8+、ffmpeg（完整构建，要 tile/drawtext/scdet 等滤镜）、ImageMagick
// 可选：Pillow（动图）、numpy（vwtools）
// 缺依赖时 available() 会如实报告，不会假装能用。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SKILL_ID = 'video-watch';

// 注意：这里不能用 process.cwd()。QQ Agent 可能从任何目录启动，
// 用 cwd 会导致数据写进奇怪的地方（或根本没权限）。
// 用 import.meta.url 推算：本文件永远在 <QQ Agent>/resources/app/skills/video-watch/ 下，
// 往上两级就是 app 根目录。**别人的安装路径不一样也无所谓**，这是相对推算的。
const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SKILL_DIR, '..', '..');
const WORK_ROOT = path.join(APP_ROOT, 'data', 'video-watch');

const DEFAULTS = {
  enabled: true,
  pythonPath: '',
  vwScript: '',
  overviewFrames: 25,
  overviewCols: 5,
  zoomFrames: 9,
  zoomCols: 3,
  maxWidthPx: 1600,
  jpegQuality: 4,
  sendOverviewToChat: true,
  keepWorkFiles: false,
  maxClipSeconds: 600
};

/**
 * vw.py 可能待的位置。**按优先级排列**，第一个命中就用。
 *
 * ① `vendor/vw.py` —— 跟技能一起打包的那份。这是分享给别人时唯一需要的位置，
 *    因为它是相对路径算出来的，别人装在哪个盘、哪个目录都对。
 * ② 剩下几条是给"自己另外下载了一份"的人兜底，纯属方便，不再是主路径。
 */
const VW_CANDIDATES = [
  path.join(SKILL_DIR, 'vendor', 'vw.py'),          // ← 随包携带，永久有效
  path.join(SKILL_DIR, 'vw.py'),                    // ← 直接丢在技能根目录也行
  'C:\\Users\\Public\\video-watch\\vw.py',
  path.join(os.homedir(), 'video-watch', 'vw.py'),
  path.join(os.homedir(), 'Downloads', 'video-watch-skill-main', 'vw.py')
];

let cfg = () => ({ ...DEFAULTS });
let log = () => {};
let warn = () => {};
let apiRef = null;

/** 本轮已经处理过几次（防止模型对着一条视频反复铺图烧钱） */
let watchCount = 0;
const MAX_WATCH_PER_RUN = 6;

function fail(message) {
  return { content: `错误：${message}`, isError: true };
}

/** 读设置，永远带默认值兜底（用户可能只填了一部分） */
function readCfg() {
  let raw = {};
  try { raw = cfg() || {}; } catch { raw = {}; }
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = raw[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof DEFAULTS[k] === 'number') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    } else if (typeof DEFAULTS[k] === 'boolean') {
      out[k] = v === true || String(v).toLowerCase() !== 'false';
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

// ── 找外部程序 ────────────────────────────────────────────────────────────

/** 跑一个命令，按退出码判成败，采集 stdout。 */
function run(cmd, args, { timeoutMs = 120000, cwd = null } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = execFile(cmd, args, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
        cwd: cwd || undefined,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      }, (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : (error ? 1 : 0);
        if (error && error.killed) {
          return done({ ok: false, timedOut: true, code, stdout: String(stdout || ''), stderr: String(stderr || '') });
        }
        done({ ok: code === 0, code, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch (e) {
      return done({ ok: false, code: -1, stdout: '', stderr: String(e?.message || e) });
    }
    // 不读 child 的引用，交给回调；这里只是保留变量以便未来需要 kill
    void child;
  });
}

let pyCache = { at: 0, path: '' };
/** 找 python。成功的探索结果缓存 5 分钟，失败 1 分钟后允许重探（用户可能刚装）。 */
async function findPython(c, { force = false } = {}) {
  if (c.pythonPath) return c.pythonPath;
  const now = Date.now();
  if (!force && pyCache.path && now - pyCache.at < 300000) return pyCache.path;
  if (!force && !pyCache.path && now - pyCache.at < 60000) return '';

  for (const name of ['python', 'python3', 'py']) {
    const r = await run(name, ['--version'], { timeoutMs: 8000 });
    if (r.ok && /Python\s+3\./i.test(r.stdout + r.stderr)) {
      pyCache = { at: now, path: name };
      return name;
    }
  }
  pyCache = { at: now, path: '' };
  return '';
}

/** 找 vw.py。设置里填了就用那个，否则按候选位置找。 */
function findVw(c) {
  if (c.vwScript) {
    return fs.existsSync(c.vwScript) ? c.vwScript : '';
  }
  for (const p of VW_CANDIDATES) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return '';
}

/** 三个必需程序的全套体检结果。available() 和工具内部都用它。 */
let depCache = { at: 0, ok: null, detail: null };
async function checkDeps(c, { force = false } = {}) {
  const now = Date.now();
  if (!force && depCache.detail && now - depCache.at < 30000) return depCache.detail;

  const python = await findPython(c, { force });
  const vw = findVw(c);
  const detail = { python, vw, ok: Boolean(python && vw), reason: '' };

  if (!python) {
    detail.reason = '没找到 python（需要 Python 3.8+）';
  } else if (!vw) {
    detail.reason = '没找到 vw.py（在设置「vw.py 路径」里填它的完整路径）';
  } else {
    // 让 vw.py 自检一遍 ffmpeg / ImageMagick，这是最权威的判据
    const r = await run(python, [vw, 'doctor'], { timeoutMs: 60000 });
    const text = `${r.stdout}\n${r.stderr}`;
    detail.doctor = text;
    if (/必需项就绪/.test(text)) {
      detail.ok = true;
    } else {
      // doctor 失败时把关键几行捞出来，别把整屏丢给模型
      const bad = text.split(/\r?\n/).filter((l) => /缺失|没有找到|未安装|error/i.test(l)).slice(0, 4).join('；');
      detail.ok = false;
      detail.reason = `依赖不齐：${bad || 'vw.py doctor 未通过'}`;
    }
  }

  depCache = { at: now, ok: detail.ok, detail };
  return detail;
}

// ── 工作目录 ──────────────────────────────────────────────────────────────

function jobDir(tag = 'job') {
  // 建目录前先做一次配额检查 —— 把清理挂在"必然发生的事件"上，
  // 比开定时器省心（不会有 unref 漏掉、进程退出前还在跑的问题）。
  try { enforceDiskQuota(); } catch { /* 清理失败不影响正事 */ }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(3).toString('hex');
  const dir = path.join(WORK_ROOT, `${tag}-${stamp}-${rand}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir, keep) {
  if (keep) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * 收尾：删掉工作目录，但**保留要交给模型看的那张图**。
 *
 * ⚠️ 这里踩过一个真实的坑：一开始直接 cleanup(dir)，结果图片路径在返回给
 * 模型之前就被删了——模型拿到一个不存在的路径，等于什么都没看到。
 * 正确做法是先把要用的图挪到固定的 keep 目录，再删整个工作目录。
 */
function keepImage(imagePath, tag = 'sheet') {
  const keepDir = path.join(WORK_ROOT, '_view');
  fs.mkdirSync(keepDir, { recursive: true });
  const dest = path.join(keepDir, `${tag}-${Date.now().toString(36)}${path.extname(imagePath) || '.png'}`);
  fs.copyFileSync(imagePath, dest);
  return dest;
}

// ── 资源治理：磁盘配额与自动清理 ──────────────────────────────────────────
//
// ⚠️ 为什么必须有这一段（2026-10-18 实测发现）：
//   provider `video.watch` 是**核心**在调用的。核心拿到 image 路径后
//   自己不会删——它只负责把图发给模型。于是每次视频都留下一个
//   `core-*/` 目录（里面是 25 张单帧 + 网格图），跑一阵就堆成几百 MB。
//   实测已经攒了 15.8MB / 105 个文件，而这才刚跑了几次。
//
//   长期运行会怎样：磁盘被吃满 → ffmpeg 写图失败 → 视频功能整体挂掉，
//   而用户看到的只是"最近怎么老是抽帧失败"。这种慢性死亡最难排查。
//
// 策略（三层，越靠前越主动）：
//   1. 每次新建工作目录前先做一次配额检查（不额外开定时器，零成本）
//   2. 超过配额 → 按"最久未修改"删到 70%，给下一轮留空间
//   3. 超过 1 小时的孤儿目录无条件删（进程被杀时留下的）

/** 磁盘配额（MB）。超过就清理。 */
const DISK_QUOTA_MB = 300;
/** 清理时保留的比例（删到配额的 70%，避免每来一条就清理一次） */
const DISK_KEEP_RATIO = 0.7;
/** 孤儿目录的年龄上限（毫秒）。超过这个时间的工作目录一定是垃圾。 */
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * 扫描工作根目录，返回 [{path, size, mtime, isView, keep}]。
 * `_view/` 里放的是"要发给模型的图"，可能还有用，清理时最后才动。
 */
function scanWorkDirs() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(WORK_ROOT, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const p = path.join(WORK_ROOT, ent.name);
    const isView = ent.name === '_view';
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        let size = 0;
        let newest = st.mtimeMs;
        for (const f of fs.readdirSync(p)) {
          try {
            const fs2 = fs.statSync(path.join(p, f));
            if (fs2.isFile()) {
              size += fs2.size;
              if (fs2.mtimeMs > newest) newest = fs2.mtimeMs;
            }
          } catch { /* 单文件失败忽略 */ }
        }
        out.push({ path: p, size, mtime: newest, isView });
      }
    } catch { /* ignore */ }
  }
  return out;
}

/** 当前总占用（字节）。 */
function workUsage() {
  return scanWorkDirs().reduce((a, d) => a + d.size, 0);
}

/**
 * 配额检查 + 清理。**在每次新建工作目录前调用。**
 *
 * @returns {{freed:number, removed:number}} 释放的字节数与删掉的目录数
 */
function enforceDiskQuota() {
  const quota = DISK_QUOTA_MB * 1024 * 1024;
  const dirs = scanWorkDirs();
  if (!dirs.length) return { freed: 0, removed: 0 };

  let total = dirs.reduce((a, d) => a + d.size, 0);
  const now = Date.now();
  let freed = 0;
  let removed = 0;

  // 第一刀：孤儿目录（超龄）无条件删——这部分不需要看总大小
  const survivors = [];
  for (const d of dirs) {
    if (now - d.mtime > ORPHAN_MAX_AGE_MS) {
      try { fs.rmSync(d.path, { recursive: true, force: true }); freed += d.size; removed += 1; total -= d.size; } catch { survivors.push(d); }
    } else {
      survivors.push(d);
    }
  }
  if (total <= quota) {
    if (removed) log(`[video-watch] 清理 ${removed} 个超龄工作目录，释放 ${(freed / 1048576).toFixed(1)}MB`);
    return { freed, removed };
  }

  // 第二刀：超配额 → 从最旧的开始删到 70%
  //   `_view/` 排在最后：里面的图是"已经交给模型的"，删了不影响处理，
  //   但可能还有人在看，所以留到最后动。
  const target = quota * DISK_KEEP_RATIO;
  const order = survivors
    .filter((d) => !d.isView)
    .sort((a, b) => a.mtime - b.mtime)
    .concat(survivors.filter((d) => d.isView).sort((a, b) => a.mtime - b.mtime));

  for (const d of order) {
    if (total <= target) break;
    try {
      fs.rmSync(d.path, { recursive: true, force: true });
      freed += d.size;
      removed += 1;
      total -= d.size;
    } catch { /* 单个删不掉不影响其它 */ }
  }
  if (removed) {
    log(`[video-watch] 超出配额（${(quota / 1048576).toFixed(0)}MB），清理 ${removed} 个目录，释放 ${(freed / 1048576).toFixed(1)}MB`);
  }
  return { freed, removed };
}


// ── 媒体准备 ──────────────────────────────────────────────────────────────

/**
 * 把「用户发来的东西」变成本地文件路径。
 *
 * 媒体可能来自三种地方：
 *   · 本地路径（模型从上下文拿到的、或是我们已经下载好的）
 *   · http(s) URL（QQ 的媒体链接，通常带时效签名）
 *   · ctx 里的 media（核心已经下载好并落盘）
 *
 * ⚠️ 不在这里裸下载 URL。原因是 SSRF：URL 来自消息发送方，
 * 让宿主去连任意地址等于给了个内网探测跳板。核心的 safe-fetch 已经做过校验，
 * 所以优先用核心给的本地文件；实在只有 URL 时才走 api.fetch（它带安全校验）。
 */
async function resolveMedia(input, ctx) {
  const raw = String(input || '').trim();

  // 1. ctx 里已经落盘的媒体（最可信）
  for (const key of ['media', 'mediaFile', 'videoFile', 'file']) {
    const v = ctx?.[key];
    const p = typeof v === 'string' ? v : v?.path || v?.file;
    if (p && fs.existsSync(String(p))) return { file: String(p), from: `ctx.${key}` };
  }

  // 2. 本地路径
  if (raw && !/^[a-z]+:\/\//i.test(raw)) {
    const p = raw.replace(/^file:\/\//i, '');
    if (fs.existsSync(p)) return { file: p, from: 'local' };
  }

  // 3. URL：交给核心的安全抓取落地
  if (/^https?:\/\//i.test(raw)) {
    const dir = jobDir('dl');
    const dest = path.join(dir, guessName(raw));
    try {
      if (apiRef?.fetch) {
        const buf = await apiRef.fetch(raw);
        const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf?.body ?? buf);
        if (body?.length) {
          fs.writeFileSync(dest, body);
          return { file: dest, from: 'fetch', tempDir: dir };
        }
      }
      return { error: '这个视频链接下载不下来（可能是链接已过期，或不允许访问外网地址）' };
    } catch (e) {
      return { error: `下载视频失败：${e?.message || e}` };
    }
  }

  return { error: '没拿到视频文件。请把视频消息或本地路径给我。' };
}

function guessName(url) {
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname) || 'media';
    return /\.(mp4|mov|webm|mkv|avi|gif|webp|m4v|flv)$/i.test(base) ? base : `${base}.mp4`;
  } catch { return 'media.mp4'; }
}

// ── 调 vw.py 铺图 ─────────────────────────────────────────────────────────

/**
 * 铺一张联络表。
 *
 * @param {object} o
 *   c        设置
 *   file     本地媒体文件
 *   outDir   输出目录
 *   frames   帧数
 *   cols     列数
 *   t0/t1    时间段（秒，可空）
 * @returns {{ok:boolean, image?:string, manifest?:object, text?:string, error?:string}}
 */
async function buildSheet({ c, file, outDir, frames, cols, t0 = 0, t1 = 0 }) {
  const deps = await checkDeps(c);
  if (!deps.ok) return { ok: false, error: deps.reason };

  const isGif = /\.(gif|webp)$/i.test(file);
  const py = deps.python;
  const vw = deps.vw;

  const args = isGif
    ? [vw, 'gif', file, '--out', outDir, '--max-frames', String(frames)]
    : [vw, 'grid', '--media', file, '--frames', String(frames), '--cols', String(cols), '--out', outDir];

  if (!isGif) {
    if (t0 > 0) args.push('--t0', String(t0));
    if (t1 > 0) args.push('--t1', String(t1));
  }

  log(`[video-watch] ${isGif ? 'gif' : 'grid'} frames=${frames} cols=${cols} ${t0 || t1 ? `t=${t0}~${t1}` : '全片'}`);
  const r = await run(py, args, { timeoutMs: 180000, cwd: outDir });
  if (!r.ok) {
    const why = (r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-4).join(' ');
    return { ok: false, error: why || `vw.py 返回 ${r.code}` };
  }

  // 读 manifest：图片的真实文件名在 gif 结构里是写进 manifest.sheets 的
  let manifest = null;
  const mp = path.join(outDir, 'manifest.json');
  if (fs.existsSync(mp)) {
    try { manifest = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch { manifest = null; }
  }

  // 找图片。文件名各子命令不一样：
  //   grid → grid.png ；gif → gif_sheet_01.png（可能有 01/02/03 多张）
  let image = '';
  const fromManifest = Array.isArray(manifest?.sheets) ? manifest.sheets : [];
  for (const p of fromManifest) {
    const abs = path.isAbsolute(p) ? p : path.join(outDir, p);
    if (fs.existsSync(abs)) { image = abs; break; }
  }
  if (!image) {
    for (const name of ['grid.png', 'sheet.png', 'gif.png', 'overview.png', 'gif_sheet_01.png']) {
      const p = path.join(outDir, name);
      if (fs.existsSync(p)) { image = p; break; }
    }
  }
  if (!image) {
    // 兜底：目录里最大的那张图
    try {
      const imgs = fs.readdirSync(outDir)
        .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
        .map((f) => ({ p: path.join(outDir, f), s: fs.statSync(path.join(outDir, f)).size }))
        .sort((a, b) => b.s - a.s);
      if (imgs.length) image = imgs[0].p;
    } catch { /* ignore */ }
  }
  if (!image) return { ok: false, error: 'vw.py 跑完了但没有产出图片' };

  return { ok: true, image, manifest, text: r.stdout, isGif };
}

/**
 * 把 manifest 压成「位置 → 秒数」的紧凑文本。这是模型对齐时间的唯一依据。
 *
 * ⚠️ 动图和视频的 manifest **结构不同**，必须分别处理（实测踩过）：
 *   · grid（视频）：{ cols, rows, step_s, t1, tiles:[{index,row,col,t,frame}] }
 *   · gif（动图）：{ cols, frames, duration, sampled, tiles:[{row,col,frame,t,delay_ms}] }
 *     —— 没有 rows / index / step_s / t1，行数得自己从 row 最大值推。
 * 早先只按 grid 的字段写，动图就输出「3 列 × undefined 行」。
 */
function describeManifest(manifest, { compact = false } = {}) {
  if (!manifest?.tiles?.length) return '';
  const tiles = manifest.tiles;

  // 列数：两种结构都有 cols
  const cols = Number(manifest.cols) || 0;
  // 行数：grid 直接给；gif 没给，从 row 最大值推
  const rows = Number(manifest.rows)
    || tiles.reduce((m, t) => Math.max(m, Number(t.row) || 0), 0)
    || (cols ? Math.ceil(tiles.length / cols) : 0);

  // ⚠️ 不能直接用 manifest.t1 当中文里的「覆盖范围」：
  //    vw.py 在指定 t0/t1 取段时，t1 仍写整片时长，于是 zoom 第 20~28 秒
  //    会被描述成「覆盖 0.0~28.0 秒」——把「片尾」当成了「这段的结尾」。
  //    真正的范围只能从第一格到最后一格算。
  const first = Number(tiles[0]?.t) || 0;
  const last = Number(tiles[tiles.length - 1]?.t) || 0;

  // 间隔：grid 的 step_s 是秒；gif 只有逐帧 delay_ms，用相邻 t 的差算
  let step = Number(manifest.step_s) || 0;
  if (!step && tiles.length > 1) {
    step = (Number(tiles[1].t) || 0) - (Number(tiles[0].t) || 0);
  }

  const head = `铺法：${cols || '?'} 列 × ${rows} 行，共 ${tiles.length} 格`
    + `，覆盖 ${first.toFixed(1)}~${last.toFixed(1)} 秒`
    + (step > 0 ? `，每格间隔 ${step.toFixed(2)} 秒` : '');

  if (compact) {
    return `${head}\n时间轴：第 1 格 = ${first.toFixed(1)} 秒，最后一格 = ${last.toFixed(1)} 秒。`
      + `可以按「第几行第几列」或「第几秒」两种方式指位置。`;
  }

  // 逐格列举。gif 的 tiles 没有 index，用数组序号补上（阅读顺序 = 时间顺序）。
  const rowsText = tiles.map((t, i) => {
    const n = Number(t.index) || i + 1;
    return `#${n}(${t.row}行${t.col}列)=${Number(t.t).toFixed(1)}s`;
  });
  const lines = [];
  for (let i = 0; i < rowsText.length; i += 5) lines.push(rowsText.slice(i, i + 5).join('  '));
  return `${head}\n${lines.join('\n')}`;
}

/** 发图到当前聊天。失败不阻断（图已经生成，模型照样能看）。 */
async function sendToChat(ctx, imagePath, note) {
  try {
    if (!ctx?.sender || !ctx?.chatKey) return false;
    await ctx.sender.sendImage(ctx.chatKey, { file: imagePath }, { note });
    return true;
  } catch (e) {
    warn(`[video-watch] 发图失败：${e?.message || e}`);
    return false;
  }
}

// ── 依赖检查（同步，UI 用） ───────────────────────────────────────────────
//
// ⚠️ available() 必须是**同步**函数。SkillManager 的可用性判定是同步调用链，
// 返回 Promise 会被当成「可用」（Promise 是 truthy），等于永远显示生效中。
// 但探测 python/ffmpeg 必须 spawn 进程。折中：首次乐观放行 + 后台探测，
// 结果缓存下来供后续判定与 UI 展示。

let availKnown = null;
let probing = false;
function probeInBackground() {
  if (probing || availKnown !== null) return;
  probing = true;
  checkDeps(readCfg())
    .then((d) => { availKnown = d.ok; })
    .catch(() => { availKnown = false; })
    .finally(() => { probing = false; });
}

export function available() {
  if (availKnown === false) {
    // 失败结果 60 秒后可重探：用户可能刚装好依赖
    const age = Date.now() - (depCache.at || 0);
    if (age > 60000) { availKnown = null; depCache = { at: 0, ok: null, detail: null }; }
  }
  if (availKnown === null) {
    probeInBackground();
    return { ok: true };
  }
  if (!availKnown) {
    return { ok: false, reason: depCache.detail?.reason || '依赖不齐（需要 python、ffmpeg、ImageMagick）' };
  }
  return { ok: true };
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

/**
 * 技能入口。
 *
 * ⚠️ 工具必须**在这个函数里**注册（`api.registerTool`）。
 * 加载器只调用 `setup(api)`（旧插件入口 `register(api)` 也兼容，但只认这两个名字）。
 * 我一开始把注册逻辑写在单独导出的 `register(api)` 里、`setup` 只存配置，
 * 结果加载日志报「在 skills/（LLM 型）却没有注册任何工具：模型看不到它」，
 * 技能列表里 toolIds 是 0 —— 模型完全不知道有这个能力。
 */
export function setup(api) {
  apiRef = api;
  cfg = api.config;
  log = api.log || (() => {});
  warn = api.warn || (() => {});
  try { fs.mkdirSync(WORK_ROOT, { recursive: true }); } catch { /* ignore */ }
  log(`视频识读已加载（v1.0.0）｜工作目录：${WORK_ROOT}`);

  const c0 = readCfg();
  if (!c0.enabled) {
    log('视频识读：设置里关掉了，不注册工具');
    return;
  }
  // ── 四个工具：速览 / 细看 / 读字 / 自检 ──────────────────────────────

  // ── 1. 速览：一张图看全片 ────────────────────────────────────────────
  api.registerTool({
    id: 'overview',
    name: '视频速览',
    description: '把一个视频或动图铺成一张带帧号的联络表，一次看全片。这是看视频的第一步：'
      + '先建立「这段大概是什么内容」的整体印象，再决定要不要细看某一段。'
      + '返回一张图（模型能直接看到）+ 位置与秒数的对应表（据此说出「第几秒发生了什么」）。'
      + '视频和动图都支持。',
    category: 'media',
    icon: '🎞️',
    defaultEnabled: true,
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: {
        media: { type: 'string', description: '视频/动图的本地路径或 http(s) 链接' },
        frames: { type: 'number', description: '铺几格，默认按设置（25）。短视频可以用更少，长视频别超过 36' },
        send_to_chat: { type: 'boolean', description: '是否把这张联络表发到当前聊天，默认按设置（发）' }
      },
      required: ['media']
    },
    async execute(ctx, args) {
      const c = readCfg();
      if (!c.enabled) return fail('视频识读被关掉了（设置里打开）');
      if (++watchCount > MAX_WATCH_PER_RUN) {
        return fail(`这一轮已经处理过 ${MAX_WATCH_PER_RUN} 次视频了，先说说前面的结果吧`);
      }

      const m = await resolveMedia(args?.media, ctx);
      if (m.error) return fail(m.error);
      if (m.tempDir) m.cleanupAfter = true;

      // 时长检查：超长视频铺 25 格会看不出东西，提前拦住
      const dur = await probeDurationFor(c, m.file);
      if (dur > c.maxClipSeconds) {
        return fail(`这段视频有 ${(dur / 60).toFixed(1)} 分钟，超过设置的 ${Math.round(c.maxClipSeconds / 60)} 分钟上限。`
          + `建议改用 zoom 指定一段来看，或者先说清楚你在意哪一部分。`);
      }

      const dir = jobDir('ov');
      const frames = Math.max(4, Math.min(36, Math.round(Number(args?.frames) || c.overviewFrames)));
      const cols = Math.max(2, Math.min(8, Math.round(Number(args?.cols) || c.overviewCols)));

      const r = await buildSheet({ c, file: m.file, outDir: dir, frames, cols });
      if (!r.ok) {
        cleanup(dir, c.keepWorkFiles);
        return fail(`铺图失败：${r.error}`);
      }

      const shouldSend = args?.send_to_chat === undefined ? c.sendOverviewToChat : args.send_to_chat === true;
      const sent = shouldSend ? await sendToChat(ctx, r.image, '视频速览') : false;

      // 先把图挪到长期目录，再删工作目录 —— 否则模型拿到的路径已失效
      const kept = keepImage(r.image, 'overview');
      cleanup(dir, c.keepWorkFiles);

      const head = `已把${r.isGif ? '动图' : '视频'}铺成一张联络表，你现在能直接看到全部 ${frames} 格画面。`;
      const meta = describeManifest(r.manifest, { compact: true });
      const guide = [
        '',
        '怎么用这张图：',
        '· 图中每格左上角有个数字（帧号），按「从左到右、从上到下」的顺序就是时间顺序。',
        '· 先说出整体在讲什么，再点出关键几格。',
        '· 两格之间的过程你**没有**看到，不要编中间细节；需要就调 video-watch__zoom 看那一段。'
      ].join('\n');

      return {
        content: `${head}\n${meta}${guide}${sent ? '\n（这张图已经发到聊天里了）' : ''}`,
        images: [{ path: kept, mime: 'image/png' }]
      };
    }
  });

  // ── 2. 细看：指定时间段放大 ──────────────────────────────────────────
  api.registerTool({
    id: 'zoom',
    name: '视频细看',
    description: '只看视频/动图的某一段，用更少的格数换来更大的单格——用于看清动作、表情、文字细节。'
      + '当你在速览图上看不清某几秒发生了什么，就用它。可以连续调用来一段一段看。',
    category: 'media',
    icon: '🔍',
    defaultEnabled: true,
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: {
        media: { type: 'string', description: '视频/动图的本地路径或 http(s) 链接' },
        start_sec: { type: 'number', description: '从第几秒开始看' },
        end_sec: { type: 'number', description: '看到第几秒（留空 = 到片尾）' },
        frames: { type: 'number', description: '铺几格，默认按设置（9）。格子越少单格越大越清楚' },
        send_to_chat: { type: 'boolean', description: '是否发到聊天，默认不发（细看图是给你自己看的）' }
      },
      required: ['media', 'start_sec']
    },
    async execute(ctx, args) {
      const c = readCfg();
      if (!c.enabled) return fail('视频识读被关掉了（设置里打开）');

      const m = await resolveMedia(args?.media, ctx);
      if (m.error) return fail(m.error);

      const t0 = Math.max(0, Number(args?.start_sec) || 0);
      const t1 = Math.max(0, Number(args?.end_sec) || 0);
      if (t1 && t1 <= t0) return fail('结束时间必须在开始时间之后');

      const span = t1 ? t1 - t0 : 0;
      if (span > 120) {
        return fail(`一次最多看 2 分钟的跨度（你给的是 ${Math.round(span)} 秒）。分成几段看会清楚得多。`);
      }

      const dir = jobDir('zm');
      const frames = Math.max(4, Math.min(16, Math.round(Number(args?.frames) || c.zoomFrames)));
      const cols = Math.max(2, Math.min(6, Math.round(Number(args?.cols) || c.zoomCols)));

      const r = await buildSheet({ c, file: m.file, outDir: dir, frames, cols, t0, t1 });
      if (!r.ok) {
        cleanup(dir, c.keepWorkFiles);
        return fail(`细看失败：${r.error}`);
      }

      const sent = args?.send_to_chat === true ? await sendToChat(ctx, r.image, '视频细看') : false;

      const range = t1 ? `第 ${t0}~${t1} 秒` : `第 ${t0} 秒到片尾`;
      const meta = describeManifest(r.manifest, { compact: false });
      const kept = keepImage(r.image, 'zoom');
      cleanup(dir, c.keepWorkFiles);

      return {
        content: `已把${range}铺成 ${frames} 格（单格比速览图大得多，能看清细节）。\n${meta}`
          + `\n每格左上角数字是帧号，下方是这一格代表的秒数。`
          + (sent ? '\n（已经发到聊天里）' : ''),
        images: [{ path: kept, mime: 'image/png' }]
      };
    }
  });

  // ── 3. 读文字：把画面里的字读出来 ────────────────────────────────────
  api.registerTool({
    id: 'read_text',
    name: '读画面文字',
    description: '读出视频某一时刻画面里的文字（PPT、字幕、弹幕、界面上的字）。'
      + '当你需要准确引用画面上的内容时才用——直接看图读字容易看错，这个会把那一格放大。',
    category: 'media',
    icon: '🔤',
    defaultEnabled: true,
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: {
        media: { type: 'string', description: '视频/动图的本地路径或链接' },
        at_sec: { type: 'number', description: '看第几秒的画面' },
        frames: { type: 'number', description: '这一秒附近取几帧，默认 3（取多了能挑最清晰的一格）' }
      },
      required: ['media', 'at_sec']
    },
    async execute(ctx, args) {
      const c = readCfg();
      if (!c.enabled) return fail('视频识读被关掉了（设置里打开）');

      const m = await resolveMedia(args?.media, ctx);
      if (m.error) return fail(m.error);

      const at = Math.max(0, Number(args?.at_sec) || 0);
      const frames = Math.max(2, Math.min(6, Math.round(Number(args?.frames) || 3)));
      // 以 at 为中心取一小段：at-0.3 ~ at+0.7，避开转场正好卡在边界
      const t0 = Math.max(0, at - 0.3);
      const t1 = at + 0.7;

      const dir = jobDir('rd');
      const r = await buildSheet({ c, file: m.file, outDir: dir, frames, cols: frames <= 3 ? 3 : 2, t0, t1 });
      if (!r.ok) {
        cleanup(dir, c.keepWorkFiles);
        return fail(`取画面失败：${r.error}`);
      }

      const meta = describeManifest(r.manifest, { compact: true });
      const kept = keepImage(r.image, 'read');
      cleanup(dir, c.keepWorkFiles);
      return {
        content: `已取第 ${at} 秒附近的 ${frames} 帧（放大版）。\n${meta}`
          + `\n读出画面上的文字，注意区分标题、正文、按钮等不同位置的字。看不清就说看不清。`,
        images: [{ path: kept, mime: 'image/png' }]
      };
    }
  });

  // ── 4. 环境自检 ──────────────────────────────────────────────────────
  api.registerTool({
    id: 'doctor',
    name: '视频识读自检',
    description: '检查视频识读需要的程序装好没有（python / ffmpeg / ImageMagick）。'
      + '当铺图失败、或用户问「为什么看不了视频」时，先用它查清楚，别瞎猜。',
    category: 'system',
    icon: '🩺',
    defaultEnabled: true,
    requiresVision: false,
    parameters: { type: 'object', properties: {} },
    async execute() {
      const c = readCfg();
      const d = await checkDeps(c, { force: true });
      const lines = [
        `python：${d.python ? `✅ ${d.python}` : '❌ 没找到'}`,
        `vw.py：${d.vw ? `✅ ${d.vw}` : '❌ 没找到'}`,
        `整体：${d.ok ? '✅ 就绪' : `❌ ${d.reason}`}`
      ];
      if (d.doctor) {
        // 只取关键的几行，别把整屏塞给模型
        const key = d.doctor.split(/\r?\n/)
          .filter((l) => /^(ffmpeg|ffprobe|magick|font|vwtools|python|Pillow|numpy|必需项)/i.test(l.trim()))
          .slice(0, 10);
        if (key.length) lines.push('', '详细：', ...key.map((l) => `· ${l.trim()}`));
      }
      return { content: lines.join('\n'), isError: !d.ok };
    }
  });
}

export function dispose() {
  // 没有常驻进程、没有定时器，清掉缓存即可
  depCache = { at: 0, ok: null, detail: null };
  pyCache = { at: 0, path: '' };
  availKnown = null;
  log('视频识读已卸载');
}

export function activate() { /* 无状态 */ }
export function deactivate() { /* 无状态 */ }

// ── 能力 provider ─────────────────────────────────────────────────────────

/**
 * ⚠️ 这里必须同时提供 **两套** 能力，原因是核心有两条路，而且只认其中一条：
 *
 *   · 核心 `src/video-reader.js` 只查 `video.frames` / `video.frames.available`
 *     —— 那是 frame-detective 插件的接口。它压根不知道 `video.watch` 存在。
 *   · 如果 `video.frames` 没人提供（比如 frame-detective 被关掉），核心会
 *     降级成 route='meta'，只给模型一句「视频信息：时长 30 秒，480×852」，
 *     **一帧画面都不给**。表现就是角色说的「抽帧组件没跑起来，只拿到个壳子」。
 *
 * 所以：
 *   · `video.watch.*`  → 给我们自己的工具和未来的调用方用（铺联络表）
 *   · `video.frames.*` → **兼容层**，让核心那条老链路也能落到我们身上，
 *                        返回 data URL 数组（核心要的就是这个格式）
 *
 * 两套都提供，才不会出现「装了这个却还是看不到画面」。
 */
export const providers = {
  'video.watch.available': async () => {
    const d = await checkDeps(readCfg());
    return { ok: d.ok, reason: d.reason || '' };
  },

  'video.watch': async ({ filePath, frames, cols, outDir, t0, t1 } = {}) => {
    const c = readCfg();
    const dir = outDir || jobDir('core');
    const r = await buildSheet({
      c,
      file: filePath,
      outDir: dir,
      frames: Math.max(4, Math.min(36, Math.round(Number(frames) || c.overviewFrames))),
      cols: Math.max(2, Math.min(8, Math.round(Number(cols) || c.overviewCols))),
      t0: Number(t0) || 0,
      t1: Number(t1) || 0
    });
    if (!r.ok) return { ok: false, error: r.error };

    // ⚠️ 这里**必须自己收尾**（2026-10-18 修的泄漏）。
    // 调用方是核心 VideoReader，它拿到 image 路径后只负责把图读出来发给模型，
    // 不会删目录。原来的写法直接 return，于是每次视频都留一个 core-*/ 目录
    // （25 张单帧 + 联络表），跑一阵就攒到几百 MB，最后 ffmpeg 写图失败、
    // 视频功能整体挂掉，而用户只看到"最近老是抽帧失败"——最难查的那种慢性死亡。
    //
    // 做法：把图读成 base64 一起返回，调用方不需要再碰磁盘，目录就能删干净。
    // base64 只占内存一瞬间（140KB 的图约 190KB 字符串），比留一堆文件划算得多。
    let sheetDataUrl = '';
    try {
      const buf = fs.readFileSync(r.image);
      sheetDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    } catch { /* 读失败就当没有，至少别把目录留住 */ }
    cleanup(dir, c.keepWorkFiles);

    return {
      ok: true,
      image: r.image,
      sheet: sheetDataUrl,          // 可直接放进 image_url 部件，无需再读盘
      manifest: r.manifest,
      workDir: c.keepWorkFiles ? dir : ''   // 只在明确要保留时才给路径
    };
  },

  // ── 兼容核心的旧链路 ────────────────────────────────────────────────────
  // 契约（照 frame-detective 的）：输入 {filePath,count,durationSec,adaptiveVideo}
  //                            输出 {frames:['data:image/jpeg;base64,...'], times:[秒]}
  'video.frames.available': async () => {
    const d = await checkDeps(readCfg());
    return { ok: d.ok, reason: d.reason || '' };
  },

  'video.frames': async ({ filePath, count, durationSec, maxWidth } = {}) => {
    const c = readCfg();
    const file = String(filePath || '');
    if (!file || !fs.existsSync(file)) {
      return { frames: [], times: [], error: '视频文件不存在' };
    }
    const deps = await checkDeps(c);
    if (!deps.ok) return { frames: [], times: [], error: deps.reason };

    // 帧数：调用方给了就用，否则按视频规则（每 2 秒 1 帧，6~12）
    const dur = Number(durationSec) || await probeDurationFor(c, file);
    let want = Math.round(Number(count) || 0);
    if (!(want > 0)) {
      want = dur > 0 ? Math.min(12, Math.max(6, Math.ceil(dur / 2))) : 6;
    }
    want = Math.max(1, Math.min(12, want));

    const dir = jobDir('frames');
    try {
      // 直接用 ffmpeg 逐帧抽（不需要铺图，核心要的是散帧数组）
      const out = await extractDataUrls({
        file,
        count: want,
        durationSec: dur,
        maxWidth: Number(maxWidth) || 768,
        quality: c.jpegQuality,
        outDir: dir
      });
      if (out.error) return { frames: [], times: [], error: out.error, durationSec: dur };
      return { frames: out.frames, times: out.times, durationSec: dur };
    } finally {
      cleanup(dir, c.keepWorkFiles);
    }
  },

  // ── 兜底下载 ────────────────────────────────────────────────────────────
  // 核心 `VideoReader.#localize()` 有两条路：OneBot 缓存（get_video/get_file）
  // 和直接下载 url。**两条都失败**时它抛错，probe 就降级成 route='meta'，
  // 模型只拿到「视频信息：时长 30 秒，480×852」——就是角色说的"只拿到个壳子"。
  //
  // 实测真实故障（2026-10-18 22:42）：群友发的 30 秒竖屏视频，OneBot 没有缓存、
  // QQ 的 url 又带时效签名，核心下载失败 → 一帧都没有。而此时抽帧能力明明可用。
  //
  // 所以这里再试一次：换一套请求头、跟随重定向、放宽超时。
  // 核心的 safe-fetch 偏保守（防 SSRF），对 QQ 媒体 CDN 的签名链接容易 403；
  // 技能是使用者显式装的，只处理自己的会话媒体，用宽松一点的抓法更实际。
  'video.fetch-fallback': async ({ url, outDir } = {}) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: '不是 http(s) 地址' };
    const c = readCfg();
    const dir = outDir || jobDir('dl');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const dest = path.join(dir, `v_${Date.now().toString(36)}${guessExt(u)}`);
    try {
      const bytes = await fetchToFile(u, dest);
      if (!bytes || bytes < 1024) {
        cleanup(dir, c.keepWorkFiles);
        return { ok: false, error: `下载到的内容太小（${bytes || 0} 字节），可能不是视频` };
      }
      return { ok: true, file: dest, bytes };
    } catch (e) {
      cleanup(dir, c.keepWorkFiles);
      return { ok: false, error: e?.message || String(e) };
    }
  }
};

/**
 * 下载到磁盘（**边收边写**，不把整个文件读进内存）。
 *
 * ⚠️ 这里改过一次，原因值得记：
 *   最初写成 `chunks.push(chunk)` 再 `Buffer.concat(chunks)`——等于把整个视频
 *   装进 Node 进程内存。一个 200MB 的视频就吃 200MB 堆，群里同时来几条，
 *   QQ Agent 直接被系统 OOM 杀掉。表现是"机器人突然没了"，日志里什么都看不到。
 *   现在改成 createWriteStream 边下边落盘，内存占用与文件大小无关。
 *
 * 大小上限仍然保留：消息发送方可以塞任意大的文件进来，没有上限就是给了
 * 一个"用一条消息打挂机器人"的开关。
 *
 * @returns {Promise<number>} 写入的字节数
 */
async function fetchToFile(url, dest, { timeoutMs = 45000, maxBytes = 200 * 1024 * 1024 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let out = null;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': 'https://qun.qq.com/'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // 先看声明的大小，省得白下
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new Error(`文件太大（${(len / 1048576).toFixed(0)}MB）`);

    out = fs.createWriteStream(dest);
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('文件超过 200MB');
      // 写不动就等 drain，避免把数据全堆在内存里
      if (!out.write(chunk)) {
        await new Promise((r) => out.once('drain', r));
      }
    }
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
    out = null;
    return total;
  } catch (e) {
    // 失败要把半个文件删掉，否则下次会被当成"完整的坏文件"
    try { if (out) { out.destroy(); out = null; } } catch { /* ignore */ }
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function guessExt(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    for (const ext of ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.gif', '.webp', '.m4v', '.flv']) {
      if (p.includes(ext)) return ext;
    }
  } catch { /* ignore */ }
  return '.mp4';
}

/**
 * 抽 N 张散帧，返回 data URL 数组（核心的 video.frames 契约要这个格式）。
 *
 * 时间点落在 (4%, 96%) 区间均匀分布：避开片头片尾的黑场与 logo，
 * 那是纯浪费的 2 帧。这个策略沿用 frame-detective 的实测结论。
 */
async function extractDataUrls({ file, count, durationSec, maxWidth, quality, outDir }) {
  const ff = await findFfmpeg();
  if (!ff) return { frames: [], times: [], error: '没找到 ffmpeg' };

  const n = Math.max(1, Math.min(12, count));
  const dur = Number(durationSec) || 0;
  const times = [];
  if (dur > 0) {
    for (let i = 0; i < n; i++) {
      times.push(Number((dur * (0.04 + 0.92 * (i / Math.max(1, n - 1)))).toFixed(3)));
    }
  } else {
    for (let i = 0; i < n; i++) times.push(Number((1 + i * 2).toFixed(3)));
  }

  const frames = [];
  const okTimes = [];
  let totalBytes = 0;

  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const dest = path.join(outDir, `f${i}.jpg`);
    // -ss 放 -i 前面 = 输入定位（快几十倍）；-frames:v 1 = 只要一帧
    const args = ['-y', '-ss', String(t), '-i', file,
      '-frames:v', '1', '-vf', `scale='min(${maxWidth},iw)':-2`,
      '-q:v', String(quality || 4), dest];
    let r = await run(ff, args, { timeoutMs: 25000 });
    // 定位点落在文件之外（时长探测不准）时退回首帧，好过整条视频一帧没有
    if ((!r.ok || !fs.existsSync(dest)) && t > 0) {
      r = await run(ff, ['-y', '-ss', '0', '-i', file, '-frames:v', '1',
        '-vf', `scale='min(${maxWidth},iw)':-2`, '-q:v', String(quality || 4), dest], { timeoutMs: 25000 });
    }
    try {
      if (!fs.existsSync(dest)) continue;
      let buf = fs.readFileSync(dest);
      if (!buf.length) continue;

      // ── 单帧体积闸门（2026-10-18 加）──────────────────────────────────
      // 高复杂度画面（满屏雪花、噪点、细密纹理）在 q:v 4 下能到 200KB+，
      // 12 帧就是 2.4MB base64（×1.33 = 3.2MB 字符串）。这会把 HTTP 请求
      // body 顶到网关拒绝的尺寸，整条消息直接 400——用户看到的是"发了视频
      // 机器人就不理我了"。
      //
      // 处理：超了就原地重压一次（q:v 8 + 缩到 512px）。只压一档，不再递归，
      // 避免在一帧上耗掉整轮预算。
      if (buf.length > FRAME_MAX_BYTES) {
        const retry = await run(ff, ['-y', '-i', dest,
          '-vf', "scale='min(512,iw)':-2", '-q:v', '8', dest], { timeoutMs: 15000 });
        if (retry.ok) {
          try {
            const shrunk = fs.readFileSync(dest);
            if (shrunk.length && shrunk.length < buf.length) buf = shrunk;
          } catch { /* 用原来的 */ }
        }
      }
      // 还是太大 → 直接放弃这一帧，不要它比要它好（省得拖垮整条消息）
      if (buf.length > FRAME_MAX_BYTES * 2) continue;

      // ── 总量闸门 ─────────────────────────────────────────────────────
      // 12 帧 × 120KB ≈ 1.4MB 是硬上限。超了就提前收工，剩下的帧不要了。
      if (totalBytes + buf.length > FRAMES_TOTAL_MAX_BYTES) break;

      totalBytes += buf.length;
      frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
      okTimes.push(t);
    } catch { /* 单帧失败不影响其它帧 */ }
  }

  if (!frames.length) return { frames: [], times: [], error: '抽帧没有产出可用画面' };
  return { frames, times: okTimes };
}

/** 单帧 JPEG 上限：超过就重压（150KB 的 768px 图已经很清晰了） */
const FRAME_MAX_BYTES = 150 * 1024;
/** 一次抽帧的总字节上限：1.4MB 原始字节约 1.9MB base64，安全范围 */
const FRAMES_TOTAL_MAX_BYTES = 1400 * 1024;

/** 找 ffmpeg。IMAGE/VIDEO 都靠它，缓存 60 秒失败结果方便"刚装好就能用"。 */
let ffCache = { at: 0, path: '' };
async function findFfmpeg() {
  const now = Date.now();
  if (ffCache.path && now - ffCache.at < 300000) return ffCache.path;
  if (!ffCache.path && now - ffCache.at < 60000) return '';
  for (const name of ['ffmpeg', 'ffmpeg.exe']) {
    const r = await run(name, ['-version'], { timeoutMs: 6000 });
    if (r.ok) { ffCache = { at: now, path: name }; return name; }
  }
  ffCache = { at: now, path: '' };
  return '';
}

/** 探时长（给超长视频拦截用）。失败返回 0，不阻断。 */
async function probeDurationFor(c, file) {
  const vw = findVw(c);
  if (!vw) return 0;
  try {
    const mp = path.join(path.dirname(vw), '_dur.tmp.json');
    const r = await run('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', file
    ], { timeoutMs: 20000 });
    if (!r.ok) return 0;
    const j = JSON.parse(r.stdout);
    void mp;
    return Number(j?.format?.duration) || 0;
  } catch { return 0; }
}

export const internals = {
  DEFAULTS, WORK_ROOT, VW_CANDIDATES,
  readCfg, findPython, findVw, checkDeps, buildSheet, describeManifest,
  resolveMedia, probeDurationFor,
  __resetCaches: () => {
    depCache = { at: 0, ok: null, detail: null };
    pyCache = { at: 0, path: '' };
    availKnown = null;
    watchCount = 0;
  }
};
