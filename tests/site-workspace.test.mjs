import test from 'node:test';import assert from 'node:assert/strict';import{siteWorkflow,siteSaveStatus,siteNextStep,permittedSiteNodes}from'../shared/site-workspace.mjs';
test('selected, uncertain, uploading and server-saved originals never share a saved claim',()=>{
 assert.equal(siteSaveStatus(), '仅本机待上传');assert.equal(siteSaveStatus({record:{},files:0}), '服务器草稿 · 尚无原件');assert.equal(siteSaveStatus({record:{},files:3}), '服务器已保存');
 assert.equal(siteSaveStatus({record:{},files:3,items:[{phase:'failed'}]}),'仍有原件未保存');assert.equal(siteSaveStatus({record:{},files:3,items:[{phase:'verifying'}]}),'正在上传或核对');assert.equal(siteSaveStatus({record:{},pending:true}),'保存结果待确认');assert.equal(siteSaveStatus({record:{},files:3,pendingUploads:1}),'仍有原件未保存');
});
test('workflow and next step follow explicit server capability rather than account title',()=>{
 assert.equal(siteWorkflow({state:'draft',review:{state:'submitted'}}),'待审核');assert.equal(siteWorkflow({state:'draft',review:{state:'approved'}}),'待归档');assert.equal(siteWorkflow({state:'archived',review:{state:'approved'}}),'已归档');
 assert.match(siteNextStep({capabilities:{review:true}}),/轮到你审核/);assert.match(siteNextStep({review:{state:'submitted'},capabilities:{}}),/等待指定/);assert.match(siteNextStep({review:{state:'approved'},capabilities:{archive:false}}),/等待获授权/);assert.match(siteNextStep({review:{state:'returned'},capabilities:{submit:true}}),/退回意见/);
});
test('filing WBS options honor subtree grants and terminate on malformed hierarchy cycles',()=>{
 const nodes=[{id:'root',data:{}},{id:'child',data:{parentId:'root'}},{id:'other',data:{}},{id:'cycle',data:{parentId:'cycle'}}];assert.deepEqual(permittedSiteNodes(nodes,{enabled:true,wbsIds:['root']}).map(n=>n.id),['root','child']);assert.equal(permittedSiteNodes(nodes,{enabled:false}).length,4);
});

test('unfinished inbox deduplicates queue/server references and retains original operation/upload objects',async()=>{
 const {mergeSiteUnfinished}=await import('../shared/site-workspace.mjs');const pending={recordId:'A',body:{requestId:'original'},draft:{data:{title:'原办理'}}},upload={recordId:'A',name:'原图.jpg',uploadId:'unchanged'},before=JSON.stringify({pending,upload});
 const rows=mergeSiteUnfinished({pending,upload,queues:[{recordId:'A',title:'本机',count:2}],serverRecords:[{recordId:'A',title:'服务器资料',count:1},{recordId:'B',title:'另一份',count:3}]});
 assert.equal(rows.length,2);assert.equal(rows[0].hasOperation,true);assert.equal(rows[0].hasUpload,true);assert.equal(rows[0].count,2);assert.equal(rows[0].serverCount,1);assert.equal(rows[1].recordId,'B');assert.equal(JSON.stringify({pending,upload}),before);
 const created=mergeSiteUnfinished({pending:{kind:'create',draft:{data:{title:'尚未确认的新建'}}}});assert.equal(created[0].recordId,'');assert.equal(created[0].hasOperation,true);
});
test('unfinished inbox preserves server-open upload even when the live local batch is already saved',async()=>{
 const {mergeSiteUnfinished}=await import('../shared/site-workspace.mjs');assert.deepEqual(mergeSiteUnfinished({queues:[{recordId:'A',title:'旧缓存',count:2}],liveQueue:{recordId:'A',items:[{phase:'saved'}]}}),[]);
 const rows=mergeSiteUnfinished({liveQueue:{recordId:'A',items:[{phase:'saved'}]},serverRecords:[{recordId:'A',title:'仍有服务端上传',count:1}]});assert.equal(rows[0].count,1);assert.equal(rows[0].serverCount,1);
});
test('unfinished queue discovery isolates backend/account/project and never mutates or returns file bytes',async()=>{
 const {readSiteUnfinishedQueues}=await import('../shared/site-workspace.mjs');const scope={namespace:'engineering:site-records:["backend","user","project"]',backend:'backend',userId:'user',projectId:'project'},recordId='11111111-1111-4111-8111-111111111111';
 const own=JSON.stringify({schema:1,recordId,scopeKey:JSON.stringify(['backend','user','project',recordId]),items:[{key:'pending',name:'原件.jpg',phase:'needs-file',fileId:''},{key:'done',name:'已完成.jpg',phase:'verifying',fileId:'server-original'}]}),map=new Map([[scope.namespace+':queue:'+recordId,own],['other:queue:'+recordId,own]]),storage={get length(){return map.size},key:n=>[...map.keys()][n],getItem:k=>map.get(k)||null};
 assert.deepEqual(readSiteUnfinishedQueues(storage,scope),[{recordId,title:'原件.jpg',count:1}]);assert.equal(map.get(scope.namespace+':queue:'+recordId),own);
 for(const changed of [{backend:'else'},{userId:'else'},{projectId:'else'},{namespace:'other'}])assert.deepEqual(readSiteUnfinishedQueues(storage,{...scope,...changed}),[]);
 map.set(scope.namespace+':queue:'+recordId,'{bad');assert.deepEqual(readSiteUnfinishedQueues(storage,scope),[]);
});
