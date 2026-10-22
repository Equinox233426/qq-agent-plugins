// ComfyUI 交互层 —— 路径自动发现 / 端口探测 / 自动拉起 / 提交工作流 / 取回出图。
//
// ── 为什么用 node:http 而不是 api.fetch ────────────────────────────────────
// ComfyUI 就在本机回环地址上。用 api.fetch 走的是应用层的网络栈，可能受系统
// 代理设置影响（某些透明代理环境下，连 127.0.0.1 也可能被绕进代理链路，
// 而这类干扰在排查"为什么连不上明明开着的服务"时极难定位）。
// node:http 直连回环、不受代理影响、也不需要 web_fetch 权限（我们压根不访问外网）。
//
// ── 为什么端口要探测而不是写死 8188 ───────────────────────────────────────
// Comfy Desktop 的 instances 配置里 portConflict 是 auto：当 8188 已被占用时，
// 它会自己换到 8189、8190……（本机实测发生过：手工起的后端占了 8188，随后打开的
// Desktop 落在 8189）。写死端口的表现是"服务明明开着却报连不上"。所以扫 8188~8199。
//
// ── 为什么路径全部自动发现 ────────────────────────────────────────────────
// 这个技能要发给别人用，而每个人的 ComfyUI 装在哪个盘、哪个目录都不一样。
// 好在 Comfy Desktop 把它们都记在固定位置（%APPDATA%\Comfy Desktop\），
// 与安装盘符无关 —— 读两个 json 就能把全部路径推出来，用户一个都不用填。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PORT_RANGE_START = 8188;
const PORT_RANGE_END = 8199;
const PROBE_TIMEOUT_MS = 1200;
const POLL_INTERVAL_MS = 2000;

/** 让并发调用共享同一次启动尝试，避免群里刷屏时拉起一堆 ComfyUI 进程。 */
let startPromise = null;

// ── 底层 HTTP ─────────────────────────────────────────────────────────────

function httpRequest(url, { method = 'GET', body = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`非法地址：${url}`));
      return;
    }
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          text: Buffer.concat(chunks).toString('utf8')
        }));
      }
    );
    // 超时必须显式销毁请求：否则回环上一个半死不活的连接会把这个 Promise 挂死，
    // 表现为工具调用永远不返回（没有超时、没有报错）。
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getJson(url, timeoutMs = 10000) {
  const res = await httpRequest(url, { timeoutMs });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}：${res.text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`返回的不是 JSON：${res.text.slice(0, 200)}`);
  }
}

/** 安全读一个 json 文件；读不到/解析不了都返回 fallback，绝不抛。 */
function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ── 路径自动发现 ──────────────────────────────────────────────────────────

/**
 * 找 Comfy Desktop 生成的模型路径配置。
 * 文件名带实例 id（形如 inst-1234567890.yaml），重建实例后会变，
 * 所以按修改时间取最新的那个，而不是写死文件名。
 */
export function findModelPathsYaml() {
  const base = path.join(process.env.APPDATA || '', 'Comfy Desktop', 'instance-model-paths');
  try {
    const files = fs.readdirSync(base).filter((f) => f.toLowerCase().endsWith('.yaml'));
    if (!files.length) return '';
    files.sort((a, b) => fs.statSync(path.join(base, b)).mtimeMs - fs.statSync(path.join(base, a)).mtimeMs);
    return path.join(base, files[0]);
  } catch {
    return '';
  }
}

/**
 * 从 Comfy Desktop 自己的配置里推出全部路径（同步，纯读文件）。
 *
 * 这是"别人装上也能直接用"的关键：路径不再依赖任何本机特有的目录名，
 * 只依赖 %APPDATA%\Comfy Desktop\ 这个固定位置。
 */
let pathCache = null;
let pathCacheAt = 0;
const PATH_CACHE_TTL_MS = 30000;

