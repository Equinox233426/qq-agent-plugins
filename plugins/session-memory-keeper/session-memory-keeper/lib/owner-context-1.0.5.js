// 群内明确问“我”的记忆查询按本轮原消息归属；比较、他人和多发言者不猜单一主人。
const clean=s=>String(s||'').normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu,'');
const refs=r=>[r.replyTo,r.replyToMessageId,r.sourceMessageId,typeof r.reply==='object'?r.reply?.mid:r.reply].filter(x=>x!=null).map(String);
const time=ts=>{const d=new Date(ts),pad=n=>String(n).padStart(2,'0');return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;};
const EMPTY='[本轮本人记忆查询未使用其他成员的同名事项]';
export function ownerContext(memory,chatKey,entries=[]) {
  const rows=memory.source(chatKey),byId=memory.sourceIndex(chatKey);
  const verified=entries.filter(e=>{const r=byId.get(String(e.mid));return r&&!r.self&&!r.recalled&&!r.reply&&!r.media?.length&&String(r.senderId)===String(e.senderId)&&r.text===e.text&&Number(r.ts)===Number(e.ts);});
  const owners=[...new Set(verified.map(e=>String(e.senderId)))];
  const identities=verified.map(e=>({messageId:e.mid,senderId:String(e.senderId),originalTime:Number(e.ts)}));
  // A sole protocol-confirmed @ of the bot addresses the assistant; it does
  // not turn "my" into a comparison with another group member. Read mention
  // metadata from the verified original row, never the trigger arguments.
  const ownBody=entry=>{
    const row=byId.get(String(entry.mid));
    const names=Array.isArray(row.atNames)?row.atNames:[];
    if(row.atMe!==true||names.length!==1||typeof names[0]!=='string'||!names[0])return row.text;
    return row.text.split(names[0]).join(' ');
  };
  const query=verified.map(ownBody).join(' '),state=memory.state(chatKey);
  const mine=/(?:我的|我本人的|我最后(?:一次)?(?:明确)?更新|我(?:之前|现在|以前|最近|刚才)(?:的|记录|更新|喜欢|改))/.test(query);
  const mixed=/(?:我们|我和|大家|各自|分别|其他人|别人|他人|群友|另一位|另一个人|对比|比较|两人|两位|两个人|他(?:的|们)|她(?:的|们)|QQ[:：]?\s*\d|@|[“”"「」])/.test(query);
  const labels=f=>[f.sourceSubject,f.topic,...(f.topicAliases||[])].filter(Boolean);
  const facts=state.facts.filter(f=>{const r=byId.get(String(f.sourceMessageId));return r&&!r.self&&!r.recalled&&!r.reply&&!r.media?.length&&String(r.senderId)===f.ownerId&&Number(r.ts)===Number(f.originalTime)&&String(r.text).includes(f.content);});
  const matching=facts.filter(f=>labels(f).some(label=>clean(label).length>=2&&clean(query).includes(clean(label))));
  const keys=new Set(matching.map(f=>f.itemKey).filter(Boolean));
  const personal=chatKey.startsWith('group:')&&owners.length===1&&mine&&!mixed&&keys.size>0;
  if(!personal)return {personal:false,identities,owners,allowSource:()=>true};
  const ownerId=owners[0],foreign=facts.filter(f=>f.ownerId!==ownerId&&keys.has(f.itemKey));
  const own=facts.filter(f=>f.ownerId===ownerId&&keys.has(f.itemKey));
  const foreignIds=new Set(foreign.map(f=>String(f.sourceMessageId))),ownIds=new Set(own.map(f=>String(f.sourceMessageId)));
  const foreignFacts=new Set(foreign.map(f=>f.id));
  const subjects=[...new Set(matching.flatMap(labels).map(clean).filter(Boolean))];
  const relevant=r=>subjects.some(s=>clean(r.text).includes(s));
  const values=[...new Set(foreign.map(f=>clean(f.sourceValue)).filter(s=>s.length>=2))];
  const ownValues=own.map(f=>clean(f.sourceValue)).filter(Boolean);
  const hidden=new Set();let previous=null;
  for(const row of rows){
    const id=String(row.mid),cited=refs(row);
    if(row.self)cited.push(...(String(row.text).match(/-?\d+/g)||[]));
    const citedOwn=cited.some(x=>ownIds.has(x)),citedForeign=cited.some(x=>foreignIds.has(x)||hidden.has(x));
    const direct=!row.self&&String(row.senderId)!==ownerId&&(foreignIds.has(id)||relevant(row));
    const follows=row.self&&previous?.foreign&&Number(row.ts)>=Number(previous.ts)&&Number(row.ts)-Number(previous.ts)<=30*60000;
    const valueClaim=row.self&&/(?:你|记|偏好|原消息|来源|那条|之前|最新|状态)/.test(row.text)&&values.some(v=>clean(row.text).includes(v)&&!ownValues.some(o=>o.includes(v)&&clean(row.text).includes(o)));
    if(direct||row.self&&!citedOwn&&(citedForeign||follows||valueClaim))hidden.add(id);
    if(!row.self)previous={foreign:direct,ts:row.ts};
  }
  const hiddenRows=rows.filter(r=>hidden.has(String(r.mid)));
  function filter(value,inheritedOwner='') {
    if(Array.isArray(value))return value.map(v=>filter(v,inheritedOwner)).filter(v=>v!==undefined);
    if(!value||typeof value!=='object')return value;
    const owner=String(value.senderId??value.ownerId??value.userId??inheritedOwner);
    const id=value.messageId??value.mid??value.sourceMessageId;
    if(id!=null&&hidden.has(String(id))||foreignFacts.has(value.memoryId)||foreignFacts.has(value.id))return undefined;
    const text=value.text??value.content;
    if(owner&&owner!==ownerId&&typeof text==='string'&&subjects.some(s=>clean(text).includes(s)))return undefined;
    const out={};for(const [k,v]of Object.entries(value)){const item=filter(v,owner);if(item!==undefined)out[k]=item;}
    if(Array.isArray(out.hits))out.returned=out.hits.length;
    if(Array.isArray(out.messages))out.count=out.messages.length;
    return out;
  }
  function scrubLine(line) {
    try{const parsed=JSON.parse(line);if(parsed&&typeof parsed==='object')return JSON.stringify(filter(parsed)??{note:EMPTY});}catch{}
    const m=/^\[(\d{2}-\d{2} \d{2}:\d{2})\]\s*(?:#(-?\d+)\s+)?(.*?)：([^\n]*)$/u.exec(line.trim());
    if(m){const [,stamp,id,speaker,text]=m,who=/QQ[:：](\d+)/.exec(speaker)?.[1];
      const candidates=id?memory.sourceRows(chatKey,id):rows;
      const matched=candidates.filter(r=>(r.text===text||((r.reply?.text||r.reply?.sender)?`[引用 ${[r.reply?.sender,r.reply?.text].filter(Boolean).join('：')}]${r.text}`:'')===text)&&time(r.ts)===stamp&&(!id||String(r.mid)===id)&&(speaker==='我'?r.self:!r.self&&String(r.senderId)===who));
      if(matched.length&&matched.every(r=>hidden.has(String(r.mid))))return EMPTY;
      return line;
    }
    if([...line.matchAll(/#(-?\d+)/g)].some(m=>hidden.has(m[1])))return EMPTY;
    // 跨轮草稿可能引用提问者的ID，却含上一轮已经发出的他人事项错归属；不把草稿当用户事实。
    if(hiddenRows.some(r=>r.self&&r.text.length>=4&&line.includes(r.text)))return EMPTY;
    if(hiddenRows.some(r=>r.text===line.trim())&&!rows.some(r=>r.text===line.trim()&&!hidden.has(String(r.mid))))return EMPTY;
    return line;
  }
  function text(content,{structured=false}={}) {
    if(structured){try{return JSON.stringify(filter(JSON.parse(content))??{note:EMPTY});}catch{return String(content).split('\n').map(scrubLine).join('\n');}}
    return String(content).replace(/(^|\n\n)(【(?:记忆|已读信息|新已读信息|语义卡|来源短卡|当前会话检索依据|解锁后本人记忆核验|跨轮[^】]*|生活事件|你正在进行中的生活事件|新加入成员)[^】]*】)([\s\S]*?)(?=\n\n【|$)/g,(_all,prefix,header,data)=>prefix+header+data.split('\n').map(scrubLine).join('\n'));
  }
  return {personal:true,ownerId,identities,owners,itemKeys:[...keys],hiddenIds:[...hidden],filter,text,allowSource:ref=>!hidden.has(String(ref.messageId))};
}
export function scopeOwnerBody(body,context,readTools) {
  if(!context?.personal||!Array.isArray(body?.messages))return body;
  const names=new Map();for(const m of body.messages)for(const call of m.tool_calls||[])names.set(call.id,call.function?.name);
  return {...body,messages:body.messages.map(m=>{
    const structured=m.role==='tool'&&readTools.has(names.get(m.tool_call_id));
    if(m.role!=='system'&&m.role!=='user'&&!structured)return m;
    if(typeof m.content==='string')return {...m,content:context.text(m.content,{structured})};
    if(Array.isArray(m.content))return {...m,content:m.content.map(p=>p.type==='text'?{...p,text:context.text(p.text,{structured})}:p)};
    return m;
  })};
}
export function ownerInstructions(context) {
  if(!context?.identities?.length)return '';
  return '【本轮记忆归属】\n本轮原消息身份：'+JSON.stringify(context.identities)+'\n'+(context.personal
    ? `当前本人记忆问题的“我、我的、你、你的”只指QQ ${context.ownerId}。同名事项按ownerId和itemKey共同区分；其他群成员的记录不是此人的旧版本，不得说成“你之前的偏好”。只按此人的来源ID、原始时间和supersedes关系比较版本。已替代记录只是不能当作现状，不代表删除；没有历史检索结果时不要声称无法查历史。`
    : '群成员相同话题的记录仍分属各自senderId/ownerId，不能以群内消息先后把另一成员说成当前提问者的过去。多位发言者的问题按各条原消息身份分别回答，无法确定代词归属时先澄清。');
}
