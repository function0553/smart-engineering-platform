import test from 'node:test';import assert from 'node:assert/strict';import {engineeringModules,visibleEngineeringGroups,readMobileRoute,mobileRouteHash,projectQueue,siteWorkspaceIdentity} from '../shared/mobile-navigation.mjs';
test('all 25 real engineering modules have one navigation entry',()=>{assert.equal(engineeringModules.length,25);assert.equal(new Set(engineeringModules.map(m=>m.id)).size,25);});
test('project roles filter money modules without inventing finance approval',()=>{const ids=role=>visibleEngineeringGroups(role).flatMap(g=>g.modules.map(m=>m[0]));assert(!ids('engineer').includes('contracts'));assert(ids('engineer').includes('materials'));assert(ids('finance').includes('contracts'));assert(!ids('viewer').includes('cost-control'));});
test('route refresh and browser back preserve project module and source item',()=>{const r={view:'projects',projectId:'00000000-0000-0000-0000-000000000001',module:'measurements',itemId:'00000000-0000-0000-0000-000000000002'};assert.deepEqual(readMobileRoute(mobileRouteHash(r)),r);assert.equal(readMobileRoute('#engineering?module=admin&project=bad').module,'');});
test('project links open construction documents while explicit secondary and legacy links remain reachable',()=>{
 const projectId='00000000-0000-0000-0000-000000000001';
 assert.equal(readMobileRoute('#engineering?view=projects&project='+projectId).module,'documents');
 assert.equal(readMobileRoute('#engineering?view=projects',projectId).module,'documents');
 assert.equal(readMobileRoute('#engineering?view=projects').module,'');
 for(const module of ['menu','daily','photos','library-all',...engineeringModules.map(m=>m.id)]){
  const route={view:'projects',projectId,module,itemId:''};
  assert.deepEqual(readMobileRoute(mobileRouteHash(route)),route);
 }
 assert.equal(readMobileRoute('#engineering?view=workbench',projectId).module,'');
 assert.equal(readMobileRoute('#engineering?view=todos',projectId).module,'');
 assert.equal(readMobileRoute('#engineering?view=me',projectId).module,'');
});
test('project identity follows effective document role without exposing platform account roles',()=>{
 const permission={enabled:true,template:'documenter',actions:['read','create','editAny','submit','archive','download']};
 const frozen=JSON.stringify(permission),identity=siteWorkspaceIdentity('engineer',permission);
 assert.equal(identity.label,'资料员');assert(identity.actions.includes('归档资料'));assert(!identity.actions.includes('审核资料'));
 assert.equal(JSON.stringify(permission),frozen);
 assert.deepEqual(siteWorkspaceIdentity('engineer',{...permission,expired:true}),{label:'资料授权未生效',actions:[],ready:true});
 assert.equal(siteWorkspaceIdentity('viewer',{...permission,actions:['read']}).label,'只读人员');
 assert.deepEqual(siteWorkspaceIdentity('viewer',{...permission,actions:['read']}).actions,['查阅资料']);
});
test('project identity offers only read operations for ended projects and waits for authoritative permission',()=>{
 const permission={enabled:true,template:'manager',actions:['read','create','submit','review','archive','download']};
 assert.deepEqual(siteWorkspaceIdentity('manager',permission,'completed').actions,['下载原件']);
 assert.deepEqual(siteWorkspaceIdentity('engineer',undefined),{label:'施工员',actions:[],ready:false});
 assert.deepEqual(siteWorkspaceIdentity('engineer',{enabled:false},'active').actions,['上传资料','整理归档','查阅原件']);
 assert.deepEqual(siteWorkspaceIdentity('viewer',{enabled:false},'active').actions,['查阅资料']);
});
test('project queue includes independent approval sources and excludes effective terminal business',()=>{const d={items:[{id:'a',kind:'tasks',state:'active',data:{title:'任务',dueDate:'2026-10-19'}},{id:'b',kind:'costs',state:'approved',data:{title:'已入账',dueDate:'2026-01-01'}}],reversals:[{id:'c',state:'submitted',requested_by:'u',snapshot:{title:'冲销'}}],boq:{revisions:[{id:'d',state:'submitted',title:'清单'}]},costControl:{records:[{id:'e',state:'approved'},{id:'f',state:'submitted',data:{title:'耗用'}}]}};const r=projectQueue(d,{progress:{records:[{id:'g',state:'submitted',snapshot:{title:'进度'}}]}},'2026-10-20');assert.equal(r.length,5);assert(r[0].overdue);assert.equal(r.find(x=>x.id==='c').actorId,'u');assert(!r.some(x=>x.id==='b'||x.id==='e'));assert.equal(r.find(x=>x.id==='g').module,'progress');assert.equal(r.find(x=>x.id==='g').itemId,'g');assert.equal(r.find(x=>x.id==='d').itemId,'d');});

test('project queue follows dispatched returns, returned files and delegated submitter without granting approval',()=>{const d={items:[{id:'p',kind:'purchases',state:'approved',data:{title:'采购履约'}}],purchaseReturns:{returns:[{id:'r',state:'approved',purchase_id:'p',dispatch:null,snapshot:{purchaseTitle:'退货单'}},{id:'sent',state:'approved',purchase_id:'p',dispatch:{at:'today'}}]}};const r=projectQueue(d,{siteRecords:{records:[{id:'s',state:'draft',created_by:'original',review:{state:'returned',submitted_by:'delegate'},data:{title:'退回资料'}},{id:'a',state:'draft',review:{state:'approved'},data:{title:'待归档'}}]}});assert.equal(r.length,4);assert.equal(r.find(x=>x.id==='r').itemId,'p');assert.equal(r.find(x=>x.id==='s').actorId,'delegate');assert(!r.some(x=>x.id==='sent'));});

test('site review queue names the next stage through return, resubmit, approval and archive',()=>{
 const row={id:'phone-record',state:'draft',created_by:'worker',data:{title:'同一份施工资料'}};
 for(const [state,label] of [['submitted','施工资料待复核'],['returned','施工资料待补充'],['submitted','施工资料待复核'],['approved','施工资料待归档']]){
  for(const reviewFields of [{review:{state,submitted_by:'worker'}},{review_state:state}]){
   const [item]=projectQueue({items:[]},{siteRecords:{records:[{...row,...reviewFields}]}});
   assert.equal(item.label,label);assert.equal(item.state,state);assert.equal(item.itemId,row.id);assert.equal(item.module,'documents');
  }
 }
 assert.deepEqual(projectQueue({items:[]},{siteRecords:{records:[{...row,state:'archived',review:{state:'approved'}}]}}),[]);
 assert.deepEqual(projectQueue({items:[]},{siteRecords:{records:[row]}}),[]);
});