export function discoverPaths() {
  // 缓存 30 秒：available() 会被工具可用性判定频繁调用，而这里每次都要读两个
  // json + 扫一个目录。热重载会重新加载模块、缓存随之清空，所以改完设置不用干等。
  if (pathCache && Date.now() - pathCacheAt < PATH_CACHE_TTL_MS) return pathCache;
  const found = {
    comfyDir: '', pythonExe: '', outputDir: '', inputDir: '', modelPathsYaml: '', installPath: ''
  };
  const desktopDir = path.join(process.env.APPDATA || '', 'Comfy Desktop');

  // settings.json —— 输入/输出目录在这里，与实例无关
  const settings = readJsonSafe(path.join(desktopDir, 'settings.json'), {});
  if (settings && typeof settings === 'object') {
    if (settings.outputDir) found.outputDir = String(settings.outputDir);
    if (settings.inputDir) found.inputDir = String(settings.inputDir);
  }

  // installations.json —— 实例装在哪
  let installs = readJsonSafe(path.join(desktopDir, 'installations.json'), []);
  if (!Array.isArray(installs)) installs = [];
  // 优先取"状态正常"的实例；没有就退回第一个带 installPath 的
  const inst = installs.find((i) => i?.status === 'installed' && i.installPath)
    || installs.find((i) => i?.installPath);
  if (inst) {
    found.installPath = String(inst.installPath);
    // Desktop 的实际仓库根在 <installPath>\ComfyUI
    const candidate = path.join(found.installPath, 'ComfyUI');
    found.comfyDir = fs.existsSync(path.join(candidate, 'main.py')) ? candidate : found.installPath;

    // 解释器：Windows 是 .venv\Scripts\python.exe，类 Unix 是 .venv/bin/python
    const win = path.join(found.comfyDir, '.venv', 'Scripts', 'python.exe');
    const nix = path.join(found.comfyDir, '.venv', 'bin', 'python');
    if (fs.existsSync(win)) found.pythonExe = win;
    else if (fs.existsSync(nix)) found.pythonExe = nix;
    else found.pythonExe = process.platform === 'win32' ? win : nix;
  }

  found.modelPathsYaml = findModelPathsYaml();
  pathCache = found;
  pathCacheAt = Date.now();
  return found;
}

/**
 * 把用户填的配置和自动发现的结果合起来：**用户填了的以用户为准**，
 * 留空的用发现值。这样"照默认装好就能用"和"特殊环境能手动覆盖"两头都占。
 */
export function resolveConfig(raw) {
  const auto = discoverPaths();
  const pick = (key) => String(raw?.[key] ?? '').trim() || auto[key] || '';
  return {
    ...(raw || {}),
    comfyDir: pick('comfyDir'),
    pythonExe: pick('pythonExe'),
    outputDir: pick('outputDir'),
    inputDir: pick('inputDir'),
    modelPathsYaml: pick('modelPathsYaml'),
    _auto: auto
  };
}

// ── 端口探测 ──────────────────────────────────────────────────────────────

/** 探测单个端口上是否坐着 ComfyUI。不是 ComfyUI（或压根没开）都返回 null。 */
async function probePort(port, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const data = await getJson(`http://127.0.0.1:${port}/system_stats`, timeoutMs);
    const version = data?.system?.comfyui_version;
    if (!version) return null;
    const device = Array.isArray(data.devices) && data.devices[0]
      ? String(data.devices[0].name || '')
      : '';
    return { base: `http://127.0.0.1:${port}`, port, version, device };
  } catch {
    return null;
  }
}

/**
 * 找到可用的 ComfyUI 实例。
 * baseUrl 填了就用它（连不上就是连不上，不猜）；留空则扫端口。
 */
export async function discover(cfg) {
  const fixed = String(cfg.baseUrl || '').trim();
  if (fixed) {
    const target = new URL(fixed);
    return probePort(Number(target.port) || 80, 4000);
  }
  const ports = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p += 1) ports.push(p);
  // 并发探测：顺序扫 12 个端口最坏要十几秒，而群里等人出图时这十几秒是白等的
  const results = await Promise.all(ports.map((p) => probePort(p)));
  const alive = results.filter(Boolean);
  if (!alive.length) return null;
  // 有多个实例时选端口最小的（通常是主实例，另一个多半是残留）
  alive.sort((a, b) => a.port - b.port);
  return alive[0];
}

// ── 自动拉起 ──────────────────────────────────────────────────────────────

