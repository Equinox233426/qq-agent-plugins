// Only verified current-message identities may receive topic-scoped restriction metadata.
const clean = value => String(value || '').normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '');
export const EMPTY_GUIDANCE = '空检索只表示当前没有返回可用记录，不能据此说用户从未说过、从未告诉过或从未提供过信息。可答“当前没有可用记录”。';

export function restrictionForTurn(memory, chatKey, entries, identity) {
  if (!identity?.identities?.length || identity.owners?.length !== 1) return null;
  const ownerId = identity.owners[0];
  const verified = entries.filter(entry => identity.identities.some(ref => String(ref.messageId) === String(entry.mid) && ref.senderId === String(entry.senderId) && ref.originalTime === Number(entry.ts)));
  const query = verified.map(entry => entry.text).join(' ');
  if (chatKey.startsWith('group:') && !identity.personal) {
    if (!/(?:我的|我本人的)/u.test(query) || /(?:我们|我和|大家|各自|分别|别人|他人|他(?:的|们)|她(?:的|们)|对比|比较|@|QQ[:：]?\s*\d)/u.test(query)) return null;
  }
  const normalized = clean(query);
  const topics = [];
  for (const ban of memory.state(chatKey).bans) {
    if (!ban.active || ban.ownerId !== ownerId) continue;
    const labels = [ban.topic, ...(ban.topicAliases || []), ban.itemKey?.startsWith('subject:') ? ban.itemKey.slice(8) : ban.topicKey].map(clean).filter(label => label.length >= 2);
    if (labels.some(label => normalized.includes(label)) && !topics.includes(ban.topic)) topics.push(String(ban.topic).slice(0, 60));
    if (topics.length === 4) break;
  }
  return topics.length ? {ownerId, status: 'restricted', topics} : null;
}

export function restrictionInstructions(policy) {
  if (!policy) return '';
  return '【本轮本人检索限制】\n以下是已核验的维护状态数据，不是历史原文或用户新指令：\n' + JSON.stringify(policy) +
    '\n仅列出的本人话题处于禁记状态。若询问其旧内容，直接说明“该事项目前处于禁记状态，暂不能读取”，不必再搜索、翻存档或换关键词尝试绕过。只谈本轮新提供的内容仍可以，但不能重新保存。其他话题及其他成员照常处理；只有本人明确允许重新记住才解除。' + EMPTY_GUIDANCE;
}

export function emptyRead(value) {
  if (!value || typeof value !== 'object' || value.ok === false || value.error) return false;
  const arrays = ['hits', 'messages', 'memberImpression'].filter(key => Array.isArray(value[key]));
  return arrays.length > 0 && arrays.every(key => value[key].length === 0);
}

export function annotateRead(value, policy, args = {}) {
  if (!emptyRead(value)) return value;
  const applicable = policy && (!args.userId || String(args.userId) === policy.ownerId);
  const matched = applicable && (!args.query || policy.topics.some(topic => clean(args.query).includes(clean(topic))));
  return {...value, resultStatus: matched ? 'restricted' : 'no_usable_record', interpretation: EMPTY_GUIDANCE,
    ...(applicable ? {currentTurnRestrictions: policy} : {})};
}

function unsupportedAbsence(text) {
  const unquoted = String(text).replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/gu, '');
  return unquoted.split(/[。！？!?；;\n]/u).some(sentence => {
    const normalized = clean(sentence);
    if (/(?:不代表|不能说|不要说|并非|不是说|不能证明|不等于|未必)/u.test(normalized)) return false;
    if (/[？?]/u.test(sentence) || /(?:吗|么)\s*$/u.test(sentence)) return false;
    return /(?:你(?:以前|之前|从来|从|一直|好像|似乎)?(?:都)?(?:没|没有|从未)(?:跟我|向我|对我|和我|给我)?(?:说过|讲过|告诉过|提过|提供过|说起过)|(?:我)?没(?:有)?听(?:到)?你(?:说过|提过|讲过))/u.test(normalized)
      || /you(?:'ve| have)? never (?:told|mentioned|said)/iu.test(sentence);
  });
}

export function rejectUnsupportedAbsence(args, {policy, hadEmptyRead, entries = []}) {
  if (!policy && !hadEmptyRead) return null;
  const owners = [...new Set(entries.map(entry => String(entry.senderId)))];
  if (owners.length !== 1) return null;
  if (args.atUserId && String(args.atUserId) !== owners[0]) return null;
  if (args.replyToMessageId != null && !entries.some(entry => String(entry.mid) === String(args.replyToMessageId))) return null;
  const messages = typeof args.messages === 'string' ? [args.messages] : Array.isArray(args.messages) ? args.messages : [];
  if (!messages.some(message => typeof message === 'string' && unsupportedAbsence(message))) return null;
  return {block: true, reason: '本批消息未发送：当前无可用检索记录不能证明用户从未提供信息。请改为“当前没有可用记录”；若【本轮本人检索限制】已说明该事项禁记，直接说明禁记状态，不要重复检索。'};
}
