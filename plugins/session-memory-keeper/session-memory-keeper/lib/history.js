/** Recover IDs only from exact original archive rows; ambiguous legacy rows are not guessed. */
const stamp = ts => {
  const d = new Date(ts), pad = n => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const displayText = row => ((row.reply?.text || row.reply?.sender) ? `[引用 ${[row.reply.sender, row.reply.text].filter(Boolean).join('：')}]` : '') + row.text;
const indexes = new WeakMap();
export function identifyHistory(text, rows, { acceptRow = () => true } = {}) {
  let index = indexes.get(rows);
  if (!index) {
  index = new Map();
  for (const row of rows) {
    if (row.mid == null || row.recalled) continue;
    const owner = row.self ? 'self' : String(row.senderId);
    for (const value of new Set([String(row.text), displayText(row)])) {
      const key = JSON.stringify([stamp(row.ts), owner, value]);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(row);
    }
  }
  indexes.set(rows, index);
  }
  return String(text).replace(/((?:^|\n\n)【(?:已读信息|新已读信息)[^】]*】[^\n]*\n)([\s\S]*?)(?=\n\n【|$)/g, (_all, header, data) => {
    const groups = data.split(/\n(?=\[\d{2}-\d{2} \d{2}:\d{2}\])/);
    return header + groups.map(line => {
      const match = /^\[(\d{2}-\d{2} \d{2}:\d{2})\]\s*(?:#(-?\d+)\s+)?([^\n]*?)：([\s\S]*)$/u.exec(line.trimEnd());
      if (!match) return line.trim() === '' ? line : '[旧历史格式无法核验，本轮停用]';
      const owner = match[3] === '我' ? 'self' : /QQ[:：](\d+)/.exec(match[3])?.[1];
      if (!owner) return '[旧历史缺少可核验身份，本轮停用]';
      let matches = index.get(JSON.stringify([match[1], owner, match[4]])) || [];
      if (match[2]) matches = matches.filter(row => String(row.mid) === match[2]);
      if (matches.length !== 1) return '[旧历史来源缺失或同分钟同文歧义，本轮停用]';
      if (!acceptRow(matches[0])) return '[旧历史受维护或本人归属限制，本轮停用]';
      if (match[2]) return line;
      return line.replace(/^(\[[^\]]+\]\s*)/, '$1#' + matches[0].mid + ' ');
    }).join('\n');
  });
}
export function identifyBody(body, rows, options) {
  if (!Array.isArray(body?.messages)) return body;
  return { ...body, messages: body.messages.map(message => {
    if (!['user', 'system'].includes(message.role)) return message;
    if (typeof message.content === 'string') return { ...message, content: identifyHistory(message.content, rows, options) };
    if (Array.isArray(message.content)) return { ...message, content: message.content.map(part => part.type === 'text' ? { ...part, text: identifyHistory(part.text, rows, options) } : part) };
    return message;
  }) };
}