function startBackend(cfg, log) {
  const comfyDir = String(cfg.comfyDir || '').trim();
  const pythonExe = String(cfg.pythonExe || '').trim();
  const mainPy = path.join(comfyDir, 'main.py');

  if (!fs.existsSync(mainPy)) {
    throw new Error(`找不到 ComfyUI 主程序：${mainPy}。`
      + '请确认装的是 Comfy Desktop；若装在特殊位置，到设置页手动填「ComfyUI 程序目录」。');
  }
  if (!fs.existsSync(pythonExe)) {
    throw new Error(`找不到 Python 解释器：${pythonExe}。请在设置页检查「Python 解释器」。`);
  }

  const port = PORT_RANGE_START;
  const args = [mainPy, '--port', String(port), '--disable-auto-launch'];
  if (cfg.modelPathsYaml) args.push('--extra-model-paths-config', String(cfg.modelPathsYaml));
  if (cfg.outputDir) args.push('--output-directory', String(cfg.outputDir));
  if (cfg.inputDir) args.push('--input-directory', String(cfg.inputDir));

  log(`启动 ComfyUI：${pythonExe} ${args.join(' ')}`);
  const child = spawn(pythonExe, args, {
    cwd: comfyDir,
    detached: true,      // 脱离本进程：机器人重启不该把 ComfyUI 一起带走
    stdio: 'ignore',     // 不占管道，ComfyUI 自己会写 user/comfyui.log
    windowsHide: true    // 不弹控制台窗口（它是后台服务，不是给人看的）
  });
  child.unref();
  return child;
}

