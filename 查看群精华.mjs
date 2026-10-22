// 查看 QQ 群精华消息 —— QQ Agent 没有这个工具，但 SnowLuma 的 OneBot 接口支持。
//
// 用法（在 D:\QQ-agent 下）：
//   node 查看群精华.mjs                 列出机器人所在的所有群及其精华条数
//   node 查看群精华.mjs 100000000       列出该群的精华消息
//   node 查看群精华.mjs 100000000 30    只显示前 30 条
//
// 读取的是本机 SnowLuma 的 OneBot HTTP 接口（127.0.0.1:3000），令牌自动从
// snowluma/config/onebot_*.json 读取，无需手填。
import fs from 'node:fs';
import path from 'node:path';

const CFG_DIR = path.join(import.meta.dirname, 'snowluma', 'config');
const cfgFile = fs.readdirSync(CFG_DIR).find((n) => n.startsWith('onebot_') && n.endsWith('.json'));
if (!cfgFile) { console.error('找不到 snowluma/config/onebot_*.json'); process.exit(1); }

const ob = JSON.parse(fs.readFileSync(path.join(CFG_DIR, cfgFile), 'utf8'));
const http = ob.networks.httpServers[0];
const BASE = `http://${http.host}:${http.port}`;
const HEADERS = { 'content-type': 'application/json', authorization: 'Bearer ' + http.accessToken };

const groupArg = process.argv[2];
const limit = Number(process.argv[3] || 0);

function segToText(seg) {
  if (typeof seg === 'string') return seg;
  if (!Array.isArray(seg)) {
    if (seg && typeof seg === 'object') return seg.text ?? '';
    return '';
  }
  return seg.map((s) => {
    const t = s?.type;
    if (t === 'text') return s.data?.text ?? '';
    if (t === 'image') return '[图片]';
    if (t === 'face') return '[表情]';
    if (t === 'at') return `@${s.data?.qq ?? ''}`;
    if (t === 'reply') return '[引用]';
    return `[${t ?? '未知'}]`;
  }).join('');
}

const fmtTime = (sec) => {
  try { return new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false }); }
  catch { return String(sec); }
};

async function call(action, params) {
  const r = await fetch(`${BASE}/${action}`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(params),
    signal: AbortSignal.timeout(60000),
  });
  return r.json();
}

const groups = ((await call('get_group_list', {})).data || [])
  .map((g) => ({ id: g.group_id, name: g.group_name }));

if (!groupArg) {
  console.log('机器人所在的群：\n');
  for (const g of groups) {
    const res = await call('get_essence_msg_list', { group_id: g.id });
    const n = (res.data || []).length;
    console.log(`  ${String(g.id).padEnd(12)} ${String(g.name).padEnd(22)} 精华 ${n} 条`);
  }
  console.log('\n想看某个群：node 查看群精华.mjs <群号>');
  process.exit(0);
}

const gid = Number(groupArg);
const g = groups.find((x) => x.id === gid);
const res = await call('get_essence_msg_list', { group_id: gid });
if (res.status !== 'ok') { console.error('取失败:', res.status, res.retcode, res.message || ''); process.exit(1); }

const list = res.data || [];
console.log(`群 ${gid}${g ? ' 「' + g.name + '」' : ''}  精华 ${list.length} 条\n`);
const show = limit > 0 ? list.slice(0, limit) : list;
for (const [i, m] of show.entries()) {
  const text = segToText(m.content).replace(/\s+/g, ' ').trim();
  console.log(`${String(i + 1).padStart(3)}. [${m.sender_nick ?? m.sender_id}] ${fmtTime(m.sender_time)}`);
  console.log(`     ${text || '(无文字内容)'}`);
  if (m.operator_nick) console.log(`     ← 由 ${m.operator_nick} 设为精华  ·  message_id=${m.message_id}`);
  console.log('');
}
if (limit > 0 && list.length > limit) console.log(`… 另有 ${list.length - limit} 条未显示`);
