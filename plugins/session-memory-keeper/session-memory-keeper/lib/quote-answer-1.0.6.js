let quoteSequence=0;
function body(text){let s=String(text||'').trim();while(s.startsWith('[引用')){let depth=0,end=-1;for(let i=0;i<s.length;i++){if(s[i]==='[')depth++;if(s[i]===']'&&--depth===0){end=i;break;}}if(end<0)return '';s=s.slice(end+1).trimStart();}return s;}
function expectedQuote(turn,memory,chatKey){
 if(turn?.chatKey!==chatKey||turn.entries?.length!==1)return null;
 const entry=turn.entries[0];let row,source;
 try{row=memory.row(chatKey,entry.mid);}catch{return null;}
 if(row.self||row.recalled||row.text!==entry.text||row.ts!==entry.ts||String(row.senderId)!==String(entry.senderId)||row.media?.length)return null;
 if(!/(?:^|[。？！?!，,；;\n])\s*(?:请)?只(?:复述|回复|输出)(?:被引用的)?(?:原句|原文)[。！!\s]*$/u.test(body(row.text)))return null;
 const reply=row.reply;if(!reply||reply.resolved!==true||reply.mid==null)return null;
 try{source=memory.row(chatKey,reply.mid);}catch{return null;}
 if(source.recalled||source.media?.length||!String(source.text||'').trim()||reply.text!==source.text)return null;
 if(typeof reply.self!=='boolean'||reply.self!==!!source.self)return null;
 if(!source.self&&String(reply.senderId)!==String(source.senderId))return null;
 if(!Number.isFinite(reply.originalTime)||Math.abs(reply.originalTime-source.ts)>5000)return null;
 if(!memory.visible(source,memory.state(chatKey)))return null;
 return {messageId:String(source.mid),originalTime:source.ts,text:source.text,triggerId:String(row.mid)};
}
const reason=expected=>'本人当前要求只复述引用原句，已核验来源#'+expected.messageId+'。请仅发送以下原文，不附加说明、日期或消息编号：'+JSON.stringify(expected.text);
export function quoteAnswerGuard(tool,args,turn,memory,chatKey){
 const expected=expectedQuote(turn,memory,chatKey);if(!expected)return;
 if(tool==='finish'){
  if(turn.quoteBlocked&&!turn.quoteDelivered)return {block:true,reason:reason(expected)+'；此前发送被拦截，不能直接声称已经完成。'};
  return;
 }
 if(tool!=='send_message')return;
 const lines=typeof args.messages==='string'?[args.messages]:args.messages;
 if(!Array.isArray(lines)||lines.length!==1||typeof lines[0]!=='string'||lines[0].trim()!==expected.text.trim()){
  turn.quoteBlocked=true;turn.quoteDelivered=false;return {block:true,reason:reason(expected)};
 }
 turn.quoteExpected=expected;
}
export function recordQuoteDelivery(ctx,turn,memory,chatKey){
 if(ctx.toolName!=='send_message'||ctx.result?.isError)return;
 const expected=expectedQuote(turn,memory,chatKey);if(!expected)return;
 let result;try{result=JSON.parse(ctx.result.content);}catch{return;}
 if(!Array.isArray(result.messageIds)||Number(result.sent)<=0)return;
 for(const id of result.messageIds){
  const row=turn.store?.findByMid?.(chatKey,id);
  if(row?.self&&!row.recalled&&row.text.trim()===expected.text.trim()){turn.quoteDelivered=true;turn.quoteBlocked=false;return;}
 }
}
// Original 0.4.0 treats even a blocked finish call as the end of the loop.
// Transform the response before tool execution, using the normal send queue.
export function repairQuoteResponse(response,turn,memory,chatKey){
 const expected=expectedQuote(turn,memory,chatKey);if(!expected||turn.quoteDelivered||!response?.message)return;
 const message=response.message,calls=Array.isArray(message.tool_calls)?message.tool_calls:[];
 const hasFinish=calls.some(call=>call.function?.name==='finish');
 if(hasFinish){
  const remaining=calls.filter(call=>call.function?.name!=='finish');
  if(remaining.length){message.tool_calls=remaining;return;}
 }
 if(calls.length&&!hasFinish)return;
 message.content=null;
 message.tool_calls=[{id:'quote_exact_'+Date.now().toString(36)+'_'+ ++quoteSequence,type:'function',function:{name:'send_message',arguments:JSON.stringify({messages:expected.text,replyToMessageId:expected.triggerId})}}];
}
