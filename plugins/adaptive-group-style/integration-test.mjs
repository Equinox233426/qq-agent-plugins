/**
 * 集成验收（不是插件的一部分，可随时删）
 *
 * 用**宿主真实的加载器**把本插件加载一遍，再模拟编排器一次完整运行，
 * 断言每一步都真的发生了 —— 因为本插件最怕的不是报错，是**静默失效**：
 * 钩子名写错、片段返回格式不对、状态没落盘，界面上全都看不出来。
 *
 * 覆盖：
 *   ① loadPlugins() 真的加载成功（kind=plugin，无 loadError）
 *   ② before-context 真的算出风格并进了缓存
 *   ③ promptSections() 真的吐出片段（id/priority/content 都对）
 *   ④ before-llm-messages 真的往最后一条 user 消息末尾追加了紧凑版
 *   ⑤ after-response 真的记下了机器人发出的消息
 *   ⑥ dispose 之后状态文件真的落盘、内容可解析
 *   ⑦ 关掉开关（config.skills[id].enabled=false）后**一律不再注入**（开关唯一来源）
 *
 * 用法（在 QQ Agent 的 resources/app 目录下）：
 *   node plugins/adaptive-group-style/integration-test.mjs
 *
 * 它会把状态文件写进系统临时目录，**不碰**你真实的 data/。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');

const PLUGIN_ID = 'adaptive-group-style';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-itest-'));
const STATE_FILE = path.join(TMP, 'adaptive-group-style.json');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

/** 造一批像真群的聊天记录（长度、标点、语气词都有明显特征，便于断言）。 */
function fakeMessages(n = 160) {
  const short = ['草', '6', '牛', '哈哈哈', '笑死', '确实', '？', '好耶', '可以', '急急急'];
  const mid = ['今天这波真可以', '你在说什么呢', '我人麻了', '这也太抽象了吧', '等会儿再说'];
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const isSelf = i % 5 === 4;
    if (isSelf) {
      // 机器人自己的发言：故意写长、故意带句号（好让"需要你改的地方"有东西可说）
      rows.push({ id: i, ts: 1_700_000_000_000 + i * 30_000, senderId: 'self', self: true, text: '这是一条比较长的机器人发言，用来测试长度偏差检测是否生效。' });
      continue;
    }
    const text = i % 3 === 0 ? short[i % short.length] : mid[i % mid.length];
    rows.push({ id: i, ts: 1_700_000_000_000 + i * 30_000, senderId: String(1000 + (i % 7)), senderName: `群友${i % 7}`, self: false, text });
  }
  return rows;
}

const rows = fakeMessages(160);

/** 宿主 store 的最小替身（只实现本插件用到的方法，形状与 src/store.js 一致）。 */
function fakeStore() {
  return {
    recent(chatKey, { limit = 80 } = {}) {
      return rows.slice(-limit).map((m) => ({ ...m }));
    },
    listChats: () => ['group:1001'],
    getChatMeta: () => ({ chatKey: 'group:1001', total: rows.length, unread: 0, lastTs: rows[rows.length - 1].ts, lastText: '' })
  };
}

const chatKey = 'group:1001';
const chatName = '测试群';

