import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tokenize, normText } from './tokenize-1.1.0.js';

const clean = s => normText(s).replace(/[\p{P}\p{Z}\s]/gu, '');
const dayOf = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const prepared = new WeakMap();
const policies = new WeakMap();
const oldVersions = new WeakMap();
const robotSources = new WeakMap();
function sameOwner(row, ban) { return row.self || String(row.senderId) === ban.ownerId; }
function citedIds(row) {
  const reply=row.reply;
  const refs=[row.replyTo, row.replyToMessageId, row.sourceMessageId,
    typeof reply==='object' ? reply?.mid ?? reply?.messageId ?? reply?.id : reply];
  if(row.self) refs.push(...(String(row.text||'').match(/-?\d+/g)||[]));
  return refs.filter(v=>v!=null).map(String);
}
function baseBlocked(row, ban) {
  if(!sameOwner(row,ban)) return false;
  const text=clean(row.text);
  const subjectKey=ban.itemKey?.startsWith('subject:')?ban.itemKey.slice(8):ban.topicKey;
  return text.includes(subjectKey) || (ban.sourceIds||[]).includes(String(row.mid))
    || (ban.aliases||[]).some(a=>a.length>=4 && text.includes(a));
}
function factForBan(fact,ban) {
  return fact.ownerId===ban.ownerId && (ban.itemKey?fact.itemKey===ban.itemKey:factLabels(fact).some(label=>topicIdentity(label)===topicIdentity(ban.topic)));
}
function preparePolicy(state, rows) {
  const items=state.bans.filter(b=>b.active).map(ban=>{
    const ids=new Set(ban.sourceIds||[]), hidden=new Set(), texts=[];
    let previousUser=null;
    for(const row of rows) {
      const direct=baseBlocked(row,ban);
      const linked=sameOwner(row,ban)&&citedIds(row).some(id=>ids.has(id)||hidden.has(id));
      // 宿主没有给旧回复保存来源列表时，保守停用紧随受限用户消息的一组回复。
      const follows=row.self && previousUser?.blocked && Number(row.ts)>=Number(previousUser.row.ts)
        && Number(row.ts)-Number(previousUser.row.ts)<=30*60000;
      const factLinked=row.self && (robotSources.get(state)?.get(String(row.mid))?.facts||[]).some(f=>factForBan(f,ban));
      const ungrounded=row.self && robotSources.get(state)?.get(String(row.mid))?.ungrounded;
      const blocked=direct||linked||follows||factLinked||ungrounded;
      if(blocked) { hidden.add(String(row.mid)); if(row.self&&clean(row.text).length>=4) texts.push(clean(row.text)); }
      if(!row.self) previousUser={row,blocked};
    }
    return {ban,ids:hidden,texts};
  });
  policies.set(state,items);
}
function factsBySource(state) {
  if(prepared.has(state)) return prepared.get(state);
  const map=new Map();
  for(const fact of state.facts) { const id=String(fact.sourceMessageId); if(!map.has(id)) map.set(id,[]); map.get(id).push(fact); }
  prepared.set(state,map); return map;
}
export function validChat(chatKey) {
  if (!/^(private|group):[1-9]\d{4,15}$/.test(String(chatKey))) throw Error('需要真实当前私聊或群聊标识');
  return String(chatKey);
}
export function parseControl(text) {
  const s = String(text || '').trim().replace(/[。！!]+$/, '');
  let m = /^(?:请)?(?:忘记|别再记|不要再记|禁止记忆)(?:关于)?(.+)$/.exec(s);
  let action = 'forget';
  if (!m) { m = /^(?:请)?(?:允许你重新记住|允许重新记住|重新记住|恢复记忆)(?:关于)?(.+)$/.exec(s); action = 'unlock'; }
  if (!m) { m = /^(?:请)?解除(?:关于)?(.+?)(?:的)?(?:遗忘限制|禁记限制|禁止记忆标记)$/.exec(s); action = 'unlock'; }
  if (!m) return null;
  // 只允许同一维护动作的明确补充句；不把补充句误存成话题，也不猜未知附加要求。
  const parts = m[1].split(/[，,；;。]/).map(v=>v.trim());
  if(parts.length>1) {
    const suffix = action==='forget'
      ? /^(?:(?:以后|今后|之后)\s*)?(?:请)?(?:不要再?|别再?|不再)(?:记住|记忆|记录|记)(?:这个话题|该话题|这个事项|这件事|它)(?:了)?$/
      : /^(?:请)?解除(?:这个话题|该话题|这个事项|这件事)(?:的)?(?:禁记|遗忘|禁止记忆)(?:限制|标记)?$/;
    if(parts.slice(1).some(p=>!suffix.test(p))) return {action,ambiguous:true};
  }
  let topic = parts[0].replace(/^(?:我本人的|我的)/, '').replace(/(?:的)?(?:信息|内容|事情|这件事|这个话题|话题|这件事情)$/, '').replace(/的$/, '').trim();
  if (/^(这|那|它|这件事|那件事|之前那件事|所有|全部)$/.test(topic) || topic.length < 2 || topic.length > 60 || clean(topic).length<2 || !/[\p{L}\p{N}]/u.test(topic) || /[\[\]【】“”"'？?\n]/.test(topic)) return { action, ambiguous: true };
  return { action, topic, topicKey: clean(topic) };
}
const topicIdentity = topic => clean(String(topic).replace(/^(?:我本人的|我的)/, ''));
const baseTopic = topic => topicIdentity(topic).replace(/(?:偏好|喜好)$/, '');
function explicitSubject(row, content, topic) {
  const text=String(row.text||''), excerpt=normText(content);
  const pattern=/(?:^|[：:，,。；;\n])\s*(?:我本人的|我的)([^:：，,。！？?!；;\n]{2,40}?)(?:现在)?(?:改为|改成|变为|变成|是|为)([^，,。！？?!；;\n]+)/gu;
  let matches=[...text.matchAll(pattern)].filter(m=>normText(m[0]).includes(excerpt)||excerpt.includes(normText(m[0]).replace(/^[：:，,。；;\s]+/,'')));
  if(matches.length>1) {
    matches=matches.filter(m=>topicIdentity(m[1])===topicIdentity(topic));
    if(matches.length!==1) return {ambiguous:true};
  }
  const subjects=[...new Set(matches.map(m=>topicIdentity(m[1])))];
  if(subjects.length>1) return {ambiguous:true};
  return subjects.length ? {itemKey:'subject:'+subjects[0],subject:matches[0][1].trim(),value:matches[0][2].trim()} : null;
}
const factLabels = f => [...new Set([f.topic,f.originalTopic,f.sourceSubject,...(f.topicAliases||[])].filter(Boolean))];
function referenceValue(fact,row) {
  const explicit=explicitSubject(row,fact.content,fact.topic);
  if(explicit && !explicit.ambiguous) return explicit.value;
  // 兼容有本人原文、已归组的旧偏好记录；只摘取原文明确说出的值，不猜同义词。
  let text=String(fact.content||'').trim();
  const label=/^([^：:\n]{2,60})[：:]\s*/.exec(text);
  if(label) {
    if(!factLabels(fact).some(name=>topicIdentity(name)===topicIdentity(label[1]))) return '';
    text=text.slice(label[0].length);
  }
  return /^(?:我本人|我)(?:现在)?(?:改为|改成)?(?:喜欢|偏好|爱喝)([^，,。！？?!；;\n]+)/u.exec(text)?.[1]?.trim()||'';
}
function prepareRobotSources(state,rows) {
  const byMid=new Map(rows.map(row=>[String(row.mid),row]));
  const records=state.facts.flatMap(fact=>{
    const row=byMid.get(String(fact.sourceMessageId));
    if(!row || row.self || row.recalled || row.reply || row.media?.length
      || String(row.senderId)!==fact.ownerId || Number(row.ts)!==Number(fact.originalTime)
      || !normText(row.text).includes(normText(fact.content))) return [];
    const value=clean(referenceValue(fact,row));
    return [{fact,row,value}];
  });
  const map=new Map();let previousUser=null;
  for(const row of rows) {
    if(!row.self) {previousUser=row;continue;}
    const text=clean(row.text);
    const refs=citedIds(row), explicit=records.filter(r=>refs.includes(String(r.row.mid)));
    const metadata=/(?:状态\s*[:：]?\s*(?:active|superseded|expired)|sourceMessageId|memoryId|supersededBy)/i.test(String(row.text));
    const claim=/(?:取回|检索(?:到|出|结果)|记忆(?:里|中|记录|工具)|我记得|还记得|已记住|记录的是|原始(?:消息|记录)|最新(?:偏好|记录|版本))/u.test(String(row.text))
      || metadata && /(?:那条|记录|记忆|取回|检索|原文)/u.test(String(row.text));
    // 明确问到本人事项的那一轮，短回答也可按原始事实归源；不跨人猜归属。
    const context=previousUser && Number(row.ts)>=Number(previousUser.ts) && Number(row.ts)-Number(previousUser.ts)<=30*60000 ? previousUser : null;
    const ownRecords=context?records.filter(r=>r.fact.ownerId===String(context.senderId)):[];
    const exactKeys=new Set(ownRecords.filter(r=>r.fact.itemKey?.startsWith('subject:')&&clean(context.text).includes(r.fact.itemKey.slice(8))).map(r=>r.fact.itemKey));
    const labelKeys=exactKeys.size?exactKeys:new Set(ownRecords.filter(r=>factLabels(r.fact).some(name=>clean(context.text).includes(topicIdentity(name)))).map(r=>r.fact.itemKey));
    const contextual=labelKeys.size===1?ownRecords.filter(r=>labelKeys.has(r.fact.itemKey)):[];
    let matches=(contextual.length?contextual:claim?records:[]).filter(r=>r.value.length>=2 && Number(r.row.ts)<=Number(row.ts) && text.includes(r.value));
    // “茉莉绿茶”不能因包含“绿茶”而被当成旧绿茶；选择覆盖该字符位置的最长原文值。
    matches=matches.filter(r=>!matches.some(other=>other.value.length>r.value.length && other.value.includes(r.value)
      && !text.replaceAll(other.value,'').includes(r.value)));
    const latest=new Map();
    for(const record of matches) {
      const key=record.fact.ownerId+':'+record.fact.itemKey;
      const prior=latest.get(key);
      if(!prior || Number(record.row.ts)>Number(prior.row.ts) || record.row.ts===prior.row.ts && Number(record.row.id)>Number(prior.row.id)) latest.set(key,record);
    }
    // 真正引用来源ID时优先使用该引用，不把其他人的相同值混入来源集合。
    const sources=[...new Map((explicit.length?explicit:[...latest.values()]).map(r=>[r.fact.id,r.fact])).values()];
    // 个人记忆断言不能靠语义猜测倒填来源。跨轮省略原值时，没有可核验
    // 事实就停用这条机器人派生记录；普通“我记得这电影…”闲聊不属于此类。
    const personalMemoryClaim=claim && /(?:你|您|他|她|群友|本人|偏好)/u.test(String(row.text))
      && !/[？?]/u.test(String(row.text));
    const requiresOrigin=claim && (personalMemoryClaim || metadata || /(?:取回|记忆记录|原始消息|最新(?:偏好|记录|版本))/u.test(String(row.text)));
    if(sources.length || requiresOrigin) map.set(String(row.mid),{facts:sources,ungrounded:requiresOrigin&&!sources.length});
  }
  robotSources.set(state,map);
}
function normalizeFacts(state, byMid) {
  const records=[];
  for(const fact of state.facts) {
    const row=byMid.get(String(fact.sourceMessageId));
    if(!row || row.self || row.recalled || row.reply || row.media?.length
      || String(row.senderId)!==fact.ownerId || Number(row.ts)!==Number(fact.originalTime)
      || !normText(row.text).includes(normText(fact.content))) continue;
    const explicit=explicitSubject(row,fact.content,fact.topic);
    if(explicit?.ambiguous) continue;
    records.push({fact,row,explicit});
  }
  const aliases=new Map();
  for(const {fact,explicit} of records) if(explicit) {
    for(const label of [...factLabels(fact),explicit.subject]) {
      const key=fact.ownerId+':'+topicIdentity(label);
      if(!aliases.has(key)) aliases.set(key,new Set());
      aliases.get(key).add(explicit.itemKey);
    }
  }
  const groups=new Map();
  for(const record of records) {
    const {fact,explicit}=record;
    const candidates=aliases.get(fact.ownerId+':'+topicIdentity(fact.topic));
    const itemKey=explicit?.itemKey || (candidates?.size===1?[...candidates][0]:'topic:'+topicIdentity(fact.topic));
    const key=fact.ownerId+':'+itemKey;
    if(!groups.has(key)) groups.set(key,[]);
    fact.itemKey=itemKey;
    if(explicit) {fact.sourceSubject=explicit.subject;fact.sourceValue=explicit.value;}
    groups.get(key).push(record);
  }
  for(const group of groups.values()) {
    // 展示名沿用最早写入的名称；版本顺序只采用本人来源时间和本地消息顺序。
    const first=group.slice().sort((a,b)=>Number(a.fact.createdAt)-Number(b.fact.createdAt)||Number(a.row.id)-Number(b.row.id))[0].fact;
    const topic=first.topic, labels=[...new Set(group.flatMap(({fact})=>factLabels(fact)))];
    const ids=new Set(group.map(r=>r.fact.id));
    const revisions=new Map();
    for(const {fact,row} of group) {
      if(fact.topic!==topic) fact.originalTopic ??= fact.topic;
      fact.topic=topic;fact.topicAliases=labels;
      if(!revisions.has(String(row.mid))) revisions.set(String(row.mid),{row,facts:[]});
      revisions.get(String(row.mid)).facts.push(fact);
    }
    const ordered=[...revisions.values()].sort((a,b)=>Number(a.row.ts)-Number(b.row.ts)||Number(a.row.id)-Number(b.row.id));
    for(let i=0;i<ordered.length;i++) for(const fact of ordered[i].facts) {
      const next=ordered[i+1],previous=ordered[i-1];
      if(next) fact.supersededBy=next.facts[0].id;
      else if(!fact.supersededBy || ids.has(fact.supersededBy)) fact.supersededBy=null;
      // 无效或撤回的后续来源仍可使旧版本失效，不把旧值悄悄恢复成现状。
      fact.supersedes=[...new Set([...(fact.supersedes||[]).filter(id=>!ids.has(id)),...(previous?.facts.map(f=>f.id)||[])])];
    }
  }
}
function prepareVersions(state, rows, now) {
  const sourceIds=new Map(state.facts.filter(f=>f.supersededBy||f.expiresAt&&f.expiresAt<=now).map(f=>[String(f.sourceMessageId),f.supersededBy?'superseded':'expired']));
  const derived=new Map();let previousUser=null;
  const staleValues=state.facts.filter(f=>f.supersededBy && f.itemKey?.startsWith('subject:') && clean(f.sourceValue||'').length>=2);
  for(const row of rows) {
    const direct=sourceIds.get(String(row.mid));
    if(row.self) {
      const referenced=(robotSources.get(state)?.get(String(row.mid))?.facts||[]).find(f=>f.supersededBy||f.expiresAt&&f.expiresAt<=now);
      const linked=citedIds(row).map(id=>sourceIds.get(id)||derived.get(id)).find(Boolean);
      const follows=previousUser?.status && Number(row.ts)>=Number(previousUser.row.ts) && Number(row.ts)-Number(previousUser.row.ts)<=30*60000;
      const repeats=previousUser && Number(row.ts)-Number(previousUser.row.ts)<=30*60000 && staleValues.some(f=>
        String(previousUser.row.senderId)===f.ownerId
        && clean(previousUser.row.text).includes(f.itemKey.slice(8))
        && clean(row.text).includes(clean(f.sourceValue))
        && !state.facts.some(current=>current.ownerId===f.ownerId&&current.itemKey===f.itemKey&&!current.supersededBy&&clean(current.sourceValue||'').includes(clean(f.sourceValue))));
      if(linked||follows||repeats||referenced) derived.set(String(row.mid),linked||previousUser?.status||(referenced?.supersededBy?'superseded':referenced?'expired':'superseded'));
    } else previousUser={row,status:direct};
  }
  oldVersions.set(state,derived);
}
function resolveTopic(command, state, ownerId) {
  const entries=[...state.facts,...state.bans].filter(item=>item.ownerId===ownerId && !/[，,；;。]/.test(item.topic));
  const matches=(item,exact)=>factLabels(item).some(name=>exact?topicIdentity(name)===command.topicKey:baseTopic(name)===baseTopic(command.topic));
  const exact=entries.filter(item=>matches(item,true));
  const candidates=exact.length?exact:entries.filter(item=>matches(item,false));
  const keys=[...new Set(candidates.map(item=>{
    if(item.itemKey?.startsWith('subject:')) return item.itemKey;
    const families=[...new Set(state.facts.filter(f=>f.ownerId===ownerId && factLabels(f).some(name=>topicIdentity(name)===topicIdentity(item.topic))).map(f=>f.itemKey))];
    return families.length===1?families[0]:item.itemKey||'topic:'+topicIdentity(item.topic);
  }))];
  if(keys.length>1) return {...command,ambiguous:true};
  return candidates.length ? {...command,topic:candidates[0].topic,topicKey:clean(candidates[0].topic),itemKey:keys[0],topicAliases:factLabels(candidates[0])} : command;
}
function topicSources(state, rows, ownerId, topicKey, itemKey) {
  const matchKey=itemKey?.startsWith('subject:')?itemKey.slice(8):topicKey;
  const related=rows.filter(r=>!r.self && String(r.senderId)===ownerId && clean(r.text).includes(matchKey));
  const facts=state.facts.filter(f=>f.ownerId===ownerId && (itemKey?f.itemKey===itemKey:topicIdentity(f.topic)===topicIdentity(topicKey)));
  return {
    sourceIds:[...new Set([...related.map(r=>String(r.mid)), ...facts.map(f=>String(f.sourceMessageId))])],
    aliases:[...new Set(facts.map(f=>clean(f.content)))].filter(a=>a.length>=4)
  };
}
function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw Error('记忆数据无法读取；已停止操作以避免覆盖，请检查备份'); }
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 1), 'utf8'); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function sourceLine(row, status = 'archive') {
  return { messageId: row.mid ?? null, localId: row.id ?? null, senderId: String(row.senderId || ''), senderName: row.self ? '机器人' : String(row.senderName || ''), self: !!row.self, originalTime: Number(row.ts) || null, time: Number(row.ts) > 0 ? new Date(row.ts).toISOString() : null, text: String(row.text || '').slice(0, 3000), status };
}
export function inferExpiry(row, requested = null) {
  const text = String(row.text || '');
  if (requested) {
    const value=String(requested).trim(), date=value.slice(0,10);
    const ts=Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value)?value+'T23:59:59+08:00':value);
    const calendar=Date.parse(date+'T00:00:00Z');
    if (!Number.isFinite(ts) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0,10)!==date || !text.includes(date)) throw Error('过期时间必须来自原消息明确给出的有效日期；不要猜测');
    return ts;
  }
  const explicit = /有效期\s*[:：]\s*(\d{4}-\d{2}-\d{2})/.exec(text);
  if (explicit) { try { return inferExpiry(row, explicit[1] + 'T23:59:59+08:00'); } catch { return null; } }
  if (!/(提醒|待办|计划|约好|要去|取快递|考试)/.test(text)) return null;
  const delta = /后天/.test(text) ? 2 : /明天/.test(text) ? 1 : /(今天|今晚)/.test(text) ? 0 : null;
  if (delta === null) return null;
  const d = new Date(Number(row.ts));
  if (!Number.isFinite(d.getTime())) return null;
  d.setDate(d.getDate() + delta); d.setHours(23,59,59,999); return d.getTime();
}

