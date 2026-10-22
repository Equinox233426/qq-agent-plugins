/**
 * 自检脚本（不是插件的一部分，随时可删）
 *
 * 作用：用**真实的本地聊天存档**跑一遍风格分析，把统计量和最终注入提示词的文本
 * 打印出来 —— 装到 QQ Agent 里之前就能看出"到底学到了什么"，
 * 不用等群里聊半天再猜。
 *
 * 用法（在 QQ Agent 项目根的 resources/app 目录下）：
 *   node plugins/adaptive-group-style/selftest.mjs
 * 指定某个群的存档：
 *   node plugins/adaptive-group-style/selftest.mjs "E:/qqAgent/QQ Agent/data/messages/group_123.json"
 *
 * 这个脚本只读文件、只打印，不写任何东西、不连网。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeStyle, renderStyleHint, summarizeProfile } from './style-engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 找数据目录。
 * 安装版里业务数据在 <安装目录>/data（electron/main.js 的 resolveDataDir），
 * 开发模式在 <项目根>/data。这里按"最可能 → 最不可能"逐个试，
 * 不猜唯一一个 —— 猜错了脚本只会说"没有找到存档"，让人以为数据没了。
 */
const DATA_CANDIDATES = [
  process.env.QQ_AGENT_DATA_DIR || '',
  path.resolve(HERE, '..', '..', '..', '..', 'data'),   // <安装目录>/data（安装版）
  path.resolve(HERE, '..', '..', 'data'),               // <项目根>/data（开发模式）
  path.resolve(HERE, '..', '..', '..', '..', 'data-2')  // 第二实例
].filter(Boolean);

function listMessageFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^(group|private)_\d+\.json$/.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        return { full, size };
      })
      .sort((a, b) => b.size - a.size);
  } catch {
    return [];
  }
}

function readMessages(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed?.messages) ? parsed.messages : [];
  return { chatKey: String(parsed?.chatKey || path.basename(file, '.json').replace('_', ':')), rows };
}

const arg = process.argv[2];
let dataDir = '';
let targets = [];
if (arg) {
  targets = [{ full: path.resolve(arg), size: 0 }];
} else {
  for (const dir of DATA_CANDIDATES) {
    const found = listMessageFiles(path.join(dir, 'messages'));
    if (found.length) { dataDir = path.join(dir, 'messages'); targets = found.slice(0, 3); break; }
  }
}

if (!targets.length) {
  console.log('没有找到聊天存档。试过这些目录：');
  for (const dir of DATA_CANDIDATES) console.log(`  · ${path.join(dir, 'messages')}`);
  console.log('可以手动指定一个存档文件路径作为参数。');
  process.exit(0);
}

console.log(`自检开始｜存档目录：${dataDir || path.dirname(targets[0].full)}`);
console.log(`分词器：${typeof Intl?.Segmenter === 'function' ? 'Intl.Segmenter 可用（精度高）' : '不可用（走朴素统计）'}`);
console.log('');

for (const t of targets) {
  let data;
  try {
    data = readMessages(t.full);
  } catch (error) {
    console.log(`✗ 读不了 ${t.full}：${error.message}`);
    continue;
  }
  const human = data.rows.filter((m) => !m.self && !m.isPoke);
  const self = data.rows.filter((m) => m.self);
  console.log(`${'─'.repeat(72)}`);
  console.log(`会话：${data.chatKey}　共 ${data.rows.length} 条（群友 ${human.length} / 机器人 ${self.length}）`);

  const profile = analyzeStyle({ rows: data.rows, sampleSize: 400, minSample: 30 });
  if (!profile) {
    console.log(`样本不足（群友消息 < 30 条），按设计**不学**，保持上一次档案。`);
    continue;
  }
  console.log(`摘要：${summarizeProfile(profile)}`);
  console.log(`统计窗口：${profile.group.sampleSize} 条 / ${profile.group.senders} 人 / 跨约 ${profile.group.spanDays} 天`);
  console.log(`句长分布：≤6字 ${profile.group.bucketShort} 条、7~15字 ${profile.group.bucketMedium} 条、≥16字 ${profile.group.bucketLong} 条`);
  console.log(`标点比例：句末无标点 ${profile.group.punct.noEndPct}%｜句号 ${profile.group.punct.dotPct}%｜问号 ${profile.group.punct.qPct}%｜感叹号 ${profile.group.punct.exPct}%｜逗号 ${profile.group.punct.commaPct}%｜波浪号 ${profile.group.punct.tildePct}%｜省略号 ${profile.group.punct.ellipsisPct}%｜笑声 ${profile.group.punct.laughPct}%｜叠字 ${profile.group.punct.repeatPct}%｜emoji ${profile.group.punct.emojiPct}%`);
  console.log(`连发节奏：平均一次 ${profile.group.perBurst} 条（共 ${profile.group.bursts} 次开口）`);
  console.log(`口头语：${profile.words.map((w) => `${w.token}(${Math.round(w.ratio * 100)}%${w.from === 'memory' ? ',记忆' : ''})`).join('、') || '（无）'}`);
  if (profile.self?.n) console.log(`机器人自查（最近 ${profile.self.n} 条）：平均 ${profile.self.meanChars} 字；${profile.self.issues.length ? profile.self.issues.join(' / ') : '没有发现偏差'}`);

  console.log('');
  console.log(`──── 即将注入系统提示词的文本（${renderStyleHint(profile, { adoptLevel: '贴近（推荐）', includeWords: true, style: 'full', chatName: data.chatKey }).length} 字）────`);
  console.log(renderStyleHint(profile, { adoptLevel: '贴近（推荐）', includeWords: true, style: 'full', chatName: data.chatKey }));
  console.log('');
  console.log(`──── 即将贴到本次输入末尾的紧凑版（${renderStyleHint(profile, { adoptLevel: '贴近（推荐）', includeWords: true, style: 'compact' }).length} 字）────`);
  console.log(renderStyleHint(profile, { adoptLevel: '贴近（推荐）', includeWords: true, style: 'compact' }));
  console.log('');
}

console.log('自检结束：以上是"纯统计 + 渲染"的结果，没有联网、没有调用模型、没有花任何 token。');
