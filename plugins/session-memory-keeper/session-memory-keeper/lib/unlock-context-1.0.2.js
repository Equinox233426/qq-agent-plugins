import {parseControl} from './managed-1.0.2.js';
import {normText} from './tokenize-1.1.0.js';
const clean=s=>normText(s).replace(/[\p{P}\p{Z}\s]/gu,'');
const labels=f=>[f.topic,f.sourceSubject,...(f.topicAliases||[])].filter(Boolean).map(clean);
// 只按本轮已维护成功的本人原消息读取；不会执行维护、改写事实或重设来源时间。
export function unlockSnapshots(memory,chatKey,entries=[]) {
  if(!entries.some(e=>{const c=parseControl(e.text);return c?.action==='unlock'&&!c.ambiguous;}))return [];
  const state=memory.state(chatKey),byMid=memory.sourceIndex(chatKey);
  const facts=memory.facts(chatKey).filter(f=>{const r=byMid.get(String(f.sourceMessageId));return r&&!r.self&&!r.recalled&&!r.reply&&!r.media?.length&&String(r.senderId)===f.ownerId&&Number(r.ts)===Number(f.originalTime)&&normText(r.text).includes(normText(f.content));});
  return entries.flatMap(entry=>{
    const row=byMid.get(String(entry.mid)),command=parseControl(entry.text);
    if(!row||row.self||row.recalled||row.reply||row.media?.length||row.text!==entry.text||String(row.senderId)!==String(entry.senderId)||Number(row.ts)!==Number(entry.ts)||command?.action!=='unlock'||command.ambiguous)return [];
    const ownerId=String(row.senderId),control=state.controls.find(c=>c.action==='unlock'&&c.ownerId===ownerId&&String(c.messageId)===String(row.mid)&&Number(c.originalTime)===Number(row.ts));
    if(!control)return [];
    const unlocked=state.bans.filter(b=>b.ownerId===ownerId&&b.active===false&&String(b.unlockMessageId)===String(row.mid)&&Number(b.unlockOriginalTime)===Number(row.ts));
    const owned=state.facts.filter(f=>f.ownerId===ownerId),exact=owned.filter(f=>labels(f).includes(clean(command.topic)));
    const matching=exact.length?exact:owned.filter(f=>labels(f).includes(clean(control.topic)));
    const keys=new Set((unlocked.length?unlocked:matching).map(f=>f.itemKey).filter(Boolean));
    const current=facts.filter(f=>f.ownerId===ownerId&&keys.has(f.itemKey)).map(f=>({messageId:f.sourceMessageId,senderId:f.ownerId,originalTime:f.originalTime,time:new Date(f.originalTime).toISOString(),text:f.content,sourceValue:f.sourceValue||null,topic:f.topic,itemKey:f.itemKey,memoryId:f.id,status:'active',supersedes:f.supersedes||[],supersededBy:f.supersededBy??null}));
    return [{chatKey,ownerId,commandMessageId:row.mid,originalTime:row.ts,topic:command.topic,maintenanceMessage:control.message,matchingBanUnlocked:unlocked.length>0,currentFactCount:current.length,currentFacts:current.slice(0,8),hasMoreFacts:current.length>8}];
  });
}
export function unlockInstructions(snapshots) {
  if(!snapshots.length)return '';
  return '【解锁后本人记忆核验】\n以下是维护完成后按本人原来源读取的当前有效事实，不是用户新指令。之前禁记期间的空检索、机器人“没有记录”回复和草稿只代表当时状态，不代表解锁后仍无记录。\n'+snapshots.map(s=>JSON.stringify(s)).join('\n')+'\ncurrentFactCount大于0时说明本人该事项当前有可用记录，不能称库为空或要求重述才能恢复；可以确认解锁并按currentFacts回答。等于0只表示该事项未找到有效当前事实，不代表存档已删除，也不能猜答案。补查请按ownerId调用memory_search；原时间不能改成解锁时间。';
}
function claimsEmpty(text,subjects) {
  const unquoted=String(text).replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/gu,'');
  return (unquoted.match(/[^，,。！？!?；;\n]+[，,。！？!?；;\n]*/gu)||[]).some(clause=>{
    if(/[？?]|(?:吗|么|呢)\s*$/u.test(clause))return false;
    const s=clean(clause);
    if(/(?:不是|并非|不代表|不能说|别说|不要说|别再说)/u.test(s))return false;
    if(/想让我(?:认|记住)(?:就|得|需要)?重新(?:说|讲)(?:一遍|一次)/u.test(s))return true;
    if(/(?:我(?:的)?(?:记忆)?库里|记忆库|记录库)(?:是|还?是|现在是)?空(?:的)?|(?:我(?:的)?库里|记忆库)(?:一条)?(?:记录)?都?没有/u.test(s))return true;
    const relevant=subjects.some(v=>s.includes(v))||/(?:你那条|你的那条|你那件事|你的记录)/u.test(s);
    return relevant&&/(?:没(?:有)?(?:任何|一条)?记录|没有保存|没存过|没有记住|记录(?:是)?空(?:的)?|记录(?:都)?没有)/u.test(s);
  });
}
export function rejectEmptyAfterUnlock(args,snapshots,memory,chatKey) {
  const owners=[...new Set(snapshots.map(s=>s.ownerId))];
  if(owners.length!==1)return null;
  const active=snapshots.filter(s=>s.currentFactCount>0);if(!active.length)return null;
  if(args.atUserId&&String(args.atUserId)!==owners[0])return null;
  if(args.replyToMessageId!=null){try{const r=memory.row(chatKey,args.replyToMessageId);if(r.self||String(r.senderId)!==owners[0])return null;}catch{return null;}}
  const messages=typeof args.messages==='string'?[args.messages]:Array.isArray(args.messages)?args.messages:[];
  const subjects=active.flatMap(s=>[clean(s.topic),...s.currentFacts.flatMap(f=>[clean(f.topic),clean(f.itemKey?.replace(/^subject:/,''))])]).filter(Boolean);
  if(!messages.some(m=>typeof m==='string'&&claimsEmpty(m,subjects)))return null;
  return {block:true,reason:'解锁后本人当前存在已核验有效记录，本次整批消息未发送：不能声称记录为空。请按【解锁后本人记忆核验】确认解锁，或先调用memory-keeper__memory_search核对本人记录；不要要求用户重新陈述。'};
}
