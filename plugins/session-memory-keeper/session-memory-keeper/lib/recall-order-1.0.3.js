// Quoted text is historical data, not a new request to change retrieval order.
function bodyText(value) {
  let text=String(value||'');
  while(text.startsWith('[引用')){
    let depth=0,end=-1;
    for(let i=0;i<text.length;i++){if(text[i]==='[')depth++;if(text[i]===']'&&--depth===0){end=i;break;}}
    if(end<0)break;text=text.slice(end+1).trimStart();
  }
  return text;
}
export function recallOrder(entries=[]) {
  const text=entries.filter(entry=>!entry.self&&!entry.recalled).map(entry=>bodyText(entry.text)).join(' ');
  const retrieval=/(?:查|搜|找|翻|检索|回(?:答|复|了|的|我)|说(?:过|了|的|什么)|聊|提(?:到|过|了)|记得|哪(?:次|句|天)|时候|是什么|是谁)/u.test(text);
  const earliest=retrieval && [...text.matchAll(/最初|最早|最开始|最久远|最旧|最先|第一次|一开始/gu)].some(match=>
    !/(?:不要|别|不用|不必|不需要|不是)(?:从|查|找|问|再|去|按|开始)*$/u.test(text.slice(Math.max(0,match.index-14),match.index)));
  const history=earliest || retrieval && /(?:当时|那时|那次|过去|以前|之前|上次|上周|上个月|去年|前天|昨天|\d{4}-\d{2}-\d{2})/u.test(text);
  return {order:earliest?'earliest':'recent',history};
}
export function recallOrderInstructions(plan) {
  return '【历史检索顺序】相关记录默认按原始发言时间从近到远检索；同一事项仍优先当前有效事实。只有本人当前问题明确问最初、最早或第一次，才从最早那次开始；“当时”只表示历史，不一定是第一次。明确引用哪条消息就回答那条，不用最近记录替换引用对象。当前顺序：'+(plan.order==='earliest'?'最早优先；历史状态已标注':'最近优先')+'。';
}
