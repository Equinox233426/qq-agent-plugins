import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// 仅首次没有文件时使用默认值；损坏文件不能被当作空库覆盖。
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); }
  catch(error) { if(error.code==='ENOENT') return fallback; throw Error('记忆文件无法读取，停止操作以保留原文件：'+path.basename(file)); }
}
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp,typeof data==='string'?data:JSON.stringify(data,null,1),'utf8');
    fs.renameSync(temp,file);
  } finally { if(fs.existsSync(temp)) fs.unlinkSync(temp); }
}
