import { normText } from './tokenize-1.1.0.js';
const norm = s => normText(s).replace(/[\p{P}\p{Z}\s]/gu,'');
const shortTime = ts => {
  const d=new Date(ts),pad=n=>String(n).padStart(2,'0');
  return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function hiddenShortLine(line,hidden) {
  // 宿主纯文本历史不带消息ID。短回复按整条记录识别，不能全局替换“绿茶”等短词。
  const short=hidden.filter(row=>String(row.text).length>0&&String(row.text).length<4);
  const entry=/^\[(\d{2}-\d{2} \d{2}:\d{2})\]\s*(?:#(-?\d+)\s+)?([^\n]*?)：([^\n]*)$/u.exec(line.trim());
  if(!entry)return short.some(row=>String(row.text).trim()===line.trim());
  const [,time,mid,speaker,text]=entry,owner=/QQ[:：](\d+)/.exec(speaker)?.[1];
  return short.some(row=>text===String(row.text)&&shortTime(row.ts)===time
    && (!mid||String(row.mid)===mid)
    && (speaker==='我'?row.self:owner&&!row.self&&String(row.senderId)===owner));
}
export const READ_TOOLS = new Set(['get_recent_messages','get_message_detail','memory_query','life-memory__life_recall','memory-keeper__memory_search','memory-keeper__memory_archive','session-memory-keeper__memory_search','session-memory-keeper__memory_archive']);
export function filterPayload(value, memory, chatKey, state = memory.state(chatKey), inheritedOwner = '') {
  if (Array.isArray(value)) return value.map(v=>filterPayload(v,memory,chatKey,state,inheritedOwner)).filter(v=>v!==undefined);
  if (!value || typeof value!=='object') return value;
  if (typeof value.text==='string') {
    const row={text:value.text,mid:value.messageId??value.mid,senderId:value.senderId??value.ownerId??inheritedOwner,self:value.self??value.sender==='我'};
    if(memory.blocked(row,state) || !row.senderId && memory.blocked({...row,self:true},state)) return undefined;
    const originals=memory.sourceRows(chatKey,row.mid);
    if(originals.some(r=>!memory.visible(r,state))) return undefined;
  }
  const owner=String(value.ownerId??value.userId??value.senderId??inheritedOwner);
  if(typeof value.content==='string') {
    if(memory.blocked({text:value.content,senderId:owner,self:value.self===true||!owner},state)) return undefined;
    if(state.facts.some(f=>(f.supersededBy||f.expiresAt&&f.expiresAt<=memory.now())&&(!owner||owner===f.ownerId)&&norm(f.content).length>=4&&norm(value.content).includes(norm(f.content)))) return undefined;
  }
  const out={}; for(const [key,v] of Object.entries(value)) { const filtered=filterPayload(v,memory,chatKey,state,owner); if(filtered!==undefined) out[key]=filtered; }
  if(Array.isArray(out.messages)) out.count=out.messages.length;
  if(Array.isArray(out.hits)) out.returned=out.hits.length;
  return out;
}
export function scrubData(text,memory,chatKey,{structured=false}={}) {
  const state=memory.state(chatKey), bans=state.bans.filter(b=>b.active);
  if(structured) {
    try { return JSON.stringify(filterPayload(JSON.parse(text),memory,chatKey,state)??{note:'旧信息已受禁记或失效规则限制'}); } catch { /* 非JSON继续按数据片段处理 */ }
  }
  const hidden=memory.source(chatKey).filter(r=>!memory.visible(r,state));
  const rows=memory.source(chatKey);
  const scrub = block => {
    return block.split('\n').map(line=> {
      // 宿主历史行优先按原消息身份判断，不能先全局替换同文回复。
      const entry=/^\[(\d{2}-\d{2} \d{2}:\d{2})\]\s*(?:#(-?\d+)\s+)?([^\n]*?)：([^\n]*)$/u.exec(line.trim());
      if(entry) {
        const [,time,mid,speaker,text]=entry,owner=/QQ[:：](\d+)/.exec(speaker)?.[1];
        const candidates=mid?memory.sourceRows(chatKey,mid):rows;
        const matched=candidates.filter(row=>(String(row.text)===text||((row.reply?.text||row.reply?.sender)?`[引用 ${[row.reply?.sender,row.reply?.text].filter(Boolean).join('：')}]${row.text}`:'')===text)&&shortTime(row.ts)===time
          && (!mid||String(row.mid)===mid)
          && (speaker==='我'?row.self:owner&&!row.self&&String(row.senderId)===owner));
        if(matched.length) return matched.every(row=>memory.visible(row,state))?line:'[旧信息已停用，不作为当前事实]';
      }
      // 无ID/时间/发送者的裸文本不能替同文隐藏记录确定归属，保守停用。
      for(const row of hidden) if(String(row.text).length>=4) line=line.replaceAll(String(row.text),'[旧信息已停用，不作为当前事实]');
      if(hiddenShortLine(line,hidden))return '[旧信息已停用，不作为当前事实]';
      const owner=/QQ[:：](\d+)/.exec(line)?.[1];
      const stale=state.facts.some(f=>(f.supersededBy||f.expiresAt&&f.expiresAt<=memory.now())&&(!owner||owner===f.ownerId)&&norm(f.content).length>=4&&norm(line).includes(norm(f.content)));
      return stale||memory.blocked({text:line,senderId:owner,self:!owner},state) ? '[旧记忆受维护规则限制]' : line;
    }).join('\n');
  };
  if(structured) return scrub(String(text));
  // 只加工数据段，保留角色设定、核心规则和本轮未读消息。
  return String(text).replace(/(?:^|\n\n)【跨会话[^】]*】[^\n]*(?:\n(?!\n【)[^\n]*)*/g,'\n\n[跨会话记忆注入已停用]')
    .replace(/((?:^|\n\n)【(?:记忆|新加入成员|已读信息|新已读信息|语义卡|来源短卡|当前会话检索依据|解锁后本人记忆核验|跨轮工作记忆|生活事件|你正在进行中的生活事件)[^】]*】[^\n]*\n)([\s\S]*?)(?=\n\n【|$)/g,(_all,header,data)=>header+scrub(data));
}
// 宿主会吞掉转换器异常；这里主动移除旧数据，避免核验失败后照样发出。
export function guardFailure(body) {
  const calls=new Map();
  for(const m of body.messages||[]) for(const c of m.tool_calls||[]) calls.set(c.id,c.function?.name);
  const strip=text=>String(text).replace(/(?:^|\n\n)【(?:记忆|新加入成员|已读信息|新已读信息|语义卡|跨轮|来源短卡|当前会话检索依据|解锁后本人记忆核验|未完待办|生活事件|你正在进行中的生活事件|跨会话)[^】]*】[\s\S]*?(?=\n\n【|$)/g,'\n\n[记忆核验异常，本轮旧信息已停用]');
  return {...body,messages:(body.messages||[]).map(m=> {
    if(m.role==='tool'&&READ_TOOLS.has(calls.get(m.tool_call_id))) return {...m,content:'记忆核验异常，本轮禁止使用旧检索结果；只能依据当前新消息回答。'};
    if(m.role!=='user'&&m.role!=='system') return m;
    if(typeof m.content==='string') return {...m,content:strip(m.content)};
    if(Array.isArray(m.content)) return {...m,content:m.content.map(p=>p.type==='text'?{...p,text:strip(p.text)}:p)};
    return m;
  })};
}
export function guardBody(body, memory, chatKey) {
  if(!chatKey||!Array.isArray(body?.messages)) return body;
  const tools=new Map(); for(const m of body.messages) for(const call of m.tool_calls||[]) tools.set(call.id,call.function?.name);
  const messages=body.messages.map(m=> {
    const structured=m.role==='tool'&&READ_TOOLS.has(tools.get(m.tool_call_id));
    if(m.role!=='user'&&m.role!=='system'&&!structured) return m;
    if(typeof m.content==='string') return {...m,content:scrubData(m.content,memory,chatKey,{structured})};
    if(Array.isArray(m.content)) return {...m,content:m.content.map(p=>p.type==='text'?{...p,text:scrubData(p.text,memory,chatKey)}:p)};
    return m;
  });
  return {...body,messages};
}