async function waitReady(cfg, timeoutMs, log) {
  const deadline = Date.now() + Math.max(10000, Number(timeoutMs) || 150000);
  let waited = 0;
  while (Date.now() < deadline) {
    const found = await discover(cfg);
    if (found) {
      log(`ComfyUI 已就绪（${found.base}，v${found.version}，等待 ${Math.round(waited / 1000)}s）`);
      return found;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    waited += POLL_INTERVAL_MS;
  }
  throw new Error(`启动了 ComfyUI 但 ${Math.round(timeoutMs / 1000)} 秒内没就绪。`
    + '首次启动要加载运行库，慢一些正常；若反复如此，请手动打开 Comfy Desktop 看它报什么错。');
}

/**
 * 保证有可用的 ComfyUI：先找现成的（可能用户自己开着 Desktop），找不到再拉起。
 * 返回 { base, port, version, started }。
 */
export async function ensureService(cfg, log = () => {}) {
  const existing = await discover(cfg);
  if (existing) return { ...existing, started: false };

  if (cfg.autoStart === false) {
    throw new Error('ComfyUI 没有运行。请打开 Comfy Desktop，或到设置页把「自动拉起 ComfyUI」打开。');
  }

  if (!startPromise) {
    startPromise = (async () => {
      startBackend(cfg, log);
      return waitReady(cfg, cfg.startTimeoutMs, log);
    })();
    // 完成后清空，让下一次"发现没在跑"时能重新尝试启动
    startPromise.catch(() => {}).finally(() => { startPromise = null; });
  }
  const found = await startPromise;
  return { ...found, started: true };
}

// ── 模型架构探测 ──────────────────────────────────────────────────────────

async function listModels(base, nodeType, field) {
  try {
    const info = await getJson(`${base}/object_info/${nodeType}`, 15000);
    const list = info?.[nodeType]?.input?.required?.[field]?.[0];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * 判断用户填的模型该走哪条加载路径。
 *
 * 不额外开一个"架构"配置项，是因为用户根本答不上来自己那个文件属于哪种 ——
 * 直接问 ComfyUI"这个文件名出现在哪个加载器里"就完了，答案唯一且准确：
 *   · 出现在 CheckpointLoaderSimple 的 ckpt_name 里 → 单文件 checkpoint（市面多数模型）
 *   · 出现在 UNETLoader 的 unet_name 里            → 只有扩散部分，要另配编码器/VAE
 * 找不到时把两份可用清单一起带回去，让报错本身就能指导用户改。
 */
export async function detectArch(base, modelName) {
  const want = String(modelName || '').trim();
  const [checkpoints, unet] = await Promise.all([
    listModels(base, 'CheckpointLoaderSimple', 'ckpt_name'),
    listModels(base, 'UNETLoader', 'unet_name')
  ]);
  const lists = { checkpoints, unet };

  if (!want) return { error: '还没指定模型文件', lists };
  if (checkpoints.includes(want)) return { arch: 'checkpoint', lists };
  if (unet.includes(want)) return { arch: 'split', lists };
  return { error: `ComfyUI 里找不到模型「${want}」`, lists };
}

// ── 工作流 ────────────────────────────────────────────────────────────────

/**
 * 组装 API 格式的工作流图。
 *
 * ⚠️ 这是 ComfyUI 的 **API 格式**（节点 id 作键、输入用 [节点id, 输出槽] 引用），
 * 不是界面里保存的 UI 格式（nodes/links 数组）—— 两者不能混用，
 * 直接 POST UI 格式会报节点校验失败。
 *
 * 两条加载路径汇合之后完全一样：CLIPTextEncode ×2 → KSampler → VAEDecode → SaveImage。
 *   单文件 checkpoint：CheckpointLoaderSimple 一次给出 MODEL(0) / CLIP(1) / VAE(2)
 *   拆分模型（扩散部分、文本编码器、VAE 是三份独立文件的那些）：
 *     UNETLoader + CLIPLoader + VAELoader 三个装载器
 *
 * 拆分路线里 CLIPLoader 的 type 可能填着一个看着完全不搭的值（语言模型编码器却填
 * "stable_diffusion" 之类）—— 那是因为 ComfyUI 对这类编码器是按权重里的 state_dict
 * 自动识别，type 字段不参与判定。照着官方模板抄，别去"修正"它。
 *
 * 采样参数留空时按架构给默认：拆分模型（新式 DiT）用 euler + sgm_uniform + CFG 4，
 * 老式 checkpoint 用 dpmpp_2m + karras + CFG 7.5 —— 后者 CFG 低了会出灰糊图。
 */
export function buildGraph(cfg, { arch, positive, negative, width, height, seed, prefix, batchSize = 1 }) {
  const isCkpt = arch === 'checkpoint';
  // "auto" 与留空同义：按架构挑默认值。之所以在枚举里放一个 auto 而不是用空串，
  // 是因为 configSchema 的 enum 必须带 values，空串在下拉框里表现很怪。
  const pick = (val, forCkpt, forSplit) => {
    const s = String(val ?? '').trim();
    return (!s || s === 'auto') ? (isCkpt ? forCkpt : forSplit) : s;
  };
  const sampling = {
    steps: Number(cfg.steps) > 0 ? Number(cfg.steps) : 30,
    cfg: Number(cfg.cfg) > 0 ? Number(cfg.cfg) : (isCkpt ? 7.5 : 4),
    sampler_name: pick(cfg.sampler, 'dpmpp_2m', 'euler'),
    scheduler: pick(cfg.scheduler, 'karras', 'sgm_uniform')
  };

  const graph = {
    4: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['1', 1] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    6: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: batchSize } },
    7: {
      class_type: 'KSampler',
      inputs: {
        seed,
        ...sampling,
        denoise: 1,
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0]
      }
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['8', 0] } }
  };

  if (isCkpt) {
    return {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: String(cfg.modelName) } },
      ...graph
    };
  }

  // 拆分模型：三个装载器各自的输出接到上面那张图的对应槽位。
  //
  // ⚠️ 文本编码器有**两个不同的装载节点，不能混用**：
  //   单编码器 → CLIPLoader      （type 取 stable_diffusion / qwen_image / wan ...）
  //   双编码器 → DualCLIPLoader  （type 取 flux / sd3 / sdxl / hunyuan_video ...）
  // 两边的 type 枚举**完全不重叠**（CLIPLoader 没有 flux/sdxl，DualCLIPLoader 没有
  // stable_diffusion），用错节点会直接报 invalid clip type。
  // FLUX / SD3 / SDXL 的拆分版都属于双编码器，所以按「有没有填第二个编码器」自动切节点，
  // 不让用户去理解这件事。
  const clipType = String(cfg.clipType || '').trim() || 'stable_diffusion';
  const clip2 = String(cfg.clipName2 || '').trim();
  const clipNode = clip2
    ? {
      class_type: 'DualCLIPLoader',
      inputs: { clip_name1: String(cfg.clipName), clip_name2: clip2, type: clipType, device: 'default' }
    }
    : {
      class_type: 'CLIPLoader',
      inputs: { clip_name: String(cfg.clipName), type: clipType, device: 'default' }
    };

  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: String(cfg.modelName), weight_dtype: 'default' } },
    2: clipNode,
    3: { class_type: 'VAELoader', inputs: { vae_name: String(cfg.vaeName) } },
    ...graph,
    4: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['2', 0] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } }
  };
}

// ── 提交与等待 ────────────────────────────────────────────────────────────

function collectImages(outputs) {
  const list = [];
  for (const node of Object.values(outputs || {})) {
    for (const img of (node?.images || [])) {
      if (img?.filename) list.push(img);
    }
  }
  return list;
}