export class ManagedMemory {
  constructor({ dataDir, now = () => Date.now(), maxSourceBytes = 64 * 1024 * 1024, provenance = null }) {
    this.dataDir = dataDir; this.now = now; this.maxSourceBytes = maxSourceBytes;
    this.cache = new Map(); this.provenance = provenance;
  }
  file(chatKey) { return path.join(this.dataDir, 'session-memory-keeper', 'scopes', validChat(chatKey).replace(':','_') + '.json'); }
  state(chatKey) {
    const s = read(this.file(chatKey), { version: 1, chatKey, facts: [], bans: [], controls: [] });
    if (s.chatKey !== chatKey || !Array.isArray(s.facts) || !Array.isArray(s.bans) || !Array.isArray(s.controls)) throw Error('记忆维护数据结构无效，停止操作');
    const rows=this.source(chatKey), byMid=this.cache.get(chatKey)?.byMid||new Map();
    normalizeFacts(s,byMid);
    // 兼容1.0.0把仅日期存成UTC零点的记录；明确含时间的来源保持原值。
    for(const fact of s.facts) {
      const row=byMid.get(String(fact.sourceMessageId));
      const date=/有效期\s*[:：]\s*(\d{4}-\d{2}-\d{2})(?![\dT])(?!(?:\s+)(?:\d{1,2}:|上午|下午|晚上|早上))/.exec(String(row?.text||''))?.[1];
      if(date && fact.expiresAt===Date.parse(date+'T00:00:00Z')) {
        const expected=inferExpiry(row,date);
        fact.storedExpiresAt=fact.expiresAt; fact.expiresAt=expected; fact.expiryRule='beijing-date-end';
      }
    }
    // 旧版复合句解析错误也按本人已保存的原始授权修正；读取不写文件。
    for(const ban of s.bans) {
      const row=byMid.get(String(ban.commandMessageId));
      if(!row || row.self || row.recalled || row.reply || row.media?.length
        || String(row.senderId)!==ban.ownerId || Number(row.ts)!==Number(ban.originalTime)) continue;
      const parsed=parseControl(row.text);
      if(!parsed || parsed.ambiguous || parsed.action!=='forget') continue;
      const command=resolveTopic(parsed,s,ban.ownerId);
      if(command.ambiguous) continue;
      const links=topicSources(s,rows,ban.ownerId,command.topicKey,command.itemKey);
      if(ban.topicKey!==command.topicKey) ban.originalTopic ??= ban.topic;
      Object.assign(ban,{topic:command.topic,topicKey:command.topicKey,itemKey:command.itemKey,topicAliases:command.topicAliases,
        sourceIds:[...new Set([...(ban.sourceIds||[]),...links.sourceIds])],
        aliases:[...new Set([...(ban.aliases||[]),...links.aliases])]});
    }
    prepareRobotSources(s,rows);
    preparePolicy(s,rows);
    prepareVersions(s,rows,this.now());
    return s;
  }
  save(chatKey, state) { write(this.file(chatKey), state); }
  source(chatKey) {
    validChat(chatKey);
    const file = path.join(this.dataDir, 'messages', chatKey.replace(':','_') + '.json');
    let stat; try { stat = fs.statSync(file); } catch(e) { if(e.code==='ENOENT') { this.cache.delete(chatKey); return []; } throw e; }
    if (stat.size > this.maxSourceBytes) throw Error('单会话原始存档超过64MiB，本轮不扫描；需分库或数据库索引，不会删除记录');
    const key = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${this.provenance?.revision(chatKey) || ""}`;
    const cached = this.cache.get(chatKey); if (cached?.key === key) return cached.rows;
    const data = read(file, { messages: [] });
    if (data.chatKey && data.chatKey !== chatKey || !Array.isArray(data.messages)) throw Error('原始存档不属于当前会话或格式无效');
    const rows = this.provenance ? this.provenance.enrich(chatKey, data.messages) : data.messages;
    this.cache.delete(chatKey); this.cache.set(chatKey, { key, rows, byMid:new Map(rows.map(r=>[String(r.mid),r])) });
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
    return rows;
  }
  row(chatKey, messageId) {
    if (!/^-?[1-9]\d*$/.test(String(messageId)) || !Number.isSafeInteger(Number(messageId))) throw Error('需要有效来源消息ID');
    this.source(chatKey);
    const row = this.cache.get(chatKey)?.byMid.get(String(messageId));
    if (!row || row.recalled) throw Error('当前会话找不到有效原消息，不能编造来源');
    return row;
  }
  bans(chatKey, state = this.state(chatKey)) { return state.bans.filter(b => b.active); }
  blocked(row, state) {
    const text = clean(row.text);
    const original=this.cache.get(state.chatKey)?.byMid.get(String(row.mid));
    const attributed=row.self && original?.self && clean(original.text)===text?robotSources.get(state)?.get(String(row.mid))?.facts:null;
    return state.bans.some(b=>b.active&&baseBlocked(row,b)) || (policies.get(state)||[]).some(p=>
      sameOwner(row,p.ban) && (p.ids.has(String(row.mid)) || citedIds(row).some(id=>p.ids.has(id))
        || (!attributed?.length || attributed.some(f=>factForBan(f,p.ban))) && p.texts.some(t=>text.includes(t))));
  }
  visible(row, state, { history = false } = {}) {
    if (row.recalled || this.blocked(row, state)) return false;
    if (parseControl(row.text)) return false;
    if (robotSources.get(state)?.get(String(row.mid))?.ungrounded) return false;
    if(!history && oldVersions.get(state)?.has(String(row.mid))) return false;
    const sourceFacts = (factsBySource(state).get(String(row.mid))||[]).filter(f => normText(row.text).includes(normText(f.content)));
    if (!history && sourceFacts.some(f => f.supersededBy || f.expiresAt && f.expiresAt <= this.now())) return false;
    if (!history) { const expiry = inferExpiry(row); if (expiry && expiry <= this.now()) return false; }
    return true;
  }
  control(chatKey, row) {
    if (row.self || row.recalled || row.reply || row.media?.length || !/^[1-9]\d{4,15}$/.test(String(row.senderId))) throw Error('维护指令必须来自本人在当前会话单独发送的文字消息');
    if (chatKey.startsWith('private:') && String(row.senderId)!==chatKey.split(':')[1]) throw Error('来源不属于当前私聊对方');
    let command = parseControl(row.text); if (!command) throw Error('原消息没有明确的遗忘或解锁指令');
    if (command.ambiguous) return { ok: false, message: '请明确话题，例如“忘记关于工作的信息”或“允许你重新记住工作”；不会猜测“这件事”指什么' };
    const s = this.state(chatKey), ownerId = String(row.senderId);
    command=resolveTopic(command,s,ownerId);
    if(command.ambiguous) return {ok:false,message:'有多个相近的话题，请明确使用已记录的话题名称；本次未改变禁记限制'};
    const commandKey = `${row.mid}:${ownerId}`;
    const done = s.controls.find(c => c.key === commandKey); if (done) return { ok: true, message: done.message, duplicate: true };
    const matches=s.bans.filter(b => b.ownerId === ownerId && (command.itemKey&&b.itemKey?b.itemKey===command.itemKey:b.topicKey===command.topicKey));
    let ban = matches.find(b=>b.active) || matches[0];
    let message;
    if (command.action === 'forget') {
      const {sourceIds,aliases}=topicSources(s,this.source(chatKey),ownerId,command.topicKey,command.itemKey);
      if (!ban) { ban = { id: randomUUID(), ownerId, topic: command.topic, topicKey: command.topicKey,itemKey:command.itemKey,topicAliases:command.topicAliases }; s.bans.push(ban); }
      Object.assign(ban, { active: true, sourceIds: [...new Set([...(ban.sourceIds||[]), ...sourceIds])], aliases: [...new Set([...(ban.aliases||[]), ...aliases])], updatedAt: this.now(), commandMessageId: row.mid, originalTime: row.ts });
      message = `已禁止召回和重新记忆“${command.topic}”。你仍可重新谈它；本人明确说“允许你重新记住${command.topic}”才解锁。原始存档未删除。`;
    } else if (ban?.active) {
      for(const match of matches) { match.active = false; match.updatedAt = this.now(); match.unlockMessageId = row.mid; match.unlockOriginalTime = row.ts; }
      message = `已解除你本人关于“${command.topic}”的禁记标记。重新开放检索和记忆，旧资料仍按更新、过期与来源状态处理。`;
    } else message = '没有找到你本人在当前会话设置的对应禁记标记，未更改其他人的限制';
    s.controls.push({ key: commandKey, ownerId, messageId: row.mid, originalTime: row.ts, action: command.action, topic: command.topic, at: this.now(), message });
    this.save(chatKey, s); return { ok: true, message };
  }
  note(chatKey, row, { topic, content, expiresAt = null }) {
    if (row.self || row.recalled || row.reply || row.media?.length) throw Error('只记录本人直接说出的文字事实；引用、媒体内容不能冒充本人事实');
    if (!/^[1-9]\d{4,15}$/.test(String(row.senderId)) || !Number.isFinite(Number(row.ts)) || Number(row.ts)<=0) throw Error('来源缺少有效QQ号或原始时间，不能记忆');
    if (chatKey.startsWith('private:') && String(row.senderId)!==chatKey.split(':')[1]) throw Error('来源不属于当前私聊对方');
    const ownerId = String(row.senderId), s = this.state(chatKey);
    topic = String(topic || '').trim(); content = String(content || '').trim();
    if (topic.length < 2 || topic.length > 60 || !content || content.length > 600 || parseControl(content)) throw Error('需要2～60字的话题及最多600字的原文事实');
    if (!String(row.text).includes(content)) throw Error('记忆内容必须是来源消息中的原文，不能凭模型推断');
    const requestedTopic=topic, explicit=explicitSubject(row,content,topic);
    if(explicit?.ambiguous) throw Error('原消息包含多个事项，请明确选取一个事项的原文和话题');
    const candidates=s.facts.filter(f=>f.ownerId===ownerId && (explicit?f.itemKey===explicit.itemKey:factLabels(f).some(label=>topicIdentity(label)===topicIdentity(topic))));
    const keys=[...new Set(candidates.map(f=>f.itemKey))];
    if(!explicit && keys.length>1) throw Error('多个事项共用了这个话题名，请在原文中明确事项');
    const itemKey=explicit?.itemKey || keys[0] || 'topic:'+topicIdentity(topic);
    if(candidates.length) topic=candidates[0].topic;
    if (this.blocked(row, s) || s.bans.some(b => b.active && b.ownerId===ownerId && (b.itemKey?b.itemKey===itemKey:clean(topic).includes(b.topicKey)||clean(content).includes(b.topicKey)))) throw Error('这件事处于禁记状态；重提不等于解锁，需本人明确允许重新记住');
    const expiry = inferExpiry(row, expiresAt);
    const existing = s.facts.find(f=>f.ownerId===ownerId && f.sourceMessageId===row.mid && f.itemKey===itemKey && f.content===content);
    if (existing) return existing;
    const predecessors = s.facts.filter(f=>f.ownerId===ownerId && f.itemKey===itemKey && !f.supersededBy);
    const item = { id: randomUUID(), ownerId, chatKey, topic,itemKey,sourceSubject:explicit?.subject,topicAliases:[...new Set([requestedTopic,topic,explicit?.subject].filter(Boolean))], content, sourceMessageId: row.mid, sourceLocalId: row.id ?? null, originalTime: Number(row.ts), createdAt: this.now(), expiresAt: expiry, supersedes: [], supersededBy: null };
    const order=(a,b)=>Number(a.originalTime)-Number(b.originalTime)||Number(a.sourceLocalId||0)-Number(b.sourceLocalId||0);
    const latest = predecessors.sort((a,b)=>order(b,a))[0];
    if (latest && order(latest,item)>0) item.supersededBy = latest.id;
    else for (const old of predecessors) { old.supersededBy=item.id; item.supersedes.push(old.id); }
    s.facts.push(item);normalizeFacts(s,this.cache.get(chatKey)?.byMid||new Map());this.save(chatKey,s); return item;
  }
  facts(chatKey, { history = false } = {}) {
    const s = this.state(chatKey); this.source(chatKey); const rows=this.cache.get(chatKey)?.byMid||new Map();
    return s.facts.filter(f=> {
      const row=rows.get(String(f.sourceMessageId));
      return row && normText(row.text).includes(normText(f.content)) && this.visible(row,s,{history}) && (!f.supersededBy || history) && (!f.expiresAt || f.expiresAt>this.now() || history);
    }).map(f=>({...f,status:f.supersededBy?'superseded':f.expiresAt&&f.expiresAt<=this.now()?'expired':'active'}));
  }
  query(chatKey, { query = '', userId = '', dayFrom = '', dayTo = '', limit = 5, offset = 0, history = false, archive = false, excludeMessageIds = [] } = {}) {
    validChat(chatKey); const state=this.state(chatKey);
    for(const day of [dayFrom,dayTo]) if(day&&(!/^\d{4}-\d{2}-\d{2}$/.test(String(day))||!Number.isFinite(Date.parse(day+'T00:00:00Z'))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)) throw Error('日期须为有效YYYY-MM-DD');
    if(dayFrom&&dayTo&&dayFrom>dayTo) throw Error('开始日期不能晚于结束日期');
    const q=normText(query).slice(0,200), tokens=tokenize(q).filter(t=>t.length>=2);
    const facts=factsBySource(state),excluded=new Set(excludeMessageIds.map(String));
    const candidates=[];
    for(const row of this.source(chatKey)) {
      if (!this.visible(row,state,{history})) continue;
      if (excluded.has(String(row.mid))) continue;
      if(userId&&String(row.senderId)!==String(userId)) continue;
      const day=dayOf(Number(row.ts)); if(dayFrom&&day<dayFrom||dayTo&&day>dayTo) continue;
      const text=normText(row.text), f=(facts.get(String(row.mid))||[]).find(f=>normText(row.text).includes(normText(f.content)));
      const searchable=text+' '+normText(f?.topic||'');
      const matched=tokens.filter(t=>searchable.includes(t));
      if(q&&!searchable.includes(q)&&!matched.length) continue;
      let score=searchable.includes(q)&&q?20:matched.length*2;
      if(f&&!f.supersededBy&&(!f.expiresAt||f.expiresAt>this.now())) score+=3;
      candidates.push({row,f,score,expiry:f?.expiresAt||inferExpiry(row)});
    }
    candidates.sort((a,b)=>archive?Number(a.row.ts)-Number(b.row.ts):b.score-a.score||Number(b.row.ts)-Number(a.row.ts));
    const count=Math.trunc(Math.min(80,Math.max(1,Number(limit)||5))), skip=Math.trunc(Math.max(0,Number(offset)||0));
    return { ok:true, chatKey, total:candidates.length, nextOffset:skip+count, hasMore:skip+count<candidates.length, hits:candidates.slice(skip,skip+count).map(({row,f,score,expiry})=>({...sourceLine(row,f?.supersededBy?'superseded':expiry&&expiry<=this.now()?'expired':f?'active':oldVersions.get(state)?.get(String(row.mid))||'archive'),score,topic:f?.topic||null,memoryId:f?.id||null,expiresAt:expiry||null,supersedes:f?.supersedes||[],supersededBy:f?.supersededBy||null})), note:'来自当前会话原始记录。archive表示聊天原文，不一定是当前事实；过时条目仅在history=true时返回。禁记与撤回条目不返回；机器人自己的发言不能冒充本人事实来源。' };
  }
}
