let sequence=0;
const own=(a,b)=>String(a)===String(b);
const declinesAcknowledgment=text=>/(?:不要|不用|无需|不必|别|请勿|不需要)(?:你|再|给我|特意|专门|单独|额外|发)?\s*(?:再|特意|专门|单独|额外)?\s*(?:回复|回话|回应|确认|回执|告诉我|发消息)|(?:悄悄|默默|只记录|只记住|仅记录|仅记住)/u.test(String(text||''));
export function requestsAcknowledgment(text) {
  const value=String(text||'');
  if(/[“”「」"]/u.test(value))return false;
  if(declinesAcknowledgment(value))return false;
  return /(?:^|[，,。.!！?？;；\n])\s*(?:请你|麻烦你|你帮我|帮我|请)?\s*(?:记住|记下|记录(?:下来)?|保存(?:到记忆)?|更新(?:一下)?(?:记忆|记录))/u.test(value);
}
// 只接受工具实际写入后的事实；不根据模型回执文字猜测是否成功。
export function rememberAcknowledgment(turn,source,fact,session) {
  if(!turn||turn.chatKey!==fact.chatKey||!requestsAcknowledgment(source.text))return;
  if(!turn.entries?.length||turn.entries.some(e=>!own(e.senderId,source.senderId)))return;
  if(turn.entries.some(e=>declinesAcknowledgment(e.text)))return;
  if(source.self||source.recalled||source.reply||source.media?.length)return;
  if(!own(fact.ownerId,source.senderId)||!own(fact.sourceMessageId,source.mid)||Number(fact.originalTime)!==Number(source.ts))return;
  turn.acknowledgments??=new Map();
  if(turn.acknowledgments.has(fact.id))return;
  turn.acknowledgments.set(fact.id,{factId:fact.id,messageId:source.mid,ownerId:String(source.senderId),originalTime:Number(source.ts),sourceText:source.text,sentAtWrite:session?.sent?.length||0,delivered:false});
}
function checkedFact(receipt,memory,chatKey,entries,facts) {
  const entry=entries?.find(e=>own(e.mid,receipt.messageId)&&own(e.senderId,receipt.ownerId)&&Number(e.ts)===receipt.originalTime&&e.text===receipt.sourceText);
  if(!entry)return null;
  let row;try{row=memory.row(chatKey,receipt.messageId);}catch{return null;}
  if(row.self||row.recalled||row.reply||row.media?.length||!own(row.senderId,receipt.ownerId)||Number(row.ts)!==receipt.originalTime||row.text!==receipt.sourceText)return null;
  return facts.find(f=>f.id===receipt.factId&&f.chatKey===chatKey&&own(f.ownerId,receipt.ownerId)&&own(f.sourceMessageId,receipt.messageId)&&Number(f.originalTime)===receipt.originalTime&&String(row.text).includes(f.content))||null;
}
export function pendingAcknowledgments(turn,memory,chatKey) {
  const receipts=[...(turn?.acknowledgments?.values()||[])].filter(r=>!r.delivered);
  if(!receipts.length)return [];
  // history仍执行禁记与撤回检查；已过期/已替代的成功写入只能确认其历史状态。
  const facts=memory.facts(chatKey,{history:true}),groups=new Map();
  for(const receipt of receipts){const fact=checkedFact(receipt,memory,chatKey,turn.entries,facts);if(!fact)continue;const id=String(receipt.messageId);if(!groups.has(id))groups.set(id,{messageId:receipt.messageId,ownerId:receipt.ownerId,receipts:[],facts:[]});groups.get(id).receipts.push(receipt);groups.get(id).facts.push(fact);}
  return [...groups.values()].slice(-8);
}
const call=(name,args)=>({id:'memory_ack_'+Date.now().toString(36)+'_'+ ++sequence,type:'function',function:{name,arguments:JSON.stringify(args)}});
export function repairAcknowledgment(response,turn,memory,chatKey) {
  if(!response?.message||turn?.ackFallbackIssued)return false;
  const existing=Array.isArray(response.message.tool_calls)?response.message.tool_calls:[];
  // 有其他工作或正常发送调用时交给模型；仅补无工具正文或直接finish的收尾。
  if(existing.length&&!existing.every(c=>c?.function?.name==='finish'))return false;
  const groups=pendingAcknowledgments(turn,memory,chatKey);if(!groups.length)return false;
  const sends=groups.map(group=>{
    let text=group.facts.length===1?'已保存这条记忆。':`已保存这条消息中的 ${group.facts.length} 条记忆。`;
    if(group.facts.every(f=>f.status==='expired'))text='已保存为历史记录，内容已过期。';
    else if(group.facts.every(f=>f.status==='superseded'))text='已保存为历史记录，已有更新版本。';
    return call('send_message',{messages:text,replyToMessageId:group.messageId});
  });
  const finishes=existing.length?existing:[call('finish',{summary:'本人记忆已写入，已安排保存确认。'})];
  const calls=[...sends,...finishes];
  turn.ackFallbackIssued=true;turn.ackFallback={calls,sendIds:new Set(sends.map(c=>c.id)),finishIds:new Set(finishes.map(c=>c.id)),targets:groups};
  response.message.content=null;response.message.tool_calls=calls;
  return true;
}
export function acknowledgmentSendGuard(args,turn,memory,chatKey) {
  const targets=turn?.ackFallback?.targets;if(!targets?.length)return null;
  const group=targets.find(g=>own(g.messageId,args.replyToMessageId));if(!group)return null;
  const callArgs=turn.ackFallback.calls.filter(c=>c.function.name==='send_message').map(c=>JSON.parse(c.function.arguments));
  if(!callArgs.some(a=>own(a.replyToMessageId,args.replyToMessageId)&&a.messages===args.messages))return null;
  const pending=pendingAcknowledgments(turn,memory,chatKey).find(g=>own(g.messageId,group.messageId));
  if(!pending||pending.receipts.length!==group.receipts.length||group.facts.some(f=>!pending.facts.some(current=>current.id===f.id&&current.status===f.status)))return {block:true,reason:'保存确认的本人原来源、已写入事实或历史状态已失效，本次未发送；请重新核验，不能声称保存成功。'};
  return null;
}
function deferFinishes(turn,session) {
  const fallback=turn?.ackFallback;if(!fallback)return;
  // 核心正在顺序执行这同一个数组；失败时移除尚未执行的finish，继续普通工具循环。
  for(let i=fallback.calls.length-1;i>=0;i--)if(fallback.finishIds.has(fallback.calls[i].id))fallback.calls.splice(i,1);
  const assistant=[...(session?.messages||[])].reverse().find(m=>m.role==='assistant'&&m.tool_calls?.some(c=>fallback.sendIds.has(c.id)));
  if(assistant)assistant.tool_calls=assistant.tool_calls.filter(c=>!fallback.finishIds.has(c.id));
}
export function recordAcknowledgmentDelivery(ctx,turn,memory,chatKey) {
  if(ctx.toolName!=='send_message'||!turn?.acknowledgments?.size)return;
  let args,result;try{args=JSON.parse(ctx.argsRaw);result=JSON.parse(ctx.result?.content);}catch{deferFinishes(turn,ctx.session);return;}
  const delivered=!ctx.result?.isError&&Number(result.sent)>0;
  if(!delivered){deferFinishes(turn,ctx.session);return;}
  let targetOwner='';
  if(args.atUserId!=null)targetOwner=String(args.atUserId);
  if(args.replyToMessageId!=null){try{const row=memory.row(chatKey,args.replyToMessageId);if(row.self||targetOwner&&!own(targetOwner,row.senderId))return;targetOwner=String(row.senderId);}catch{return;}}
  for(const receipt of turn.acknowledgments.values())if(!receipt.delivered&&(!targetOwner||targetOwner===receipt.ownerId)&&(ctx.session?.sent?.length||0)>receipt.sentAtWrite)receipt.delivered=true;
}