async function main() {
  // 环境变量是插件找数据目录的第一顺位来源，这里指到临时目录
  process.env.QQ_AGENT_DATA_DIR = TMP;

  console.log(`集成验收开始｜临时数据目录：${TMP}`);
  console.log(`应用根目录：${APP_ROOT}\n`);

  const { loadPlugins } = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'plugin-loader.js')).href);
  const { skillManager } = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'skills', 'manager.js')).href);
  const { setSkillConfig, getSkillConfig } = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'skills', 'config.js')).href);

  console.log('① 用真实加载器加载插件');
  // ⚠️ 只加载**本插件**：loadPlugins 支持自定义根目录，把 plugins 根指到一个
  //    临时目录、里面只放本插件的副本即可。为什么不用真实根目录再逐个禁用别的插件：
  //    禁用只是让 isActive 为 false，别的插件若在 available() 里做错了事、或者
  //    钩子注册在别的 SkillManager 上，都会让"系统提示词一个字节没动"这类断言
  //    变成在测别人（第一版就是这么假失败的 —— 真有另一个插件的钩子改了 system 消息）。
  const soloRoot = path.join(TMP, 'plugins');
  fs.mkdirSync(soloRoot, { recursive: true });
  fs.cpSync(HERE, path.join(soloRoot, PLUGIN_ID), { recursive: true });
  const res = await loadPlugins({
    log: () => {},
    roots: { skills: path.join(TMP, 'skills-empty'), plugins: soloRoot }
  });
  const mine = res.loaded.find((r) => r.id === PLUGIN_ID);
  const status = skillManager.status(PLUGIN_ID);
  check('插件被加载器认到', Boolean(mine), `loaded=${JSON.stringify(res.loaded.map((r) => r.id))}`);
  check('没有 loadError', !status.loadError, status.loadError);
  check('kind = plugin（确定性型，落在 plugins/ 目录）', status.kind === 'plugin', String(status.kind));
  check('active = true（默认启用）', status.active === true, `${status.code || ''} ${status.reason || ''}`);
  check('hooks 名字与宿主调用的完全一致', ['before-context', 'before-llm-messages', 'after-response']
    .every((h) => status.hooks.includes(h)), (status.hooks || []).join(','));

  console.log('\n② before-context：学习这个群');
  const ctx = {
    chatKey, chatName, kind: 'group', chatId: '1001',
    model: 'test-model', provider: 'test', sessionId: 'sess-itest', proactive: false,
    store: fakeStore(), memory: null
  };
  await skillManager.runHook('before-context', ctx);
  const stateAfterLearn = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  check('状态文件已落盘', fs.existsSync(STATE_FILE), STATE_FILE);
  check('档案里有这个群', Boolean(stateAfterLearn.profiles?.[chatKey]));
  check('学到了样本', (stateAfterLearn.profiles?.[chatKey]?.samples || 0) >= 100,
    String(stateAfterLearn.profiles?.[chatKey]?.samples));

  console.log('\n③ promptSections：风格片段进系统提示词');
  const sections = skillManager.getPromptSections(ctx);
  const sec = sections.find((s) => s.skillId === PLUGIN_ID);
  check('拿到了风格片段', Boolean(sec));
  check('片段 id 正确', sec?.id === 'adaptive-group-style', String(sec?.id));
  check('priority = 35（低于核心安全规则的 100）', sec?.priority === 35, String(sec?.priority));
  check('内容里带句长结论', Boolean(sec?.content?.includes('句长')), String(sec?.content || '').slice(0, 60));
  check('内容里带语气词结论', Boolean(sec?.content?.includes('口头禅')), '');

  console.log('\n④ before-llm-messages：紧凑版贴到本次输入末尾');
  const messages = [
    { role: 'system', content: '【核心安全规则】…' },
    { role: 'user', content: '【未读信息】\n[12:00] 群友1：在吗' }
  ];
  const systemBefore = messages[0].content;
  await skillManager.runHook('before-llm-messages', { ...ctx, messages });
  const lastUser = messages[messages.length - 1];
  check('最后一条 user 消息被追加了紧凑版', lastUser.content.includes('【本次发言的语言风格要求'));
  check('系统提示词一个字节没动（前缀缓存不受影响）', messages[0].content === systemBefore);
  const lenBefore = messages[1].content.length;
  await skillManager.runHook('before-llm-messages', { ...ctx, messages });
  check('重复触发不会叠加（重试路径安全）', messages[1].content.length === lenBefore);

  console.log('\n⑤ after-response：记下机器人真正发出去的话');
  const session = {
    id: 'sess-itest',
    sent: [
      { type: 'text', text: '这是一条很长的机器人回复，用来测试"偏长"的偏差检测到底会不会被写进提示词里。' },
      { type: 'sticker', text: '[表情包:猫猫]' }
    ]
  };
  // ⚠️ runHook 是**逐个 await** 的（manager.js 里 for + await），
  //    但钩子同步返回普通对象时 await 仍会切一次微任务，所以这里必须 await 完
  //    再读磁盘 —— 不 await 就会读到"还没来得及写"的状态（脚本第一版就是这么假失败的）。
  await skillManager.runHook('after-response', { ...ctx, session, response: { message: { content: null } } });
  const stateAfterSelf = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const selfSent = stateAfterSelf.profiles?.[chatKey]?.selfSent || [];
  check('记下了 1 条发言（表情包被排除）', selfSent.length === 1, JSON.stringify(selfSent));
  check('记的是文字内容', String(selfSent[0]?.text || '').includes('偏长'), String(selfSent[0]?.text || '').slice(0, 30));

  console.log('\n⑥ 下一轮：偏差提醒应该出现在提示词里');
  await skillManager.runHook('before-context', ctx);
  const sec2 = skillManager.getPromptSections(ctx).find((s) => s.skillId === PLUGIN_ID);
  check('提示词里出现"需要你改的地方"', Boolean(sec2?.content?.includes('需要你改的地方')),
    String(sec2?.content || '').slice(0, 80));

  console.log('\n⑦ 开关的唯一来源：config.skills[id].enabled = false');
  setSkillConfig(PLUGIN_ID, { enabled: false });
  check('技能被判定为未启用', skillManager.isActive(PLUGIN_ID).active === false);
  const sectionsOff = skillManager.getPromptSections(ctx);
  check('关掉后不再产出任何片段', !sectionsOff.some((s) => s.skillId === PLUGIN_ID));
  const messagesOff = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }];
  await skillManager.runHook('before-llm-messages', { ...ctx, messages: messagesOff });
  check('关掉后不再往输入里追加', messagesOff[1].content === 'U', messagesOff[1].content.slice(0, 40));
  setSkillConfig(PLUGIN_ID, { enabled: true });
  check('重新打开后设置生效', getSkillConfig(PLUGIN_ID, {}).enabled === true);

  console.log('\n⑧ 夜间整理官：休息时间解析 / 进攻性扫描 / 热榜匹配（纯函数）');
  // ⚠️ 夜间 E2E 不能复用 skillManager 里那个实例：加载器用 `?t=` 查询串加载，
  //    这里直接 import 拿到的是**另一个**模块实例（钩子记录的 lastEnv 等状态对不上）。
  //    所以给这个实例显式走一遍 setup，再用 __internals 驱动它。
  const mineMod = await import(pathToFileURL(path.join(soloRoot, PLUGIN_ID, 'index.js')).href);
  await mineMod.setup({
    config: () => getSkillConfig(PLUGIN_ID, {}),
    log: () => {},
    warn: () => {}
  });
  const IT = mineMod.__internals;
  check('显式 setup 后夜间定时器在跑', IT.timerAlive === true, String(IT.timerAlive));

  // 休息时间解析（用户人设卡里的真实句式）
  const win1 = IT.parseRestWindowFromText('8.（重点）· 每日 24:00 到次日 8:00 不回复任何消息，如果有人问起就回答在睡觉。');
  check('解析「每日 24:00 到次日 8:00」→ 00:00-08:00', Boolean(win1) && win1.startMin === 0 && win1.endMin === 480, JSON.stringify(win1));
  const win2 = IT.parseRestWindowFromText('晚上11点到早上7点休息，别找我');
  check('解析「晚上11点到早上7点」→ 23:00-07:00（晚上11点要加 12 小时）', Boolean(win2) && win2.startMin === 23 * 60 && win2.endMin === 7 * 60, JSON.stringify(win2));
  check('没有时间段的句子返回 null（不硬猜）', IT.parseRestWindowFromText('注意休息，别熬夜') === null);
  const overnight = { startMin: 23 * 60, endMin: 7 * 60 };
  check('跨午夜窗口：23:30 / 06:00 在，12:00 不在',
    IT.inRestWindow(23 * 60 + 30, overnight) && IT.inRestWindow(6 * 60, overnight) && !IT.inRestWindow(12 * 60, overnight));
  check('普通窗口 00:00-08:00：03:00 在，12:00 不在',
    IT.inRestWindow(3 * 60, { startMin: 0, endMin: 480 }) && !IT.inRestWindow(12 * 60, { startMin: 0, endMin: 480 }));

  // 进攻性扫描
  const aggr = IT.scanAggression(['你才是废物', '闭嘴吧', '？？？', '今天天气不错', '哈哈哈哈']);
  check('进攻性扫描：5 条里抓到 2 条', aggr.hits === 2 && aggr.n === 5, JSON.stringify(aggr));
  check('进攻性扫描：正常闲聊不误报（草/6/哈哈不算攻击）', IT.scanAggression(['哈哈', '6', '确实', '好耶', '草']).hits === 0);
  check('进攻性扫描：留了示例', aggr.examples.length >= 1, JSON.stringify(aggr.examples));

  // 热榜匹配
  const trends = [
    { key: '蚌埠住了', title: '蚌埠住了', desc: '绷不住的谐音', sources: ['tieba'] },
    { key: '某热搜', title: '完全无关的词条', desc: '', sources: ['baidu'] }
  ];
  const chatRows = [{ text: '真是蚌埠住了' }, { text: '哈哈哈 蚌埠住了+1' }, { text: '草' }];
  const matched = IT.matchTrends(trends, chatRows, { limit: 8 });
  check('热榜匹配：命中并计数', matched.length === 1 && matched[0].word === '蚌埠住了' && matched[0].count === 2, JSON.stringify(matched));
  check('热榜匹配：无关词条不硬凑', IT.matchTrends(trends, [{ text: '今天吃了吗' }], { limit: 8 }).length === 0);

  // LLM 输出解析
  const parsedJson = IT.parseNightlyJson('```json\n{"digest":"聊天","tone":"有点冲","toneNote":"少顶人","tips":["a","b"],"memes":[{"word":"蚌埠住了","how":"被逗到用"}],"aggressiveScore":3}\n```');
  check('LLM 输出解析（带代码围栏）', Boolean(parsedJson) && parsedJson.toneNote === '少顶人' && parsedJson.aggressiveScore === 3, JSON.stringify(parsedJson));
  check('LLM 输出解析（坏输出返回 null → 走兜底复盘）', IT.parseNightlyJson('这不是 JSON') === null);

  console.log('\n⑨ 夜间整理端到端（stub LLM + 今天的假聊天记录，force 跑一轮）');
  // 让"休息时间"覆盖全天，测试就不挑运行时刻了（否则白天跑会判"不在休息时间"）
  setSkillConfig(PLUGIN_ID, { restStart: '00:00', restEnd: '23:59', nightly: true });
  const now = Date.now();
  const todayRows = [];
  for (let i = 0; i < 70; i += 1) {
    const isSelf = i % 6 === 5;
    const text = isSelf
      ? (i === 5 ? '你才是废物' : '这是一条机器人今天的回复，测试夜间语气复盘。')
      : (i % 7 === 0 ? '蚌埠住了' : '今天这波操作真的可以');
    todayRows.push({ id: i, ts: now - (70 - i) * 60_000, senderId: isSelf ? 'self' : String(2000 + (i % 5)), senderName: `群友${i % 5}`, self: isSelf, text });
  }
  const todayStore = {
    recent: (k, { limit = 80 } = {}) => todayRows.slice(-limit).map((m) => ({ ...m })),
    listChats: () => ['group:1001'],
    getChatMeta: () => ({ chatKey: 'group:1001', total: todayRows.length, unread: 0, lastTs: now, lastText: '' })
  };
  IT.setLastEnv({ store: todayStore });
  IT.setTrends([{ key: '蚌埠住了', title: '蚌埠住了', desc: '绷不住的谐音', sources: ['tieba'] }]);
  IT.setLlmCall(() => JSON.stringify({
    digest: '群友在玩梗和闲聊', tone: '有一句比较冲', toneNote: '被怼先接梗，不连续顶人两轮',
    tips: ['少用完整句，多打碎片', '被 @ 才展开说'],
    memes: [{ word: '蚌埠住了', how: '被逗到的时候用' }], aggressiveScore: 3
  }));
  IT.touchActivity(now);
  const nightly = await IT.runNightly({ force: true, reason: 'itest' });
  check('夜间整理跑成功（1 个群）', nightly.ok === true && nightly.chats === 1, JSON.stringify(nightly));
  check('当日去重生效（非 force 不再跑）', (await IT.runNightly({})).skipped === '今天已经整理过', String((await IT.runNightly({})).skipped));
  const stateAfterNight = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const nightEntry = stateAfterNight.profiles?.[chatKey]?.night;
  check('复盘产出写进档案', Boolean(nightEntry) && nightEntry.toneNote === '被怼先接梗，不连续顶人两轮', JSON.stringify(nightEntry || {}).slice(0, 140));
  check('进攻性事实被记录（今天那句「废物」）', Number(nightEntry?.aggr?.hits) >= 1, JSON.stringify(nightEntry?.aggr));
  check('热榜匹配进档案', (nightEntry?.hotMatches || []).some((m) => m.word === '蚌埠住了'), JSON.stringify(nightEntry?.hotMatches));
  const d = new Date();
  const dayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  check('夜间状态标记了 lastDay（本地日期，非 UTC）', stateAfterNight.nightly?.lastDay === dayStr, JSON.stringify(stateAfterNight.nightly));
  const archiveFile = path.join(TMP, 'adaptive-group-style-archive', `${dayStr}.json`);
  check('归档文件已写盘（data/adaptive-group-style-archive/日期.json）', fs.existsSync(archiveFile), archiveFile);
  const archiveBody = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
  check('归档里有摘要与梗', Boolean(archiveBody.summary) && (archiveBody.chats?.[0]?.memes || []).some((m) => m.word === '蚌埠住了'), archiveBody.summary || '');
  // ⚠️ 提示词断言查**本实例**的 promptSections：skillManager 里那个是加载器实例
  //    （`?t=` URL），它没有夜间数据，查它会永远假失败。
  //    另外：插件原生 promptSections 返回的字段是 **id**（skillId 是 manager 包装后
  //    才加的），直接调用时按 id 找 —— 早期测试版本混用了两者，永远 undefined。
  const sec3 = (mineMod.promptSections(ctx) || []).find((s) => s.id === PLUGIN_ID);
  check('提示词里出现夜间语气修正', Boolean(sec3?.content?.includes('昨晚复盘')), String(sec3?.content || '').slice(-200));
  check('提示词里出现学到的梗', Boolean(sec3?.content?.includes('蚌埠住了')), '');
  await mineMod.hooks['before-context'](ctx);   // 白天重学：整档替换不能冲掉夜间产出
  const stateAfterRel = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  check('白天重学保留夜间复盘（night 字段随行）', Boolean(stateAfterRel.profiles?.[chatKey]?.night?.toneNote), '');
  const sec4 = (mineMod.promptSections(ctx) || []).find((s) => s.id === PLUGIN_ID);
  check('重学后提示词仍带夜间复盘', Boolean(sec4?.content?.includes('昨晚复盘')), '');
  mineMod.__internals.stopNightTimer();
  check('停用能停掉夜间定时器', mineMod.__internals.timerAlive === false);
  mineMod.__internals.startNightTimer();
  check('重启定时器恢复', mineMod.__internals.timerAlive === true);
  mineMod.__internals.setLlmCall(null);
  mineMod.__internals.setTrends(null);

  console.log('\n⑩ dispose：卸载时把状态写完');
  skillManager.unregister(PLUGIN_ID, { reason: 'test' });
  const finalState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  check('状态文件仍可解析（没写坏）', Boolean(finalState.profiles));
  check('档案保留（关掉再打开不会丢学习结果）', Boolean(finalState.profiles?.[chatKey]));
  check('夜间复盘也随档案保留', Boolean(finalState.profiles?.[chatKey]?.night));
  // 卸载（unregister→dispose）只会停掉**被卸载实例自己**的定时器 —— 这是刻意的：
  // 热重载时新旧实例短暂共存，旧实例的清理不能误杀新实例刚启动的定时器
  // （否则夜间整理静默失效）。这里验证的是本测试实例自己的停止路径。
  mineMod.__internals.stopNightTimer();
  check('停止路径能停掉定时器（不误伤别人、也不留幽灵）', mineMod.__internals.timerAlive === false);
  check('临时文件没留在磁盘上（写入用的是 tmp + rename）',
    fs.readdirSync(TMP, { recursive: true }).every((f) => !String(f).endsWith('.tmp')), '');

  console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录清不掉无所谓 */ }
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error('验收脚本自身崩了：', error);
  process.exit(2);
});
