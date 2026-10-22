import {normText} from './tokenize-1.1.0.js';

// A quoted topic is a literal search condition, not a bag of individual
// two-character tokens. Multiple quoted conditions must occur together.
export function literalQueryPhrases(value) {
  let text=String(value||'').slice(0,500).trim();
  while(text.startsWith('[引用')){
    let depth=0,end=-1;
    for(let i=0;i<text.length;i++){if(text[i]==='[')depth++;if(text[i]===']'&&--depth===0){end=i;break;}}
    if(end<0)break;text=text.slice(end+1).trimStart();
  }
  const matches=[...text.matchAll(/“([^”\n]{2,80})”|「([^」\n]{2,80})」|"([^"\n]{2,80})"|'([^'\n]{2,80})'/gu)];
  return [...new Set(matches.map(match=>normText(match.slice(1).find(Boolean)||'')).filter(phrase=>phrase.length>=2))].slice(0,8);
}
