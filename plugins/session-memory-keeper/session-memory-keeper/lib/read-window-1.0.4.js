// Only explicit constraints in the verified current user's own body apply.
function body(value){let text=String(value||'').trim();while(text.startsWith('[引用')){let depth=0,end=-1;for(let i=0;i<text.length;i++){if(text[i]==='[')depth++;if(text[i]===']'&&--depth===0){end=i;break;}}if(end<0)return '';text=text.slice(end+1).trimStart();}return text;}
const DATE='(\\d{4}-\\d{2}-\\d{2})';
const before=new RegExp('(?:只查|仅查|只看|仅看|查到|查看到|截止(?:到)?|截至(?:到)?|截止日期[：:]?)\\s*'+DATE+'(?:\\s*(?:及之前|以前|之前|为止))?','gu');
const dated=new RegExp(DATE+'\\s*(?:及之前|以前|之前)(?:的)?(?:聊天|记录|历史|消息)','gu');
const valid=day=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T00:00:00Z'))&&new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;
export function readWindow(entries=[]){
 const dates=[];
 for(const entry of entries.filter(e=>!e.self&&!e.recalled)){
  const text=body(entry.text);
  for(const pattern of [before,dated])for(const match of text.matchAll(pattern)){
   if(/(?:不要|不用|不必|别|不需要)(?:只查|仅查|只看|仅看)?$/u.test(text.slice(Math.max(0,match.index-12),match.index)))continue;
   // "只查某日" without a before/until operator denotes a day, not a cutoff.
   if(pattern===before&&/^(?:只查|仅查|只看|仅看)/u.test(match[0])&&!/(?:及之前|以前|之前|为止)$/u.test(match[0]))continue;
   if(!valid(match[1]))return {error:'本轮明确限定的截止日期无效，需确认有效日期后再查历史'};
   dates.push(match[1]);
  }
 }
 return dates.length?{dayTo:dates.sort()[0]}:{};
}
export function applyReadWindow(args,window){
 if(window.error)throw Error(window.error);
 if(!window.dayTo)return args;
 if(args.dayTo&&!valid(String(args.dayTo)))throw Error('查询截止日期须为有效YYYY-MM-DD');
 const dayTo=args.dayTo&&args.dayTo<window.dayTo?args.dayTo:window.dayTo;
 return {...args,dayTo};
}
export function readWindowInstructions(window){
 if(window.error)return '【本轮历史日期范围】'+window.error+'；不能把无效日期当作没有限制，不能猜测查询结果。';
 if(!window.dayTo)return '';
 return '【本轮历史日期范围】用户明确只查'+window.dayTo+'及之前，当前会话历史检索和自动召回已限定该范围。范围外的已读信息可以理解当前对话，但不是范围内的原始证据；回答原话、发言人和日期应依据范围内带消息ID及原始时间的记录。不要把今天对旧事的复述当作旧日原话来源；依据不足时继续查范围内原文。';
}
