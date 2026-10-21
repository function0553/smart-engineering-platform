// Presentation only. Server ACL and per-record capabilities remain authoritative.
export function siteWorkflow(record){
 if(record?.state==='archived')return '已归档';
 if(record?.state==='withdrawn')return '已撤回';
 return ({submitted:'待审核',approved:'待归档',returned:'退回补充'})[record?.review?.state]||'未提交审核';
}
export function siteSaveStatus({record,files=0,pending=false,pendingUploads=0,items=[]}={}){
 if(items.some(i=>['hashing','uploading','verifying'].includes(i.phase)))return '正在上传或核对';
 if(pending)return '保存结果待确认';
 if(pendingUploads>0)return '仍有原件未保存';
 if(items.some(i=>i.phase!=='saved'))return '仍有原件未保存';
 if(!record)return '仅本机待上传';
 return files>0?'服务器已保存':'服务器草稿 · 尚无原件';
}
export function siteNextStep(detail){
 if(detail?.record?.state==='archived')return '已归档，正文与原件锁定。';
 if(detail?.record?.state==='withdrawn')return '已撤回，原件与历史保留。';
 const c=detail?.capabilities||{};
 if(c.review)return '轮到你审核：核对原件后，通过或退回补充。';
 if(c.archive)return '复核已通过，核对后归档。';
 if(detail?.review?.state==='submitted')return '已提交审核，等待指定复核人员办理。';
 if(detail?.review?.state==='approved')return '复核已通过，等待获授权资料员归档。';
 if(c.submit)return detail.review?.state==='returned'?'按退回意见补充原件，再重新提交。':'原件保存完成后，提交指定复核人员。';
 return detail?.writable?'补充并核对资料，按授权提交。':'当前仅可查阅，操作以项目授权为准。';
}
export function permittedSiteNodes(nodes,permission){
 if(!permission?.enabled||!permission.wbsIds?.length)return nodes;
 return nodes.filter(n=>{let id=n.id;const seen=new Set();while(id&&!seen.has(id)){if(permission.wbsIds.includes(id))return true;seen.add(id);id=nodes.find(p=>p.id===id)?.data.parentId||'';}return false;});
}

// Read only queue metadata in this exact backend/account/project namespace.
// A previously verified fileId is not a saved-state claim: detail reopening still
// verifies it. It simply keeps completed history out of the unfinished inbox.
export function readSiteUnfinishedQueues(storage,{namespace,backend,userId,projectId}){
 if(namespace!=='engineering:site-records:'+JSON.stringify([backend,userId,projectId]))return [];
 const prefix=namespace+':queue:',rows=[];
 for(let n=0;n<storage.length;n++){
  const key=storage.key(n);if(!key?.startsWith(prefix))continue;
  const recordId=key.slice(prefix.length);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recordId))continue;
  let raw;try{const text=storage.getItem(key);if(!text||text.length>200000)continue;raw=JSON.parse(text);}catch{continue;}
  if(raw?.schema!==1||raw.recordId!==recordId||raw.scopeKey!==JSON.stringify([backend,userId,projectId,recordId])||!Array.isArray(raw.items)||raw.items.length>100)continue;
  const unfinished=raw.items.filter(i=>i&&typeof i.name==='string'&&typeof i.key==='string'&&!i.fileId&&i.phase!=='saved');
  if(unfinished.length)rows.push({recordId,title:unfinished[0].name,count:unfinished.length});
 }
 return rows;
}

// Merging references never cancels an operation or invents authority. Actual
// resume/cancel actions continue to use the fresh detail capabilities and IDs.
export function mergeSiteUnfinished({pending,upload,queues=[],serverRecords=[],liveQueue}={}){
 const byRecord=new Map();
 const entry=(recordId,title)=>{const key=recordId||'unconfirmed-operation';if(!byRecord.has(key))byRecord.set(key,{key,recordId:recordId||'',title:title||'施工资料',count:0,serverCount:0,hasOperation:false,hasUpload:false});const row=byRecord.get(key);if(title)row.title=title;return row;};
 for(const q of queues){if(!q.recordId||!Number.isInteger(q.count)||q.count<=0)continue;const row=entry(q.recordId,q.title);row.count=Math.max(row.count,q.count);}
 if(liveQueue?.recordId){const items=liveQueue.items||[],count=items.filter(i=>i.phase!=='saved').length;if(count){const row=entry(liveQueue.recordId,items.find(i=>i.phase!=='saved')?.name);row.count=count;}else byRecord.delete(liveQueue.recordId);}
 for(const s of serverRecords){if(!s.recordId||!Number.isInteger(s.count)||s.count<=0)continue;const row=entry(s.recordId,s.title);row.serverCount=s.count;row.count=Math.max(row.count,s.count);}
 if(upload?.recordId){const row=entry(upload.recordId,upload.name);row.hasUpload=true;row.count=Math.max(row.count,1);}
 if(pending){const row=entry(pending.recordId,pending.draft?.data?.title||'上次资料办理');row.hasOperation=true;}
 return [...byRecord.values()];
}
