/** Plugin-owned provenance and complete receipt journal; host chat archives stay read-only. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const scope = key => {
  if (!/^(private|group):[1-9]\d{4,15}$/.test(String(key))) throw Error('证据会话标识无效');
  return key.replace(':', '_');
};
const validId = id => /^-?[1-9]\d*$/.test(String(id)) && Number.isSafeInteger(Number(id));
export class EvidenceJournal {
  constructor(dataDir, { maxReceipts = 24, maxReceiptChars = 65536, maxBytes = 8 * 1024 * 1024 } = {}) {
    this.root = path.join(dataDir, 'session-memory-keeper', 'evidence');
    this.maxReceipts = maxReceipts; this.maxReceiptChars = maxReceiptChars; this.maxBytes = maxBytes;
    this.cache = new Map();
  }
  file(key) { return path.join(this.root, scope(key) + '.json'); }
  load(key) {
    const file = this.file(key);
    let stamp = 'missing', doc;
    try { const stat = fs.statSync(file); if (stat.size > this.maxBytes) throw Error('插件证据文件过大，停止写入'); stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const cached = this.cache.get(key);
    if (cached?.stamp === stamp) return cached.doc;
    if (stamp === 'missing') doc = { version: 1, chatKey: key, replies: {}, receipts: [] };
    else {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc.chatKey !== key || doc.version !== 1 || !doc.replies || typeof doc.replies !== 'object' || Array.isArray(doc.replies) || !Array.isArray(doc.receipts)) throw Error('插件证据格式错误，停止操作');
    }
    const proofHash = createHash('sha256').update(JSON.stringify(doc.replies)).digest('hex');
    this.cache.delete(key); this.cache.set(key, { stamp, doc, proofHash });
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
    return doc;
  }
  revision(key) { this.load(key); return this.cache.get(key).proofHash; }
  write(key, doc) {
    const text = JSON.stringify(doc);
    if (Buffer.byteLength(text) > this.maxBytes) throw Error('插件证据达到容量上限，停止写入；已有数据保留');
    const file = this.file(key), tmp = file + '.' + process.pid + '.tmp';
    fs.mkdirSync(this.root, { recursive: true }); fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
    const stat = fs.statSync(file), stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const proofHash = createHash('sha256').update(JSON.stringify(doc.replies)).digest('hex');
    this.cache.delete(key); this.cache.set(key, { stamp, doc, proofHash });
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
  }
  captureSend(key, args, result, lookup) {
    if (result?.isError || !validId(args?.replyToMessageId)) return 0;
    let value; try { value = JSON.parse(result.content); } catch { return 0; }
    if (!Array.isArray(value?.messageIds)) return 0;
    const original = lookup(key, args.replyToMessageId);
    if (!original || original.recalled || String(original.mid) !== String(args.replyToMessageId)) return 0;
    const doc = structuredClone(this.load(key)); let saved = 0;
    for (const id of value.messageIds) {
      if (!validId(id)) continue;
      const sent = lookup(key, id);
      if (!sent?.self || sent.recalled || String(sent.mid) !== String(id) || !Number.isFinite(sent.ts)) continue;
      const record = { sentId: String(id), sentTime: sent.ts, textHash: createHash('sha256').update(sent.text).digest('hex'),
        sourceId: String(original.mid), sourceTime: original.ts, sourceOwner: String(original.senderId), sourceTextHash: createHash('sha256').update(original.text).digest('hex') };
      if (JSON.stringify(doc.replies[String(id)]) === JSON.stringify(record)) continue;
      doc.replies[String(id)] = record; saved++;
    }
    if (saved) this.write(key, doc);
    return saved;
  }
  enrich(key, rows) {
    const doc = this.load(key), byId = new Map(rows.filter(r => r.mid != null).map(r => [String(r.mid), r]));
    return rows.map(row => {
      const proof = row.self && row.mid != null ? doc.replies[String(row.mid)] : null;
      if (!proof || row.recalled || row.ts !== proof.sentTime || createHash('sha256').update(row.text).digest('hex') !== proof.textHash) return row;
      const original = byId.get(proof.sourceId);
      if (!original || original.recalled || original.ts !== proof.sourceTime || String(original.senderId) !== proof.sourceOwner || createHash('sha256').update(original.text).digest('hex') !== proof.sourceTextHash) return row;
      if (row.reply?.mid != null) return row;
      return { ...row, reply: { mid: original.mid, senderId: original.senderId, sender: original.senderName, text: original.text.slice(0, 120) } };
    });
  }
  captureReceipt(key, sessionId, toolName, args, result) {
    const text = String(result?.content ?? '');
    const digest = createHash('sha256').update(JSON.stringify([sessionId, toolName, args, text, !!result?.isError])).digest('hex');
    const doc = structuredClone(this.load(key));
    if (doc.receipts.some(r => r.digest === digest)) return;
    const complete = text.length <= this.maxReceiptChars;
    doc.receipts.push({ digest, sessionId: String(sessionId), toolName, args, isError: !!result?.isError,
      resultChars: text.length, resultTruncated: !complete, result: complete ? text : null, storedAt: Date.now() });
    doc.receipts = doc.receipts.slice(-this.maxReceipts);
    this.write(key, doc);
  }
  status(key) { const doc = this.load(key); return { replyProofs: Object.keys(doc.replies).length, receipts: doc.receipts.length }; }
}
