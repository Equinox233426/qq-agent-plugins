import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const STORAGE_NAMESPACE='session-memory-keeper';
export function discoverPreviousProviders(pluginRoot){
  if(!fs.existsSync(pluginRoot))return [];
  return [...new Set(fs.readdirSync(pluginRoot,{withFileTypes:true}).filter(e=>e.isDirectory()).flatMap(entry=>{
    try{
      const file=path.join(pluginRoot,entry.name,'plugin.json');
      const doc=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
      return /^memory-keeper-[a-z0-9._-]+$/i.test(doc.id)&&doc.name==='会话记忆管理与召回'?[doc.id]:[];
    }catch{return [];}
  }))].sort();
}
const markerName='.migration-1.0.2.json';
const inside=(file,dir)=>{const rel=path.relative(dir,file);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
const sha=value=>createHash('sha256').update(value).digest('hex');
function checkedStat(file){const stat=fs.lstatSync(file,{bigint:true});if(stat.isSymbolicLink())throw Error('记忆迁移路径存在链接，原数据保留');return stat;}
const revision=stat=>`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
function listFiles(root,dir=root){
  if(!checkedStat(dir).isDirectory())throw Error('记忆迁移目录无效');
  return fs.readdirSync(dir).flatMap(name=>{
    const file=path.resolve(dir,name);if(!inside(file,root))throw Error('记忆迁移路径越界');
    const stat=checkedStat(file);
    if(stat.isDirectory())return listFiles(root,file);
    if(!stat.isFile())throw Error('记忆迁移文件类型无效');
    return [{file,relative:path.relative(root,file),stamp:revision(stat)}];
  });
}
export function discoverPreviousStorage(dataDir){
  dataDir=path.resolve(dataDir);
  if(!fs.existsSync(dataDir))return [];
  if(!checkedStat(dataDir).isDirectory())throw Error('数据目录无效');
  return fs.readdirSync(dataDir,{withFileTypes:true}).filter(entry=>{
    if(!/^memory-keeper-[a-z0-9._-]+$/i.test(entry.name))return false;
    checkedStat(path.join(dataDir,entry.name));
    return entry.isDirectory()&&['scopes','evidence','index','semantic-cards','cross-turn'].some(name=>fs.existsSync(path.join(dataDir,entry.name,name)));
  }).map(entry=>entry.name).sort();
}
function validateDocument(row,content){
  const top=row.relative.split(path.sep)[0];
  if(!['scopes','evidence','index','semantic-cards','cross-turn'].includes(top))throw Error('旧记忆目录包含未知内容，停止自动迁移');
  if(!['scopes','evidence'].includes(top))return;
  const match=/^(group|private)_([1-9]\d{4,15})\.json$/.exec(path.basename(row.relative));
  if(!match||path.dirname(row.relative)!==top)throw Error('旧记忆会话文件名无效');
  let doc;try{doc=JSON.parse(content.toString('utf8').replace(/^\uFEFF/,''));}catch{throw Error('旧记忆文件损坏，停止迁移并保留原文件');}
  if(doc.version!==1||doc.chatKey!==`${match[1]}:${match[2]}`)throw Error('旧记忆会话结构无效');
  if(top==='scopes'&&(!Array.isArray(doc.facts)||!Array.isArray(doc.bans)||!Array.isArray(doc.controls)))throw Error('旧记忆维护结构无效');
  if(top==='evidence'&&(!doc.replies||typeof doc.replies!=='object'||Array.isArray(doc.replies)||!Array.isArray(doc.receipts)))throw Error('旧记忆来源结构无效');
}
export function ensureStorage(dataDir){
  dataDir=path.resolve(dataDir);
  const previous=discoverPreviousStorage(dataDir),target=path.join(dataDir,STORAGE_NAMESPACE);
  if(fs.existsSync(target)){
    if(!checkedStat(target).isDirectory())throw Error('新记忆路径不是目录');
    const marker=path.join(target,markerName);
    if(fs.existsSync(marker)){
      checkedStat(marker);const doc=JSON.parse(fs.readFileSync(marker,'utf8'));
      if(doc.version!==1||doc.completed!==true||doc.namespace!==STORAGE_NAMESPACE)throw Error('记忆迁移记录无效');
      return {migrated:false,previousCount:previous.length,alreadyMigrated:true};
    }
  }
  if(!previous.length)return {migrated:false,previousCount:0};
  if(previous.length!==1)throw Error('发现多个旧记忆目录，停止自动迁移；请先确认要沿用的记录');
  if(fs.existsSync(target)&&listFiles(target).length)throw Error('新旧记忆数据同时存在，停止自动合并；现有记录均保留');
  const legacy=path.join(dataDir,previous[0]);checkedStat(legacy);
  const original=listFiles(legacy);
  const staged=fs.mkdtempSync(path.join(dataDir,`.${STORAGE_NAMESPACE}.migration-`));
  if(!inside(staged,dataDir)||path.dirname(staged)!==path.resolve(dataDir))throw Error('迁移暂存路径越界');
  try{
    const copied=[];
    for(const row of original){
      if(revision(checkedStat(row.file))!==row.stamp)throw Error('迁移期间旧记忆变化，停止操作');
      const content=fs.readFileSync(row.file);validateDocument(row,content);
      const destination=path.join(staged,row.relative);if(!inside(destination,staged))throw Error('迁移目标路径越界');
      fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,content);
      const digest=sha(content);if(sha(fs.readFileSync(destination))!==digest)throw Error('记忆迁移复制校验失败');
      copied.push({...row,sha256:digest});
    }
    const current=listFiles(legacy);
    if(current.length!==original.length)throw Error('迁移期间旧记忆文件数量变化');
    for(const row of copied)if(revision(checkedStat(row.file))!==row.stamp||sha(fs.readFileSync(row.file))!==row.sha256)throw Error('迁移期间旧记忆变化，原文件保留');
    fs.writeFileSync(path.join(staged,markerName),JSON.stringify({version:1,completed:true,namespace:STORAGE_NAMESPACE,previousNamespaceHash:sha(previous[0]),files:copied.map(row=>({path:row.relative.replaceAll('\\','/'),sha256:row.sha256})),completedAt:new Date().toISOString()},null,2));
    if(fs.existsSync(target)){
      if(listFiles(target).length)throw Error('新记忆目录在迁移期间出现数据，停止覆盖');
      // rmdir removes only an empty, verified destination, never its contents.
      fs.rmdirSync(target);
    }
    fs.renameSync(staged,target);
    return {migrated:true,files:copied.length,previousCount:1};
  }finally{
    if(fs.existsSync(staged)){
      if(!inside(path.resolve(staged),path.resolve(dataDir))||path.dirname(path.resolve(staged))!==path.resolve(dataDir))throw Error('迁移暂存清理路径越界');
      listFiles(staged);fs.rmSync(staged,{recursive:true,force:true});
    }
  }
}
