import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {unzipSync,strFromU8} from 'fflate';
import {DOMParser} from '@xmldom/xmldom';
import {buildEngineeringWorkbook} from '../server/engineering-export.mjs';

function fixture(){
  const pid=randomUUID(),purchaseId=randomUUID(),actor=randomUUID(),at='2026-10-12T04:00:00.000Z';
  const material=(title,unit)=>({id:randomUUID(),project_id:pid,kind:'materials',state:'active',version:1,created_by:actor,created_at:at,updated_at:at,data:{title,unit,code:randomUUID(),specification:'合成规格',warehouse:'合成仓库',note:''}});
  const a=material('=1+1','米'),b=material('砂','吨');
  const lines=[[a,10000,1200],[b,5000,10000],[a,2000,1000]].map(([material,quantity,unitPrice])=>({id:randomUUID(),materialId:material.id,materialTitle:material.data.title,code:material.data.code,specification:material.data.specification,unit:material.data.unit,warehouse:material.data.warehouse,quantity,unitPrice,amount:quantity*unitPrice/1000}));
  const purchase={id:purchaseId,project_id:pid,kind:'purchases',state:'approved',version:3,created_by:actor,created_at:at,updated_at:at,data:{title:'合成三行采购',supplier:'供应商',contractId:'',dueDate:'2026-10-20',note:'原件不变',amount:64000,lines}};
  const received=[4000,2000,1000],terminated=[6000,3000,1000],batch=randomUUID();
  const stock=lines.map((line,i)=>({id:randomUUID(),project_id:pid,material_id:line.materialId,kind:'receive',quantity:received[i],reference_id:purchaseId,purchase_line_id:line.id,receipt_batch_id:batch,note:'合成验收',actor_id:actor,created_at:at,reversed:false}));
  const term={id:randomUUID(),project_id:pid,purchase_id:purchaseId,state:'approved',version:2,note:'剩余不再交付',requested_by:randomUUID(),requester_name:'申请人',created_at:at,reviewed_by:randomUUID(),reviewer_name:'独立复核人',reviewed_at:at,review_note:'核对原件及未交数量',snapshot:{purchaseId,purchaseTitle:purchase.data.title,purchaseVersion:3,contractId:'',createdBy:actor,editedBy:'',originalAmount:64000,effectiveAmount:64000,lines:lines.map((line,i)=>({lineId:line.id,materialId:line.materialId,materialTitle:line.materialTitle,code:line.code,specification:line.specification,unit:line.unit,warehouse:line.warehouse,orderedQuantity:line.quantity,unitPrice:line.unitPrice,originalAmount:line.amount,receivedQuantity:received[i],terminatedQuantity:0,remainingQuantity:line.quantity-received[i],quantity:terminated[i],effectiveAmountBefore:line.amount,effectiveAmountAfter:(line.quantity-terminated[i])*line.unitPrice/1000,releasedAmount:terminated[i]*line.unitPrice/1000}))}};
  return {project:{id:pid,state:'active',data:{name:'采购导出合成工程',code:'QA',owner:'测试',address:'本机',startDate:'2026-10-01',dueDate:'2026-12-31'}},finance:{budget:1000000,expense:0,income:0,payable:0,receivable:0},items:[a,b,purchase],stock,balances:{[a.id]:5000,[b.id]:2000},purchaseFulfillment:{orders:[{purchaseId,effectiveAmount:99999999}],terminations:[term],sources:[]},corrections:[],reversals:[]};
}
function workbook(detail){
  const files=Object.fromEntries(Object.entries(unzipSync(buildEngineeringWorkbook(detail))).map(([name,bytes])=>[name,strFromU8(bytes)]));
  const parse=xml=>new DOMParser().parseFromString(xml,'application/xml');
  const all=(node,tag)=>Array.from(node.getElementsByTagName(tag));
  const relations=new Map(all(parse(files['xl/_rels/workbook.xml.rels']),'Relationship').map(node=>[node.getAttribute('Id'),node.getAttribute('Target')]));
  const sheets=Object.fromEntries(all(parse(files['xl/workbook.xml']),'sheet').map(node=>{const xml=files['xl/'+relations.get(node.getAttribute('r:id'))],dom=parse(xml),rows=all(dom,'row').map(row=>all(row,'c').map(cell=>({type:cell.getAttribute('t'),value:cell.getAttribute('t')==='n'?Number(all(cell,'v')[0].textContent):all(cell,'t').map(t=>t.textContent).join('')}))),headers=rows[0].map(c=>c.value);return [node.getAttribute('name'),{xml,rows,records:rows.slice(1).map(row=>Object.fromEntries(headers.map((key,i)=>[key,row[i]?.value])))}];}));
  return {files,sheets};
}
test('multi-line procurement workbook has no mixed-unit total and recomputes effective commitment from original decisions',()=>{
  const detail=fixture(),before=JSON.stringify(detail),{sheets}=workbook(detail),order=sheets['采购'].records[0];
  assert.equal(order['原采购金额（元）'],640);assert.equal(order['有效采购金额（元）'],258);assert.equal(order['终止释放金额（元）'],382);assert.equal(order['原采购数量'],'');assert.equal(order['净入库数量'],'');assert.equal(order['材料行数'],3);
  assert.deepEqual(sheets['采购明细'].records.map(r=>[r['单位'],r['原订数量'],r['净入库数量'],r['已批准终止数量'],r['待收货数量'],r['有效行金额（元）']]),[['米',10,4,6,0,48],['吨',5,2,3,0,200],['米',2,1,1,0,10]]);
  assert.equal(sheets['采购终止历史'].records.reduce((sum,r)=>sum+r['已批准释放金额（元）'],0),382);
  assert.equal(new Set(sheets['库存流水'].records.map(r=>r['收货批次ID'])).size,1);assert.equal(new Set(sheets['库存流水'].records.map(r=>r['采购行ID'])).size,3);
  assert.equal(JSON.stringify(detail),before,'export must not modify the original snapshot');
});
test('reversed receipt restores only its line remaining and never expands approved termination',()=>{
  const detail=fixture();detail.stock[0].reversed=true;detail.balances[detail.stock[0].material_id]=1000;
  const {sheets}=workbook(detail),line=sheets['采购明细'].records[0];
  assert.equal(line['净入库数量'],0);assert.equal(line['已批准终止数量'],6);assert.equal(line['待收货数量'],4);assert.equal(line['有效行金额（元）'],48);
  assert.equal(sheets['采购'].records[0]['有效采购金额（元）'],258);assert.equal(sheets['库存流水'].records[0]['当前有效库存影响'],0);assert.equal(sheets['库存流水'].records[0]['批准冲销调整'],-4);
});
test('pending and rejected termination histories show requested release without reducing current amounts',()=>{
  for(const state of ['submitted','rejected','cancelled']){const detail=fixture();detail.purchaseFulfillment.terminations[0].state=state;
    const {sheets}=workbook(detail);assert.equal(sheets['采购'].records[0]['有效采购金额（元）'],640);assert.equal(sheets['采购'].records[0]['终止释放金额（元）'],0);
    assert.deepEqual(sheets['采购明细'].records.map(r=>r['已批准终止数量']),[0,0,0]);assert.equal(sheets['采购终止历史'].records.reduce((n,r)=>n+r['申请释放金额（元）'],0),382);assert.equal(sheets['采购终止历史'].records.reduce((n,r)=>n+r['已批准释放金额（元）'],0),0);
  }
});
test('purchase workbook rejects cross-project decisions, inconsistent amount and a receipt assigned to the wrong material line',()=>{
  const foreign=fixture();foreign.purchaseFulfillment.terminations[0].project_id=randomUUID();assert.throws(()=>workbook(foreign),e=>e.status===422);
  const corrupt=fixture();corrupt.purchaseFulfillment.terminations[0].snapshot.lines[0].releasedAmount++;assert.throws(()=>workbook(corrupt),e=>e.status===422);
  const wrong=fixture();wrong.stock[0].purchase_line_id=wrong.items[2].data.lines[1].id;assert.throws(()=>workbook(wrong),e=>e.status===422);
});
test('procurement text remains literal and quantities and money remain typed numbers',()=>{
  const {files,sheets}=workbook(fixture()),text=Object.values(files).join('\n');assert.doesNotMatch(text,/<f(?:\s|>)/);assert.doesNotMatch(text,/TargetMode="External"/);
  const rows=sheets['采购明细'].rows,header=rows[0].map(c=>c.value);assert.equal(rows[1][header.indexOf('材料名称')].value,'=1+1');assert.equal(rows[1][header.indexOf('材料名称')].type,'inlineStr');assert.equal(rows[1][header.indexOf('原订数量')].type,'n');assert.equal(rows[1][header.indexOf('有效行金额（元）')].type,'n');
  for(const sheet of Object.values(sheets)){assert.match(sheet.xml,/<pane[^>]*ySplit="1"/);assert.match(sheet.xml,/<autoFilter/);}
});
