/** Read-only host checks. No host files are rewritten or patched at runtime. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const hostRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const checks = [
  ['plugin-loader.js', 'registerTool:', '工具注册'],
  ['plugin-loader.js', 'available: typeof mod.available', '可用性自检'],
  ['orchestrator.js', "runHook('before-context'", '本轮原消息入口'],
  ['orchestrator.js', 'triggerEntries,', '本轮原消息批'],
  ['orchestrator.js', "runHook('before-llm-messages'", '模型消息入口'],
  ['orchestrator.js', "runHook('before-tool'", '工具执行前检查'],
  ['orchestrator.js', "runHook('after-tool'", '完整工具结果入口'],
  ['orchestrator.js', 'result, session', '工具结果及会话'],
  ['orchestrator.js', "runHook('after-response'", '模型响应入口'],
  ['llm.js', 'getRequestTransforms(ctx)', '每次 HTTP 请求转换'],
  ['store.js', 'findByMid(chatKey, mid)', '原消息查找'],
  ['tools.js', 'messageIds: result.sent.map', '实际发送成功 ID'],
];
export function auditHost(root = hostRoot) {
  const files = new Map(), missing = [];
  let version = '';
  try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; }
  catch { missing.push('无法读取 QQ Agent 版本'); }
  if (version !== '0.4.0') missing.push('当前仅验证 QQ Agent 0.4.0；检测到 ' + (version || '未知版本'));
  for (const [file, anchor, label] of checks) {
    if (!files.has(file)) {
      try { files.set(file, fs.readFileSync(path.join(root, 'src', file), 'utf8')); }
      catch { files.set(file, ''); }
    }
    if (!files.get(file).includes(anchor)) missing.push(label + '接口缺失');
  }
  return { ok: missing.length === 0, version, missing, requiredChecks: checks.length };
}
export function compatibility(api, hostAudit) {
  if (!hostAudit.ok) return { ok: false, reason: hostAudit.missing.join('；') };
  for (const id of ['memory-keeper', 'conversation-memory']) {
    if (api?.isSkillActive?.(id)) return { ok: false, reason: '请先停用 ' + id + '，避免两套记忆同时运行；旧文件与数据会保留。' };
  }
  return { ok: true };
}