function describeNodeErrors(body) {
  try {
    const json = JSON.parse(body);
    if (json?.error) return JSON.stringify(json.error).slice(0, 400);
    if (json?.node_errors && Object.keys(json.node_errors).length) {
      return JSON.stringify(json.node_errors).slice(0, 400);
    }
  } catch { /* 不是 JSON，走原文 */ }
  return String(body || '').slice(0, 400);
}

/**
 * 看一眼 ComfyUI 现在的队列，好知道这次要等多久。
 *
 * 为什么不自建一层排队：ComfyUI 本来就是串行执行的，再造一层队列只会让
 * "前面还有几个"变得更不准（我们数的是自己的队列，用户等的是它的）。
 * 所以只查、不管 —— 要的就是个能看见的数字。
 */
export async function getQueue(base) {
  try {
    const data = await getJson(`${base}/queue`, 8000);
    return {
      running: Array.isArray(data?.queue_running) ? data.queue_running.length : 0,
      pending: Array.isArray(data?.queue_pending) ? data.queue_pending.length : 0
    };
  } catch {
    // 查不到就当没排队。这只是个提示，不该因为它挡住出图。
    return { running: 0, pending: 0 };
  }
}

/** 提交工作流并等到出图，返回图片描述数组 [{ filename, subfolder, type }]。 */
export async function submitAndWait(base, graph, timeoutMs, log = () => {}) {
  const res = await httpRequest(`${base}/prompt`, {
    method: 'POST',
    body: { prompt: graph, client_id: randomUUID() },
    timeoutMs: 30000
  });
  if (res.status !== 200) {
    throw new Error(`提交任务被拒绝（HTTP ${res.status}）：${describeNodeErrors(res.text)}`);
  }
  let promptId = '';
  try {
    promptId = JSON.parse(res.text)?.prompt_id || '';
  } catch { /* 下面统一处理 */ }
  if (!promptId) throw new Error(`提交任务失败：没有返回 prompt_id（${res.text.slice(0, 200)}）`);

  const deadline = Date.now() + Math.max(10000, Number(timeoutMs) || 300000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let entry;
    try {
      const data = await getJson(`${base}/history/${promptId}`, 15000);
      entry = data?.[promptId];
    } catch {
      continue;   // 轮询期间服务偶尔抖动不该直接判死
    }
    if (!entry?.status?.completed) continue;

    if (entry.status.status_str === 'error') {
      const errs = (entry.status.messages || []).filter((m) => m?.[0] === 'execution_error');
      throw new Error(`出图失败：${JSON.stringify(errs).slice(0, 400) || 'ComfyUI 报告执行错误'}`);
    }
    const images = collectImages(entry.outputs);
    if (!images.length) throw new Error('出图流程跑完了，但没有任何图片输出');
    return images;
  }

  // 超时：把任务从队列里掐掉，否则它会一直占着显存，后面所有请求都排队
  await httpRequest(`${base}/interrupt`, { method: 'POST', body: {}, timeoutMs: 8000 }).catch(() => {});
  throw new Error(`出图超时（等了 ${Math.round(timeoutMs / 1000)} 秒）。`
    + '任务已中断。首次出图要加载模型会明显偏慢；若经常超时，可到设置页调大"单张出图超时"，'
    + '或降低尺寸/步数。');
}

// ── 出图落地 ──────────────────────────────────────────────────────────────

/** 把 ComfyUI 返回的图片描述拼成本机绝对路径。 */
export function resolveImagePath(cfg, img) {
  const outDir = String(cfg.outputDir || '').trim();
  return path.join(outDir, String(img.subfolder || ''), String(img.filename));
}

/**
 * 清理本技能自己生成的旧图。
 * ⚠️ 只删文件名前缀匹配的 —— 用户自己在 Comfy Desktop 里画的图不会被碰。
 */
export function pruneImages(cfg, log = () => {}) {
  const keep = Number(cfg.keepImages) || 0;
  if (keep <= 0) return 0;
  const outDir = String(cfg.outputDir || '').trim();
  const prefix = String(cfg.filenamePrefix || 'qqagent');
  try {
    const files = fs.readdirSync(outDir)
      .filter((f) => f.startsWith(`${prefix}_`) && /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(outDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);          // 新的在前
    const stale = files.slice(keep);
    for (const item of stale) {
      try { fs.unlinkSync(path.join(outDir, item.f)); } catch { /* 单个删不掉不影响其它 */ }
    }
    if (stale.length) log(`清理了 ${stale.length} 张旧图（保留最近 ${keep} 张）`);
    return stale.length;
  } catch {
    return 0;
  }
}
