import {zipSync,strToU8} from 'fflate';
import {fail} from './service.mjs';
import {buildEngineeringTaskValues} from './engineering-task-value.mjs';
import {buildEngineeringValuePlansView} from './engineering-value-plans.mjs';
import {buildEngineeringReplacementsView} from './engineering-replacements.mjs';
import {buildEngineeringPurchaseFulfillment} from './engineering-purchases.mjs';
import {buildEngineeringSupplierFinance} from './engineering-supplier-finance.mjs';
import {buildEngineeringCostView} from './engineering-cost-control.mjs';
import {buildEngineeringSubcontractView} from './engineering-subcontracts.mjs';

const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAX_SHEET_ROWS=20000,MAX_TOTAL_ROWS=50000,MAX_XML_BYTES=64*1024*1024;
const labels={dispatched:'已实际发退',supplier_return:'供应商退货',planned:'待开工',active:'进行中',completed:'已完成',archived:'已归档',draft:'草稿',submitted:'待审批',approved:'已批准',closed:'已关闭',cancelled:'已作废',rejected:'已驳回',expense:'支出',income:'收入',increase:'调增',decrease:'调减',opening:'期初',receive:'采购入库',issue:'领料',return:'退料',variations:'变更签证',measurements:'计量单',settlements:'结算单',costs:'收支',stock:'库存流水',material:'材料',labor:'人工',equipment:'机械',subcontract:'分包',other:'其他'};
const label=value=>labels[value]||value||'';
const yes=value=>value?'是':'否';
const approved=row=>['approved','closed'].includes(row.state)&&!row.voided&&!row.reversed;
const money=value=>({value,kind:'money'}),quantity=value=>({value,kind:'quantity'}),date=value=>({value,kind:'date'}),time=value=>({value,kind:'time'});
const col=(label,key,kind='text',width=20)=>({label,key,kind,width});
function safeText(value){
  const text=Array.from(String(value??'')).filter(char=>{const n=char.codePointAt(0);return n===9||n===10||n===13||n>=0x20&&n<=0xD7FF||n>=0xE000&&n<=0xFFFD||n>=0x10000&&n<=0x10FFFF;}).join('');
  if(text.length>32767)fail(413,'单个导出单元格超过 Excel 的 32767 字符上限，未生成截断文件');
  return text;
}
const xml=value=>safeText(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const textXml=value=>xml(safeText(value).replace(/_x([0-9a-f]{4})_/gi,'_x005F_x$1_'));
function decimal(value,places=0){
  if(!Number.isSafeInteger(value))fail(422,'导出存在缺失或不安全的整数金额 / 数量，请核对台账');
  const number=BigInt(value),sign=number<0n?'-':'',abs=number<0n?-number:number,scale=10n**BigInt(places);
  return sign+(abs/scale)+(places?'.'+String(abs%scale).padStart(places,'0'):'');
}
function columnName(n){let name='';for(n++;n;n=Math.floor((n-1)/26))name=String.fromCharCode(65+(n-1)%26)+name;return name;}
function cell(value,kind,ref){
  if(value&&typeof value==='object'&&'kind'in value){kind=value.kind;value=value.value;}
  if(kind==='text'&&typeof value==='number')kind='integer';
  if(kind==='money'||kind==='quantity'||kind==='integer')return `<c r="${ref}" s="${kind==='money'?3:kind==='quantity'?4:5}" t="n"><v>${decimal(value,kind==='money'?2:kind==='quantity'?3:0)}</v></c>`;
  if((kind==='date'||kind==='time')&&value){
    const parsed=Date.parse(kind==='date'?String(value)+'T00:00:00.000Z':String(value));
    if(!Number.isFinite(parsed))fail(422,'导出存在无效日期，请核对台账');
    const serial=(parsed-Date.UTC(1899,11,30))/(24*3600*1000)+(kind==='time'?8/24:0);
    return `<c r="${ref}" s="${kind==='date'?6:7}" t="n"><v>${serial}</v></c>`;
  }
  return `<c r="${ref}" s="${kind==='header'?1:2}" t="inlineStr"><is><t xml:space="preserve">${textXml(value)}</t></is></c>`;
}
function rowHeight(values,columns,header=false){
  let lines=1;
  for(const [index,entry] of values.entries()){
    const wrapped=entry&&typeof entry==='object'&&'kind'in entry;
    const kind=header?'header':wrapped?entry.kind:columns[index].kind,value=wrapped?entry.value:entry;
    if(!['text','header'].includes(kind)||typeof value==='number')continue;
    const available=Math.max(1,columns[index].width-2);
    const count=safeText(value).split(/\r\n|\r|\n/).reduce((total,paragraph)=>{
      let width=0;
      for(const char of paragraph){
        const point=char.codePointAt(0);
        if(/\p{Mark}/u.test(char)||point===0x200d)continue;
        const wide=/[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(char)||point>=0x1f300;
        width+=char==='\t'?4:wide?2:1;
      }
      return total+Math.max(1,Math.ceil(width*(header?1.08:1)/available));
    },0);
    lines=Math.max(lines,count);
  }
  // Excel row heights are points. Leave padding for the 11 pt CJK font and
  // bound very long notes at Excel's supported maximum instead of overflowing.
  return Math.min(409,Math.max(header?30:20,lines*18+2));
}
function worksheet(sheet){
  const last=columnName(sheet.columns.length-1),rowCount=sheet.records.length+1;
  const headers=sheet.columns.map((c,i)=>cell(c.label,'header',columnName(i)+'1')).join('');
  const body=sheet.records.map((row,i)=>{const values=sheet.columns.map(c=>typeof c.key==='function'?c.key(row):row[c.key]);return `<row r="${i+2}" ht="${rowHeight(values,sheet.columns)}" customHeight="1">${values.map((value,j)=>cell(value,sheet.columns[j].kind,columnName(j)+(i+2))).join('')}</row>`;}).join('');
  return XML+`<worksheet xmlns="${NS}"><dimension ref="A1:${last}${rowCount}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="20"/><cols>${sheet.columns.map((c,i)=>`<col min="${i+1}" max="${i+1}" width="${c.width}" customWidth="1"/>`).join('')}</cols><sheetData><row r="1" ht="${rowHeight(sheet.columns.map(c=>c.label),sheet.columns,true)}" customHeight="1">${headers}</row>${body}</sheetData><autoFilter ref="A1:${last}${rowCount}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}
const styles=XML+`<styleSheet xmlns="${NS}"><numFmts count="4"><numFmt numFmtId="164" formatCode="#,##0.00;[Red](#,##0.00)"/><numFmt numFmtId="165" formatCode="#,##0.000;[Red](#,##0.000)"/><numFmt numFmtId="166" formatCode="yyyy-mm-dd"/><numFmt numFmtId="167" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/><color rgb="FF172B4D"/></font><font><b/><sz val="11"/><name val="Microsoft YaHei"/><color rgb="FFFFFFFF"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF234C77"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;

function validateBoqSnapshot(detail,byId){
  const boq=detail.boq??{contracts:[],revisions:[]};
  if(!Array.isArray(boq.contracts)||!Array.isArray(boq.revisions))fail(422,'清单导出快照不完整');
  if(boq.revisions.length>MAX_SHEET_ROWS)fail(413,'清单版本超过单表 20000 行，未生成截断文件');
  const revisionMap=new Map(),contractMap=new Map(),usage=new Map();
  const invalid=()=>fail(422,'清单导出来源、数量或金额不一致，请核对台账');
  const integer=(value,max=1_000_000_000_000,min=0)=>{if(!Number.isSafeInteger(value)||value<min||value>max)invalid();};
  const contract=id=>{const row=byId.get(id);if(!row||row.project_id!==detail.project.id||row.kind!=='contracts')invalid();return row;};
  let lineCount=0;
  for(const row of boq.revisions){
    if(row.project_id!==detail.project.id||!row.id||revisionMap.has(row.id)||!Array.isArray(row.lines))invalid();
    contract(row.contract_id);revisionMap.set(row.id,row);
    lineCount+=row.lines.length;if(lineCount>MAX_SHEET_ROWS)fail(413,'清单版本明细超过单表 20000 行，未生成截断文件');
    integer(row.total);integer(row.delta,1_000_000_000_000,-1_000_000_000_000);
    const ids=new Set();let total=0n;
    for(const line of row.lines){
      if(!line.id||ids.has(line.id))invalid();ids.add(line.id);
      integer(line.quantity,1_000_000_000);integer(line.unitPrice,1_000_000_000_000,1);integer(line.amount);
      if((BigInt(line.quantity)*BigInt(line.unitPrice)+500n)/1000n!==BigInt(line.amount))invalid();
      total+=BigInt(line.amount);
    }
    if(total!==BigInt(row.total))invalid();
  }
  for(const row of boq.revisions){
    if(row.base_revision_id&&revisionMap.get(row.base_revision_id)?.contract_id!==row.contract_id)invalid();
    if(row.variation_id){const variation=byId.get(row.variation_id);if(!variation||variation.kind!=='variations'||variation.data.contractId!==row.contract_id||variation.data.boqRevisionId!==row.id)invalid();}
  }
  for(const row of detail.items.filter(row=>row.kind==='measurements'))for(const line of row.data.lines){
    if(!line.boqItemId&&!line.boqRevisionId)continue;
    const revision=revisionMap.get(line.boqRevisionId),source=revision?.lines.find(item=>item.id===line.boqItemId);
    if(!source||revision.contract_id!==row.data.contractId||['name','location','unit','unitPrice'].some(key=>source[key]!==line[key]))invalid();
    if(approved(row)){
      if(revision.voided||revision.state!=='approved')invalid();
      integer(line.quantity,1_000_000_000,1);integer(line.amount);
      const key=row.data.contractId+':'+line.boqItemId,used=usage.get(key)||{quantity:0n,amount:0n};
      used.quantity+=BigInt(line.quantity);used.amount+=BigInt(line.amount);usage.set(key,used);
    }
  }
  for(const row of boq.contracts){
    contract(row.contractId);if(contractMap.has(row.contractId)||!Array.isArray(row.items))invalid();contractMap.set(row.contractId,row);
    if(row.pendingRevisionId&&revisionMap.get(row.pendingRevisionId)?.contract_id!==row.contractId)invalid();
    if(row.mode==='free'){if(row.currentRevisionId||row.items.length)invalid();continue;}
    if(row.mode!=='boq')invalid();
    const current=revisionMap.get(row.currentRevisionId);
    if(!current||current.contract_id!==row.contractId||current.state!=='approved'||current.voided||current.lines.length!==row.items.length)invalid();
    const seen=new Set();
    for(const item of row.items){
      const source=current.lines.find(line=>line.id===item.id),used=usage.get(row.contractId+':'+item.id)||{quantity:0n,amount:0n};
      if(!source||seen.has(item.id)||['code','name','location','unit','quantity','unitPrice','amount'].some(key=>source[key]!==item[key]))invalid();seen.add(item.id);
      for(const field of ['usedQuantity','usedAmount','remainingQuantity','remainingAmount'])integer(item[field]);
      if(BigInt(item.usedQuantity)!==used.quantity||BigInt(item.usedAmount)!==used.amount||item.usedQuantity+item.remainingQuantity!==item.quantity||item.usedAmount+item.remainingAmount!==item.amount)invalid();
    }
  }
  for(const row of boq.revisions)if(!contractMap.has(row.contract_id))invalid();
  return boq;
}

/** Immutable export snapshot of the existing engineering detail projection; no account, document or binary payload export. */
export function buildEngineeringWorkbook(detail,{exportedAt=new Date().toISOString()}={}){
  const {project,finance:sourceFinance,items,stock=[],balances={},corrections=[],reversals=[]}=detail;
  if(!project?.id||!sourceFinance||!Array.isArray(items))fail(422,'项目经营快照不完整，无法导出');
  for(const collection of [items,stock,corrections,reversals])if(collection.some(row=>row.project_id!==project.id))fail(422,'经营快照包含其他项目记录，已停止导出');
  const exportedKinds=new Set(['contracts','variations','measurements','settlements','costs','purchases','materials']);
  if(items.filter(row=>exportedKinds.has(row.kind)).length+stock.length+corrections.length+reversals.length>MAX_TOTAL_ROWS)fail(413,'经营导出记录量超过 50000 行，请先规划分批导出');
  const byId=new Map(items.map(row=>[row.id,row])),stockById=new Map(stock.map(row=>[row.id,row]));
  const purchaseView=buildEngineeringPurchaseFulfillment({projectId:project.id,items,stock,terminations:detail.purchaseFulfillment?.terminations??[],sources:detail.purchaseFulfillment?.sources??[],returns:detail.purchaseReturns?.returns??[]});
  const supplier=buildEngineeringSupplierFinance({projectId:project.id,items,returns:purchaseView.returns,credits:detail.supplierFinance?.credits??[],refunds:detail.supplierFinance?.refunds??[]});
  const supplierSettlements=new Map(supplier.settlements.map(row=>[row.settlementId,row]));
  const supplierPayments=new Map(supplier.payments.map(row=>[row.costId,row]));
  const effective=row=>approved(row)?row.kind==='costs'?(supplierPayments.get(row.id)?.effectiveAmount??row.data.amount):row.kind==='settlements'?(supplierSettlements.get(row.id)?.effectiveAmount??row.data.amount):row.data.amount:0;
  const hasSupplierFinance=supplier.credits.length||supplier.refunds.length;
  const finance=hasSupplierFinance?{...sourceFinance,expense:items.filter(row=>row.kind==='costs'&&row.data.direction==='expense').reduce((n,row)=>n+effective(row),0),income:items.filter(row=>row.kind==='costs'&&row.data.direction==='income').reduce((n,row)=>n+effective(row),0),payable:items.filter(row=>row.kind==='settlements'&&byId.get(row.data.contractId)?.data.direction==='expense').reduce((n,row)=>n+effective(row),0),supplierRefund:supplier.refunds.filter(row=>row.state==='approved').reduce((n,row)=>n+row.amount,0)}:sourceFinance;
  const purchaseById=new Map(purchaseView.orders.map(order=>[order.purchaseId,order]));
  const boq=validateBoqSnapshot(detail,byId);
  const hasTaskLinks=items.some(row=>row.kind==='measurements'&&row.data.lines.some(line=>line.taskId));
  // Rebuild from the same immutable source snapshot, never from cached UI totals.
  const taskValues=hasTaskLinks?buildEngineeringTaskValues(items,{projectId:project.id,observedAt:exportedAt}):null;
  const of=kind=>items.filter(row=>row.kind===kind),title=id=>id?(byId.get(id)?.data.title||'关联记录不可用'):'';
  const paidBySettlement=new Map();for(const row of of('costs'))if(row.data.settlementId&&approved(row))paidBySettlement.set(row.data.settlementId,(paidBySettlement.get(row.data.settlementId)||0)+effective(row));
  const settlementRows=of('settlements').map(row=>({...row,...row.data,contractTitle:title(row.data.contractId),measurementTitle:title(row.data.measurementId),effective:effective(row),paid:paidBySettlement.get(row.id)||0,unpaid:supplierSettlements.get(row.id)?.unpaidAmount??effective(row)-(paidBySettlement.get(row.id)||0),creditAmount:supplierSettlements.get(row.id)?.creditAmount||0,refundableAmount:supplierSettlements.get(row.id)?.refundableAmount||0,direction:byId.get(row.data.contractId)?.data.direction||''}));
  const remaining=direction=>settlementRows.filter(row=>row.direction===direction).reduce((total,row)=>total+row.unpaid,0);
  const base=row=>({...row,...row.data,contractTitle:title(row.data.contractId)});
  const sheets=[],add=(name,columns,records)=>{if(records.length>MAX_SHEET_ROWS||sheets.reduce((n,s)=>n+s.records.length,0)+records.length>MAX_TOTAL_ROWS)fail(413,'经营导出超过单表 20000 行或全册 50000 行，未生成截断文件');sheets.push({name,columns,records});};
  const metric=(name,value,unit='',definition='')=>({name,value,unit,definition});
  add('项目汇总',[col('项目 / 指标','name','text',24),col('值','value','text',42),col('单位','unit','text',12),col('说明','definition','text',72)],[
    metric('项目ID',project.id),metric('项目编号',project.data.code),metric('工程名称',project.data.name),metric('项目状态',label(project.state)),metric('负责人',project.data.owner),metric('工程地址',project.data.address),
    metric('计划开始',date(project.data.startDate)),metric('计划完成',date(project.data.dueDate)),metric('导出时间',time(exportedAt),'北京时间','下载时的同一数据库快照，非实时联机工作簿'),
    metric('项目预算',money(finance.budget),'元'),metric('有效支出',money(finance.expense),'元','有效原付款减已批准退款；退款不计普通收入，不重复累加合同、采购或结算'),metric('有效收入',money(finance.income),'元','已批准且未冲销的收入收支记录'),metric('剩余预算',money(finance.budget-finance.expense),'元'),
    metric('已批应付',money(finance.payable),'元','原有效支出结算减已批准供应商抵减'),metric('已批应收',money(finance.receivable),'元','已批准且未撤销的收入合同结算总额'),metric('结算未付',money(remaining('expense')),'元','有效应付结算减其关联有效付款；未关联结算的支出不在此扣减'),metric('结算未收',money(remaining('income')),'元','有效应收结算减其关联有效收款'),
    metric('合同记录数',of('contracts').length,'份','包含草稿、作废和已关闭原记录'),metric('撤销业务影响记录数',corrections.filter(r=>r.state==='approved').length,'笔'),metric('批准冲销记录数',reversals.filter(r=>r.state==='approved').length,'笔'),
  ]);
  add('口径说明',[col('项目','item','text',24),col('口径与范围','description','text',120)],[
    {item:'数据范围',description:'仅本项目经营台账。包含原单及纠错/冲销标记；有任务计量关联时附当前任务名称、部位、计划日期、状态及填报进度，不导出任务说明、账号资料、登录信息、日报、照片、附件原字节或其他项目。'},
    {item:'原金额与有效金额',description:'原金额保留签署/录入数。草稿、待审、作废单不产生有效金额；批准后的业务撤销或收支冲销使原单有效影响归零。合同和已办结采购保留有效影响。'},
    {item:'有效合同额',description:'按已批准且未撤销的合同变更计算：原合同额＋调增－调减。草稿或作废合同导出的有效合同额为0，原额仍保留。'},
    {item:'履约承诺',description:'合同承诺取已批准采购、有效结算、有效计量＋未关联计量结算三者的最大值，不将采购、计量和结算相加。'},
    {item:'计量',description:'数量展示三位小数，金额为元两位小数。自由计量逐行按分四舍五入；清单计量按条目累计数量应计金额减此前有效已批金额，最低为0分，批准后冻结原报价，撤销计量释放数量和金额，后续计量吸收尾差。计量总表与明细表不可重复加总。'},
    {item:'工程量清单',description:'存在清单历史时附清单余额、清单版本及版本明细。余额仅当前有效版本；版本表保留草稿、作废和配套签证已撤销的原版，0数量条目仍保留。历史版本合计不能相加为合同额；清单计量行关联具体清单条目和版本。'},
    {item:'任务产值',description:'有任务关联历史时附任务产值及任务工程量。收入与支出合同分别汇总有效已批计量行的冻结金额，不重算现价，不将两方向相加为总产值或利润。未归集单独列示；草稿、待审、作废和已撤销行有效值为0，0分已批计量仍保留有效数量。'},
    {item:'任务计划与数量',description:'任务日期和人工完成比例取导出时现值；不以金额换算进度，不计算无数量目标依据的计划产值。清单数量按任务、合同、清单条目、单位分组；自由计量按任务、合同、名称、部位、单位分组，不将异单位或不同工程内容相加。明细中的任务名称、位置是计量保存时快照。'},
    {item:'剩余可计量',description:'有效合同额－有效计量－未关联计量的有效结算。关联计量的分次结算不重复占用已计量部分。'},
    {item:'供应商退货与往来',description:'实物发退仅扣库存并恢复待补交；原价参考额、批准结算抵减、实际到账退款分列，不能直接相加。退款冲减原付款净额，不作普通收入；供应商待退与未付分别显示。历史表保留各状态，只有已实际发退或已批准财务记录生效。'},
    {item:'结算与收付',description:'未收付＝有效结算额－关联且未冲销的批准收支。草稿或撤销结算有效额为0。未关联结算的收支只计项目收入/支出，不冒充合同已付。'},
    {item:'目标成本与材料耗用',description:'目标成本按施工部位及资源编制并独立批准；与合同收入、目标产值、现金收支分开。材料实际成本仅含按原领料及凭据独立确认的耗用，不将领料或付款自动视为耗用。人工、机械、分包及费用实际尚未接入，以文字明确标示。原批准基线及撤销原件留存，不将历史基线相加。'},
    {item:'库存流水',description:'期初、入库和退料原始影响为正，领料为负。已批准冲销的调整等于原始影响的相反数，当前有效影响为0；未批准冲销不影响库存。余额取平台同一快照。'},
    {item:'采购履约',description:'采购总表的数量及单价仅在单行时显示；多行数量按材料和单位分别列在采购明细，不跨单位合计。有效行金额按原数量减累计批准终止数量后乘原单价取整，终止不改变库存、结算或成本。入库冲销只恢复对应行待收量，已批准终止量固定保留。材料身份未冻结的存量单显示当前材料资料，不冒充原历史快照。'},
    {item:'纠错与冲销',description:'保留申请和审批结果。业务金额调整列分别对应签证/计量/结算/收支的原业务口径，不跨种类累加为成本。签证撤销的调整与其原增减方向相反。库存冲销用数量调整列。'},
    {item:'时间',description:'日期按原业务日历保存，创建、更新时间及导出时间按北京时间展示。'},
    {item:'文件性质',description:'数值为导出时的静态台账快照，无公式、宏和外部连接。以 =、+、-、@ 开头的业务文本仍是纯文本，Excel 不会将其作为公式执行。'},
    {item:'完整性',description:'单表最多20000条数据、全册最多50000条数据，超过上限明确失败，不静默截断。XML非法控制字符会移除，原数据库不变。'},
  ]);
  const common=[col('记录ID','id','text',38),col('名称','title','text',28),col('状态',r=>label(r.state),'text',14)];
  const contractRef=[col('合同ID','contractId','text',38),col('合同名称','contractTitle','text',28)];
  const tail=[col('创建时间（北京时间）','created_at','time',23),col('更新时间（北京时间）','updated_at','time',23),col('依据 / 备注','note','text',48)];
  add('合同',[...common,col('合同编号','code'),col('对方单位','counterparty','text',28),col('方向',r=>label(r.direction),'text',12),col('原合同金额（元）','amount','money'),...[
    ['累计净变更（元）','changeAmount'],['有效合同额（元）','effectiveAmount'],['批准采购（元）','purchaseAmount'],['有效计量（元）','measurementAmount'],['未关联计量结算（元）','unmeasuredSettlementAmount'],['有效结算（元）','settlementAmount'],['履约承诺（元）','committedAmount'],['剩余可计量（元）','remainingMeasurementAmount'],['剩余可结算（元）','remainingSettlementAmount'],
  ].map(([name,key])=>col(name,r=>approved(r)?r.commercial?.[key]:0,'money',23)),col('截止日期','dueDate','date',14),...tail],of('contracts').map(base));
  add('变更签证',[...common,col('签证编号','code'),...contractRef,col('方向',r=>label(r.changeType),'text',12),col('原签证金额（元）','amount','money'),col('原增减影响（元）',r=>(r.changeType==='decrease'?-1:1)*r.amount,'money'),col('有效增减影响（元）',r=>approved(r)?(r.changeType==='decrease'?-1:1)*r.amount:0,'money'),col('业务影响已撤销',r=>yes(r.voided),'text',18),col('发生日期','occurredDate','date',14),...tail],of('variations').map(base));
  add('计量总表',[...common,col('计量编号','code'),...contractRef,col('期间开始','periodStart','date',14),col('期间结束','periodEnd','date',14),col('原计量金额（元）','amount','money'),col('有效计量（元）',r=>effective(r),'money'),col('累计有效结算（元）',r=>approved(r)?r.commercial?.settledAmount:0,'money'),col('计量可结算（元）',r=>approved(r)?r.commercial?.remainingSettlementAmount:0,'money'),col('业务影响已撤销',r=>yes(r.voided),'text',18),...tail],of('measurements').map(base));
  const lines=[];for(const row of of('measurements'))for(const [index,line] of row.data.lines.entries()){
    if(lines.length>=MAX_SHEET_ROWS)fail(413,'计量明细超过单表 20000 行，未生成截断文件');
    lines.push({id:row.id,title:row.data.title,code:row.data.code,state:row.state,voided:row.voided,contractId:row.data.contractId,contractTitle:title(row.data.contractId),index:index+1,...line,effective:approved(row)?line.amount:0,effectiveQuantity:approved(row)?line.quantity:0});
  }
  add('计量明细',[col('计量ID','id','text',38),col('计量名称','title','text',28),col('计量编号','code'),col('状态',r=>label(r.state)),col('业务影响已撤销',r=>yes(r.voided),'text',18),...contractRef,col('行号','index','integer',10),col('项目名称','name','text',28),col('部位','location','text',28),col('单位','unit','text',12),col('原数量','quantity','quantity'),col('单价（元）','unitPrice','money'),col('原行金额（元）','amount','money'),col('有效行金额（元）','effective','money'),col('明细说明','note','text',48),col('清单条目ID','boqItemId','text',38),col('清单版本ID','boqRevisionId','text',38),col('有效数量','effectiveQuantity','quantity'),col('归属任务ID','taskId','text',38),col('保存时任务名称','taskTitle','text',28),col('保存时任务部位','taskLocation','text',28),col('当前任务名称',r=>title(r.taskId),'text',28)],lines);
  add('结算',[...common,...contractRef,col('方向',r=>label(r.direction),'text',12),col('计量ID','measurementId','text',38),col('计量名称','measurementTitle','text',28),col('原结算金额（元）','amount','money'),col('有效结算（元）','effective','money'),col('有效已收付（元）','paid','money'),col('供应商抵减（元）','creditAmount','money'),col('超付待退（元）','refundableAmount','money'),col('未收付（元）','unpaid','money'),col('业务影响已撤销',r=>yes(r.voided),'text',18),col('应收付日期','dueDate','date',14),...tail],settlementRows);
  add('收支',[...common,col('方向',r=>label(r.direction),'text',12),col('类别',r=>label(r.category),'text',12),col('结算ID','settlementId','text',38),col('结算名称',r=>title(r.settlementId),'text',28),col('合同ID',r=>byId.get(r.settlementId)?.data.contractId||'','text',38),col('合同名称',r=>title(byId.get(r.settlementId)?.data.contractId),'text',28),col('原收支金额（元）','amount','money'),col('有效收支金额（元）',r=>effective(r),'money'),col('净现金流入（元）',r=>(r.direction==='expense'?-1:1)*effective(r),'money'),col('已冲销',r=>yes(r.reversed),'text',12),col('凭据编号','voucher','text',28),col('业务日期','occurredDate','date',14),...tail],of('costs').map(base));
  const purchaseRows=of('purchases').map(row=>({...base(row),fulfillment:purchaseById.get(row.id)}));
  const single=(row,key,kind='text')=>row.fulfillment.lines.length===1?{value:row.fulfillment.lines[0][key],kind}:{value:'',kind:'text'};
  add('采购',[...common,col('供应单位','supplier','text',28),...contractRef,col('材料ID',r=>single(r,'materialId'),'text',38),col('材料名称',r=>single(r,'materialTitle'),'text',28),col('单位',r=>single(r,'unit'),'text',12),col('原采购数量',r=>single(r,'quantity','quantity')),col('单价（元）',r=>single(r,'unitPrice','money')),col('原采购金额（元）','amount','money'),col('有效采购金额（元）',r=>r.fulfillment.effectiveAmount,'money'),col('净入库数量',r=>single(r,'receivedQuantity','quantity')),col('待收货数量',r=>single(r,'remainingQuantity','quantity')),col('材料行数',r=>r.fulfillment.lines.length,'integer',14),col('终止释放金额（元）',r=>r.fulfillment.releasedAmount,'money',24),col('材料身份已冻结',r=>yes(r.fulfillment.identityFrozen),'text',20),col('到货日期','dueDate','date',14),...tail],purchaseRows);
  if(purchaseRows.some(row=>!row.fulfillment.legacy)||purchaseView.terminations.length){
    const rows=purchaseRows.flatMap(row=>row.fulfillment.lines.map((line,index)=>({...line,purchaseId:row.id,purchaseTitle:row.title,state:row.state,contractId:row.contractId,contractTitle:row.contractTitle,index:index+1,identityFrozen:row.fulfillment.identityFrozen,releasedAmount:approved(row)?line.amount-line.effectiveAmount:0})));
    add('采购明细',[col('采购ID','purchaseId','text',38),col('采购名称','purchaseTitle','text',28),col('状态',r=>label(r.state),'text',14),...contractRef,col('行号','index','integer',10),col('采购行ID','id','text',38),col('材料ID','materialId','text',38),col('材料名称','materialTitle','text',28),col('材料编号','code'),col('规格','specification','text',24),col('单位','unit','text',12),col('仓库','warehouse','text',24),col('原订数量','quantity','quantity'),col('净入库数量','receivedQuantity','quantity'),col('已批准终止数量','terminatedQuantity','quantity',22),col('待收货数量','remainingQuantity','quantity'),col('原单价（元）','unitPrice','money'),col('原行金额（元）','amount','money'),col('有效行金额（元）','effectiveAmount','money'),col('终止释放金额（元）','releasedAmount','money',24),col('材料身份已冻结',r=>yes(r.identityFrozen),'text',20)],rows);
  }
  if(purchaseView.terminations.length){
    const rows=purchaseView.terminations.flatMap(row=>row.snapshot.lines.map(line=>({...line,terminationId:row.id,purchaseId:row.purchase_id,purchaseTitle:row.snapshot.purchaseTitle,state:row.state,note:row.note,requester:row.requester_name,createdAt:row.created_at,reviewer:row.reviewer_name,reviewedAt:row.reviewed_at,reviewNote:row.review_note,approvedReleasedAmount:row.state==='approved'?line.releasedAmount:0})));
    add('采购终止历史',[col('办理ID','terminationId','text',38),col('采购ID','purchaseId','text',38),col('采购名称','purchaseTitle','text',28),col('状态',r=>label(r.state),'text',14),col('采购行ID','lineId','text',38),col('材料名称','materialTitle','text',28),col('规格','specification','text',24),col('单位','unit','text',12),col('原订数量','orderedQuantity','quantity'),col('申请时净入库数量','receivedQuantity','quantity',22),col('申请时已终止数量','terminatedQuantity','quantity',22),col('申请时未交数量','remainingQuantity','quantity',22),col('本次申请终止数量','quantity','quantity',22),col('申请释放金额（元）','releasedAmount','money',24),col('已批准释放金额（元）','approvedReleasedAmount','money',26),col('申请人','requester'),col('申请时间（北京时间）','createdAt','time',23),col('申请依据','note','text',48),col('复核人','reviewer'),col('复核时间（北京时间）','reviewedAt','time',23),col('复核依据','reviewNote','text',48)],rows);
  }
  if(purchaseView.returns.length){
    const rows=purchaseView.returns.flatMap(row=>row.snapshot.lines.map(line=>({...line,returnId:row.id,purchaseId:row.purchase_id,purchaseTitle:row.snapshot.purchaseTitle,state:row.state,note:row.note,createdAt:row.created_at,requester:row.requester_name,reviewer:row.reviewer_name,reviewedAt:row.reviewed_at,reviewNote:row.review_note,effectiveQuantity:row.state==='dispatched'?line.quantity:0,effectiveAmount:row.state==='dispatched'?line.amount:0,dispatchDate:row.dispatch?.effectiveDate,documentNo:row.dispatch?.documentNo,dispatchNote:row.dispatch?.note,dispatchActor:row.dispatch?.actorName,dispatchAt:row.dispatch?.at})));
    add('采购退货历史',[col('退货ID','returnId','text',38),col('采购ID','purchaseId','text',38),col('采购名称','purchaseTitle','text',28),col('状态',r=>label(r.state)),col('原入库ID','receiptId','text',38),col('采购行ID','purchaseLineId','text',38),col('材料名称','materialTitle','text',28),col('规格','specification'),col('单位','unit'),col('仓库','warehouse'),col('申请退货数量','quantity','quantity'),col('原单价（元）','unitPrice','money'),col('原价参考额（元）','amount','money'),col('实际发退数量','effectiveQuantity','quantity'),col('实退参考额（元）','effectiveAmount','money'),col('申请人','requester'),col('申请时间','createdAt','time',23),col('申请依据','note','text',48),col('复核人','reviewer'),col('复核时间','reviewedAt','time',23),col('复核依据','reviewNote','text',48),col('实际发退日期','dispatchDate','date'),col('交接凭据','documentNo','text',28),col('发退经办人','dispatchActor'),col('发退登记时间','dispatchAt','time',23),col('发退依据','dispatchNote','text',48)],rows);
    add('供应商实退流水',[col('退货ID','returnId','text',38),col('采购ID','purchaseId','text',38),col('原入库ID','receiptId','text',38),col('材料ID','materialId','text',38),col('材料名称','materialTitle','text',28),col('单位','unit'),col('仓库','warehouse'),col('实际发退数量','effectiveQuantity','quantity'),col('有效库存影响',r=>-r.effectiveQuantity,'quantity'),col('原价参考额（元）','effectiveAmount','money'),col('实际发退日期','dispatchDate','date'),col('交接凭据','documentNo','text',28),col('发退经办人','dispatchActor')],rows.filter(row=>row.state==='dispatched'));
    for(const material of of('materials')){
      const original=stock.filter(row=>row.material_id===material.id&&!row.reversed).reduce((n,row)=>n+(row.kind==='issue'?-1:1)*row.quantity,0);
      const returned=rows.filter(row=>row.materialId===material.id&&row.state==='dispatched').reduce((n,row)=>n+row.quantity,0);
      if(original-returned!==balances[material.id]||original-returned<0)fail(422,'退货导出库存余额与原始流水不一致');
    }
  }
  const supplierTail=[col('申请人','requester_name'),col('申请时间','created_at','time',23),col('申请依据','note','text',48),col('复核人','reviewer_name'),col('复核时间','reviewed_at','time',23),col('复核依据','review_note','text',48)];
  if(supplier.credits.length)add('供应商抵减',[col('抵减ID','id','text',38),col('采购ID','purchase_id','text',38),col('采购名称',r=>title(r.purchase_id),'text',28),col('退货ID','return_id','text',38),col('结算ID','settlement_id','text',38),col('结算名称',r=>title(r.settlement_id),'text',28),col('状态',r=>label(r.state)),col('申请抵减（元）','amount','money'),col('有效抵减（元）',r=>r.state==='approved'?r.amount:0,'money'),col('已退款（元）','refundedAmount','money'),col('当前可退款（元）','availableRefundAmount','money'),...supplierTail],supplier.credits);
  if(supplier.refunds.length)add('供应商退款',[col('退款ID','id','text',38),col('采购ID','purchase_id','text',38),col('抵减ID','credit_id','text',38),col('原付款ID','cost_id','text',38),col('原付款名称',r=>title(r.cost_id),'text',28),col('状态',r=>label(r.state)),col('登记退款（元）','amount','money'),col('有效到账（元）',r=>r.state==='approved'?r.amount:0,'money'),col('到账日期','occurred_date','date'),col('到账凭据','voucher','text',28),...supplierTail],supplier.refunds);
  add('库存流水',[col('流水ID','id','text',38),col('材料ID','material_id','text',38),col('材料名称',r=>title(r.material_id),'text',28),col('单位',r=>byId.get(r.material_id)?.data.unit||'','text',12),col('业务',r=>label(r.kind),'text',14),col('原数量','quantity','quantity'),col('原始库存影响',r=>(r.kind==='issue'?-1:1)*r.quantity,'quantity'),col('批准冲销调整',r=>r.reversed?(r.kind==='issue'?1:-1)*r.quantity:0,'quantity'),col('当前有效库存影响',r=>r.reversed?0:(r.kind==='issue'?-1:1)*r.quantity,'quantity'),col('已冲销',r=>yes(r.reversed),'text',12),col('关联原单ID','reference_id','text',38),col('采购行ID','purchase_line_id','text',38),col('收货批次ID','receipt_batch_id','text',38),col('关联原单名称',r=>r.kind==='return'?'原领料流水':title(r.reference_id),'text',28),col('发生时间（北京时间）','created_at','time',23),col('依据 / 备注','note','text',48)],stock);
  add('材料余额',[...common,col('材料编号','code'),col('规格','specification','text',28),col('单位','unit','text',12),col('仓库','warehouse','text',24),col('当前净库存',r=>balances[r.id],'quantity'),...tail],of('materials').map(base));
  const decisions=[...corrections.map(r=>({...r,decisionType:'业务撤销',targetType:r.target_kind})),...reversals.map(r=>({...r,decisionType:'全额冲销',targetType:r.target_type==='cost'?'costs':'stock'}))].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||a.id.localeCompare(b.id)).map(r=>{
    const target=byId.get(r.target_id),movement=stockById.get(r.target_id),snapshot=r.snapshot||{},contractId=target?.data.contractId||byId.get(target?.data.settlementId)?.data.contractId||byId.get(movement?.reference_id)?.data.contractId||'';
    return {...r,title:target?.data.title||snapshot.title||'',contractId,contractTitle:title(contractId),sourceAmount:snapshot.amount??target?.data.amount??0,amountDelta:r.state!=='approved'?0:r.targetType==='stock'?0:r.targetType==='variations'?(snapshot.data?.changeType==='decrease'?1:-1)*(snapshot.amount??0):-(snapshot.amount??0),quantityDelta:r.state==='approved'&&r.targetType==='stock'?(snapshot.quantityDelta??0):0};
  });
  add('纠错与冲销',[col('办理ID','id','text',38),col('办理类型','decisionType','text',14),col('原业务类型',r=>label(r.targetType),'text',14),col('原单ID','target_id','text',38),col('原单名称','title','text',28),...contractRef,col('状态',r=>label(r.state),'text',14),col('原金额（元）','sourceAmount','money'),col('业务金额调整（元）','amountDelta','money'),col('库存数量调整','quantityDelta','quantity'),col('申请人','requester_name'),col('申请时间（北京时间）','created_at','time',23),col('申请原因','note','text',48),col('复核人','reviewer_name'),col('复核时间（北京时间）','reviewed_at','time',23),col('复核依据','review_note','text',48)],decisions);
  const subcontract=buildEngineeringSubcontractView({projectId:project.id,records:detail.subcontracts?.records||[],holdbacks:detail.subcontracts?.holdbacks||[],completions:detail.subcontracts?.completions||[],items,effectiveSettlement:effective,effectiveCost:effective});
  if(subcontract.records.length){
    const reviewColumns=[col('经办人','creator_name'),col('申请时间（北京时间）','created_at','time',23),col('复核人','reviewer_name'),col('复核依据','review_note','text',48)];
    add('分包保留金规则',[col('规则ID','id','text',38),col('合同ID',r=>r.data.contractId,'text',38),col('合同名称',r=>title(r.data.contractId),'text',28),col('冻结对方单位',r=>r.snapshot.contract.counterparty,'text',28),col('状态',r=>label(r.state)),col('保留比例（基点）',r=>r.data.retentionBps,'integer'),col('约定释放日期',r=>r.data.releaseDate,'date'),col('约定依据',r=>r.data.note,'text',48),...reviewColumns],subcontract.policies);
    const completedLines=subcontract.completions.flatMap(c=>c.snapshot.lines.map((l,i)=>({...l,measurementId:c.measurement_id,effective:c.effective,index:i+1})));
    add('分包签认施工部位',[col('原计量ID','measurementId','text',38),col('原计量名称',r=>title(r.measurementId),'text',28),col('签认是否有效',r=>yes(r.effective)),col('行号','index','integer'),col('任务ID','taskId','text',38),col('施工部位ID','wbsId','text',38),col('冻结施工部位路径',r=>r.path.map(n=>n.title).join(' / '),'text',38),col('单位','unit'),col('原签认数量','quantity','quantity'),col('原签认金额（元）','amount','money')],completedLines);
    add('分包保留金台账',[col('原结算ID','settlementId','text',38),col('结算名称','title','text',28),col('原合同ID','contractId','text',38),col('原计量ID','measurementId','text',38),col('对方单位','counterparty','text',28),col('原结算金额（元）','originalGross','money'),col('有效结算金额（元）','gross','money'),col('原扣留（元）','originalHeld','money'),col('已释放（元）','released','money'),col('未释放（元）','retained','money'),col('当前可付（元）','payable','money'),col('已付款净额（元）','paid','money'),col('可付未付（元）','unpaid','money'),col('应付日期','dueDate','date'),col('约定释放日期','releaseDate','date'),col('结算已撤销',r=>yes(r.voided))],subcontract.settlements);
    add('保留金释放历史',[col('释放ID','id','text',38),col('原结算ID',r=>r.data.settlementId,'text',38),col('状态',r=>label(r.state)),col('原申请金额（元）',r=>r.data.amount,'money'),col('有效释放额度（元）','effectiveAmount','money'),col('释放已撤销',r=>yes(r.voided)),col('释放日期',r=>r.data.effectiveDate,'date'),col('验收凭据',r=>r.data.voucher,'text',28),col('申请依据',r=>r.data.note,'text',48),...reviewColumns],subcontract.releases);
    add('保留金撤销历史',[col('撤销ID','id','text',38),col('原释放ID',r=>r.data.releaseId,'text',38),col('状态',r=>label(r.state)),col('原释放金额（元）',r=>r.snapshot.amount,'money'),col('释放额度调整（元）',r=>r.state==='approved'?-r.snapshot.amount:0,'money'),col('申请依据',r=>r.data.note,'text',48),...reviewColumns],subcontract.voids);
  }
  const construction=detail.wbs||{nodes:[],links:[]};
  const costView=buildEngineeringCostView({projectId:project.id,...construction,records:detail.costControl?.records||[],items,stock});
  if(construction.nodes.length){
    const nodeMap=new Map(construction.nodes.map(r=>[r.id,r]));
    add('施工部位',[col('部位ID','id','text',38),col('编号',r=>r.data.code),col('名称',r=>r.data.title,'text',28),col('类型',r=>({section:'标段',unit:'单位工程',division:'分部工程',item:'分项工程',area:'工区'}[r.data.type])),col('上级部位ID',r=>r.data.parentId,'text',38),col('上级部位名称',r=>nodeMap.get(r.data.parentId)?.data.title||'项目直属','text',28),col('版本','version','integer'),col('说明',r=>r.data.note,'text',48)],construction.nodes);
    add('任务施工归属',[col('任务ID','task_id','text',38),col('任务名称',r=>title(r.task_id),'text',28),col('原部位桩号',r=>byId.get(r.task_id)?.data.location||'','text',28),col('部位ID','node_id','text',38),col('部位名称',r=>nodeMap.get(r.node_id)?.data.title||'','text',28),col('归属版本','version','integer'),col('归属依据','note','text',48)],construction.links);
  }
  if(costView.records.length){
    const costPath=r=>r.snapshot.path?.map(p=>p.title).join(' / ')||'';
    add('目标成本版本',[col('成本方案ID','id','text',38),col('方案名称',r=>r.data.title,'text',28),col('状态',r=>label(r.state)),col('办理版本','version','integer'),col('批准序号',r=>r.approved_seq??0,'integer'),col('当前批准版本',r=>yes(r.id===costView.currentPlanId)),col('上一成本基线ID',r=>r.snapshot.basePlanId||'','text',38),col('原核定预算（元）',r=>r.snapshot.projectBudget,'money'),col('方案目标成本（元）',r=>r.snapshot.total,'money'),col('编制人','creator_name'),col('编制依据',r=>r.data.note,'text',48),col('复核人','reviewer_name'),col('复核依据','review_note','text',48)],costView.plans);
    const budgetLines=costView.plans.flatMap(r=>r.snapshot.lines.map((l,i)=>({...l,planId:r.id,planTitle:r.data.title,state:r.state,index:i+1,current:r.id===costView.currentPlanId})));
    add('目标成本明细',[col('方案ID','planId','text',38),col('方案名称','planTitle','text',28),col('状态',r=>label(r.state)),col('当前成本基线',r=>yes(r.current)),col('行号','index','integer'),col('部位ID','wbsId','text',38),col('冻结部位路径',r=>r.path.map(p=>p.title).join(' / '),'text',38),col('任务ID','taskId','text',38),col('冻结任务名称',r=>r.task?.title||'','text',28),col('成本类别',r=>label(r.category)),col('材料ID','materialId','text',38),col('成本项目','title','text',28),col('单位','unit'),col('目标数量','quantity','quantity'),col('目标成本单价（元）','unitPrice','money'),col('目标成本金额（元）','amount','money'),col('工程清单版本ID','boqRevisionId','text',38),col('工程清单条目ID','boqItemId','text',38)],budgetLines);
    const actual=(r,k,kind)=>r[k]===null?{value:'未接入',kind:'text'}:{value:r[k],kind};
    add('成本耗用对照',[col('部位ID','wbsId','text',38),col('部位路径',r=>r.path.map(p=>p.title).join(' / '),'text',38),col('目标归属任务ID','taskId','text',38),col('目标归属任务',r=>r.taskId?title(r.taskId):'部位共享目标','text',28),col('成本类别',r=>label(r.category)),col('材料ID','materialId','text',38),col('单位','unit'),col('目标数量','targetQuantity','quantity'),col('目标成本（元）','targetAmount','money'),col('已确认耗用数量',r=>actual(r,'actualQuantity','quantity')),col('已确认成本（元）',r=>actual(r,'actualAmount','money')),col('目标数量差额',r=>actual(r,'quantityVariance','quantity')),col('目标成本差额（元）',r=>actual(r,'amountVariance','money'))],costView.comparison);
    add('材料耗用确认',[col('确认ID','id','text',38),col('状态',r=>label(r.state)),col('已独立撤销',r=>yes(r.voided)),col('部位ID',r=>r.data.wbsId,'text',38),col('冻结部位路径',costPath,'text',38),col('任务ID',r=>r.data.taskId,'text',38),col('冻结任务',r=>r.snapshot.task.title,'text',28),col('原领料ID',r=>r.data.stockId,'text',38),col('材料',r=>r.snapshot.material.title,'text',28),col('单位',r=>r.snapshot.material.unit),col('原确认数量',r=>r.data.quantity,'quantity'),col('有效确认数量','effectiveQuantity','quantity'),col('确认成本单价（元）',r=>r.data.unitPrice,'money'),col('原确认成本（元）',r=>r.snapshot.amount,'money'),col('有效确认成本（元）','effectiveAmount','money'),col('耗用日期',r=>r.data.effectiveDate,'date'),col('计价凭据',r=>r.data.voucher,'text',28),col('计价方法',r=>'凭据确认单价，独立复核'),col('经办人','creator_name'),col('确认依据',r=>r.data.note,'text',48),col('复核人','reviewer_name'),col('复核依据','review_note','text',48)],costView.consumptions);
    add('耗用撤销历史',[col('撤销办理ID','id','text',38),col('原耗用确认ID',r=>r.data.consumptionId,'text',38),col('状态',r=>label(r.state)),col('原确认成本（元）',r=>r.snapshot.amount,'money'),col('有效成本调整（元）',r=>r.state==='approved'?-r.snapshot.amount:0,'money'),col('申请人','creator_name'),col('撤销依据',r=>r.data.note,'text',48),col('复核人','reviewer_name'),col('复核依据','review_note','text',48)],costView.voids);
  }
  if(boq.revisions.length){
    const currentByContract=new Map(boq.contracts.map(row=>[row.contractId,row.currentRevisionId]));
    const balances=boq.contracts.flatMap(row=>row.items.map(item=>({...item,contractId:row.contractId,contractTitle:title(row.contractId),revisionId:row.currentRevisionId})));
    const revisionRows=boq.revisions.map(row=>({...row,contractId:row.contract_id,contractTitle:title(row.contract_id),variationTitle:title(row.variation_id),current:currentByContract.get(row.contract_id)===row.id}));
    const revisionLines=revisionRows.flatMap(row=>row.lines.map((item,index)=>({...item,revisionId:row.id,revisionTitle:row.title,contractId:row.contractId,contractTitle:row.contractTitle,state:row.state,voided:row.voided,current:row.current,index:index+1})));
    const scope=[col('清单条目ID','id','text',38),col('清单编码','code'),col('项目名称','name','text',28),col('部位','location','text',28),col('单位','unit','text',12),col('清单数量','quantity','quantity'),col('单价（元）','unitPrice','money'),col('清单金额（元）','amount','money')];
    add('清单余额',[...contractRef,col('当前清单版本ID','revisionId','text',38),...scope,col('有效已批计量数量','usedQuantity','quantity'),col('有效已批计量金额（元）','usedAmount','money'),col('剩余可计量数量','remainingQuantity','quantity'),col('剩余可计量金额（元）','remainingAmount','money')],balances);
    add('清单版本',[col('清单版本ID','id','text',38),col('清单版本名称','title','text',28),...contractRef,col('状态',row=>label(row.state)),col('版本号','version','integer',10),col('批准序号','approved_seq','text',12),col('当前有效版本',row=>yes(row.current),'text',16),col('配套签证已撤销',row=>yes(row.voided),'text',18),col('基础清单版本ID','base_revision_id','text',38),col('原版本总额（元）','total','money'),col('修订增减额（元）','delta','money'),col('配套签证ID','variation_id','text',38),col('配套签证名称','variationTitle','text',28),col('创建人','creator_name'),col('最后编辑人','editor_name'),col('创建时间（北京时间）','created_at','time',23),col('更新时间（北京时间）','updated_at','time',23),col('提交时间（北京时间）','submitted_at','time',23),col('复核人','reviewer_name'),col('复核时间（北京时间）','reviewed_at','time',23),col('编制依据','note','text',48),col('复核依据','review_note','text',48)],revisionRows);
    add('清单版本明细',[col('清单版本ID','revisionId','text',38),col('清单版本名称','revisionTitle','text',28),...contractRef,col('状态',row=>label(row.state)),col('当前有效版本',row=>yes(row.current),'text',16),col('配套签证已撤销',row=>yes(row.voided),'text',18),col('行号','index','integer',10),...scope],revisionLines);
  }
  if(taskValues){
    const taskRows=[...taskValues.tasks,{taskId:'',title:'未归集任务',location:'',state:'',progress:null,startDate:'',dueDate:'',incomeAmount:taskValues.summary.income.unassignedAmount,expenseAmount:taskValues.summary.expense.unassignedAmount,sourceCount:taskValues.unassigned.length,effectiveSourceCount:taskValues.unassigned.filter(row=>row.state==='approved'&&!row.voided).length}];
    add('任务产值',[col('任务ID','taskId','text',38),col('当前任务名称','title','text',28),col('当前部位','location','text',28),col('当前状态',r=>label(r.state),'text',14),col('计划开始','startDate','date',14),col('计划完成','dueDate','date',14),col('人工完成比例（%）',r=>r.progress===null?'':r.progress,'text',20),col('收入合同已批计量（元）','incomeAmount','money',26),col('支出合同已批计量（元）','expenseAmount','money',26),col('历史来源行数','sourceCount','integer',18),col('有效已批来源行数','effectiveSourceCount','integer',22)],taskRows);
    const groups=[...taskValues.tasks.flatMap(task=>task.quantityGroups.map(group=>({...group,taskId:task.taskId,taskTitle:task.title}))),...taskValues.unassignedQuantityGroups.map(group=>({...group,taskId:'',taskTitle:'未归集任务'}))];
    add('任务工程量',[col('任务ID','taskId','text',38),col('当前任务名称','taskTitle','text',28),col('合同方向',r=>label(r.direction),'text',14),...contractRef,col('清单条目ID','boqItemId','text',38),col('计量项目','name','text',28),col('部位','location','text',28),col('单位','unit','text',12),col('有效已批数量','quantity','quantity',18),col('有效已批计量（元）','amount','money',24),col('有效来源行数','sourceCount','integer',18)],groups);
  }
  if(detail.valuePlans?.plans?.length){
    // Derive comparisons from immutable plan sources and the same ledger snapshot.
    // A cached client comparison, selected history or asOf never drives an export.
    const context={project,items,boq,plans:detail.valuePlans.plans,baselines:detail.valuePlans.baselines};
    const asOf=new Date(Date.parse(exportedAt)+8*3600*1000).toISOString().slice(0,10);
    const view=buildEngineeringValuePlansView(context,{asOf,observedAt:exportedAt});
    const currentIds=new Set(view.contracts.map(row=>row.currentPlanId).filter(Boolean));
    const meta=view.plans.map(row=>({...row,contractId:row.contract_id,contractTitle:row.snapshot.contractTitle,direction:row.snapshot.contractDirection,current:currentIds.has(row.id),driftText:row.drift.reasons.map(reason=>reason.reason+(reason.taskId?' ['+reason.taskId+']':'')).join('\n')}));
    const planRef=[col('目标方案ID','planId','text',38),col('目标名称','planTitle','text',28),...contractRef,col('合同方向',row=>label(row.direction),'text',14)];
    const allocationRef=[col('清单条目ID','boqItemId','text',38),col('清单编码','code'),col('项目名称','name','text',28),col('清单部位','location','text',28),col('单位','unit','text',12),col('任务ID','taskId','text',38),col('冻结任务名称','taskTitle','text',28),col('冻结任务部位','taskLocation','text',28)];
    add('目标版本',[col('目标方案ID','id','text',38),col('目标名称','title','text',28),...contractRef,col('合同方向',row=>label(row.direction),'text',14),col('状态',row=>label(row.state),'text',14),col('版本号','version','integer',10),col('批准序号','approved_seq','text',12),col('当前已批目标',row=>yes(row.current),'text',18),col('清单版本ID','boq_revision_id','text',38),col('日期基线ID','schedule_baseline_id','text',38),col('清单目标额（元）',row=>row.snapshot.totalAmount,'money',24),col('已分配目标额（元）',row=>row.snapshot.allocatedAmount,'money',26),col('待分配金额（元）',row=>row.snapshot.remainingAmount,'money',24),col('当前已偏离来源',row=>yes(row.drift.changed),'text',18),col('来源变化说明','driftText','text',64),col('创建人','creator_name'),col('创建时间（北京时间）','created_at','time',23),col('提交时间（北京时间）','submitted_at','time',23),col('复核人','reviewer_name'),col('复核时间（北京时间）','reviewed_at','time',23),col('编制依据','note','text',48),col('复核依据','review_note','text',48)],meta);
    const allocated=meta.flatMap(row=>row.snapshot.lines.map(line=>({...line,planId:row.id,planTitle:row.title,contractId:row.contract_id,contractTitle:row.contractTitle,direction:row.direction,state:row.state,current:row.current})));
    add('目标分配',[...planRef,col('方案状态',row=>label(row.state),'text',14),col('当前已批目标',row=>yes(row.current),'text',18),...allocationRef,col('冻结开始','startDate','date',14),col('冻结完成','dueDate','date',14),col('目标工程量','quantity','quantity',18),col('冻结单价（元）','unitPrice','money',22),col('分摊目标金额（元）','amount','money',26)],allocated);
    const comparisons=[],outside=[];
    for(const contract of view.contracts.filter(row=>row.currentPlanId)){
      const current=buildEngineeringValuePlansView(context,{planId:contract.currentPlanId,asOf,observedAt:exportedAt});
      const row=current.selectedPlan,common={planId:row.id,planTitle:row.title,contractId:row.contract_id,contractTitle:row.snapshot.contractTitle,direction:row.snapshot.contractDirection,asOf,observedAt:exportedAt,driftText:row.drift.reasons.map(reason=>reason.reason).join('；')};
      comparisons.push(...current.comparison.lines.map(line=>({...line,...common})));
      outside.push(...current.comparison.outside.map(source=>({...source,...common})));
    }
    add('目标对比',[...planRef,...allocationRef,col('冻结开始','startDate','date',14),col('冻结完成','dueDate','date',14),col('计划比较日','asOf','date',16),col('实际观测时间（北京时间）','observedAt','time',28),col('目标数量','targetQuantity','quantity',18),col('截至比较日计划数量','plannedQuantity','quantity',24),col('最新有效已批数量','actualQuantity','quantity',24),col('实际减目标数量','quantityVariance','quantity',24),col('实际减计划数量','plannedQuantityVariance','quantity',24),col('目标金额（元）','targetAmount','money',22),col('截至比较日计划金额（元）','plannedAmount','money',30),col('最新有效已批金额（元）','actualAmount','money',28),col('实际减目标金额（元）','amountVariance','money',28),col('实际减计划金额（元）','plannedAmountVariance','money',28),col('有效来源行数','sourceCount','integer',18),col('来源变化说明','driftText','text',64)],comparisons);
    const outsideLabels={unassigned:'计量未归属任务',free:'自由计量未引用清单',item_not_in_plan:'清单条目不在原目标内',task_not_in_plan:'条目与任务组合不在原目标内'};
    add('目标外计量',[...planRef,col('计量ID','measurementId','text',38),col('计量名称','measurementTitle','text',28),col('计量编号','measurementCode'),col('原行号','lineIndex','integer',10),col('目标外原因',row=>outsideLabels[row.outsideReason]||row.outsideReason,'text',40),col('清单条目ID','boqItemId','text',38),col('清单版本ID','boqRevisionId','text',38),col('任务ID','taskId','text',38),col('保存时任务名称','taskTitle','text',28),col('计量项目','name','text',28),col('计量部位','location','text',28),col('单位','unit','text',12),col('有效已批数量','effectiveQuantity','quantity',20),col('有效已批金额（元）','effectiveAmount','money',26),col('实际观测时间（北京时间）','observedAt','time',28)],outside);
    sheets.find(sheet=>sheet.name==='口径说明').records.push({item:'目标产值基线',description:'有目标方案历史时附目标版本、目标分配、目标对比、目标外计量。前两表保留全历史，不能跨版本加总；后两表按各合同当前已批准目标重算，收入/支出分别查看。目标数量与金额在冻结任务日期内按自然日线性均摊，计划比较日为导出当天（上海）。实际为导出时最新有效已批计量，不表示过去某日实际；源清单或计划变化仍保留原目标并提示。数量仅可比较同条目与单位。目标外计量不计入目标内实际，和目标内实际相加才是该合同全部有效计量。分摊目标与原计量的尾差可能落在不同任务，不重算原金额。'});
  }
  if(detail.replacements?.versions?.length){
    const view=buildEngineeringReplacementsView({project,items,corrections,boq,versions:detail.replacements.versions},{observedAt:exportedAt});
    const resolution=value=>value==='replaced'?'已有正确单据':'无需补单';
    const statusLabels={effective:'当前有效',voided:'已撤销业务影响',superseded:'已被后续清单替代',not_approved:'尚未批准',missing:'来源缺失'};
    const versions=view.versions.map(row=>({...row,contractId:row.contract_id,contractTitle:row.snapshot.source.contractTitle}));
    const refs=[col('关联版本ID','relationId','text',38),col('来源纠错ID','sourceCorrectionId','text',38),col('原单ID','sourceItemId','text',38),col('原单名称','sourceTitle','text',28),...contractRef];
    const metadata=row=>({relationId:row.id,sourceCorrectionId:row.source_correction_id,sourceItemId:row.snapshot.source.item.id,sourceTitle:row.snapshot.source.item.title,contractId:row.contract_id,contractTitle:row.snapshot.source.contractTitle});
    add('更正关联',[...refs,col('原业务类型',row=>label(row.snapshot.source.item.kind),'text',16),col('办理结论',row=>resolution(row.resolution),'text',20),col('关联状态',row=>label(row.state),'text',14),col('当前已批关联',row=>yes(row.isCurrent),'text',20),col('记录版本号','version','integer',14),col('批准序号','approved_seq','text',14),col('正确依据数',row=>row.snapshot.targets.length,'integer',16),col('原单金额（元）',row=>row.snapshot.source.item.amount,'money',22),col('纠错批准时间（北京时间）',row=>row.snapshot.source.correctedAt,'time',28),col('纠错复核人',row=>row.snapshot.source.correctedName),col('关联申请人','requester_name'),col('关联申请时间（北京时间）','created_at','time',28),col('关联依据','note','text',48),col('关联复核人','reviewer_name'),col('关联复核时间（北京时间）','reviewed_at','time',28),col('关联复核依据','review_note','text',48)],versions.map(row=>({...row,...metadata(row)})));
    const targets=versions.flatMap(row=>row.snapshot.targets.map((target,index)=>({...metadata(row),state:row.state,isCurrent:row.isCurrent,target,status:row.targetStatuses[index]})));
    add('更正替代明细',[...refs,col('关联状态',row=>label(row.state),'text',14),col('当前已批关联',row=>yes(row.isCurrent),'text',20),col('正确依据类型',row=>row.target.type==='boq'?'清单版本':label(row.target.kind),'text',18),col('正确依据ID',row=>row.target.id,'text',38),col('正确依据名称',row=>row.target.title,'text',28),col('正确依据编号',row=>row.target.code),col('冻结依据版本',row=>row.target.version,'integer',18),col('单据金额（元）',row=>row.target.type==='item'?money(row.target.amount):'','text',22),col('签证方向',row=>row.target.changeType?label(row.target.changeType):'','text',16),col('清单修订增减额（元）',row=>row.target.type==='boq'?money(row.target.delta):'','text',28),col('清单版本总额（元）',row=>row.target.type==='boq'?money(row.target.total):'','text',26),col('当前依据状态',row=>statusLabels[row.status.status]||row.status.status,'text',28),col('后续纠错ID',row=>row.status.sourceCorrectionId||'','text',38),col('依据创建人',row=>row.target.createdName),col('依据最后编辑人',row=>row.target.editedName),col('依据批准人',row=>row.target.approvedName),col('依据批准时间（北京时间）',row=>row.target.approvedAt,'time',28),col('状态观测时间（北京时间）',()=>exportedAt,'time',28)],targets);
    sheets.find(sheet=>sheet.name==='口径说明').records.push({item:'纠错后替代办理追溯',description:'更正关联与更正替代明细仅记录原纠错单到正确依据的追溯，不产生新的业务金额或冲销。一张原单可关联多张正确单据，多张原单也可引用同一正确单据；明细金额不能累加为成本。全部版本保留，当前已批关联按批准序号重算，待审版本不替换原结论。无需补单的版本没有替代明细。正确依据后来被撤销或清单被替代时，保留冻结记录并标明当前状态及后续纠错ID。清单总额是整版范围，修订增减额才是该版增减口径，均不得作为新增计量或结算。'});
  }
  return buildEngineeringSheets(sheets,{title:project.data.name+' 经营台账',exportedAt});
}

/** Shared passive XLSX packaging; business callers own their explicit projections. */
export function buildEngineeringSheets(sheets,{title,exportedAt=new Date().toISOString()}){
  if(!sheets.length||sheets.some(s=>s.records.length>MAX_SHEET_ROWS)||sheets.reduce((n,s)=>n+s.records.length,0)>MAX_TOTAL_ROWS)fail(413,'导出超过单表 20000 行或全册 50000 行，未生成截断文件');
  const files={},addXml=(name,content)=>{files[name]=strToU8(content);};
  addXml('[Content_Types].xml',XML+`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  addXml('_rels/.rels',XML+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  addXml('xl/workbook.xml',XML+`<workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((s,i)=>`<sheet name="${xml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`);
  addXml('xl/_rels/workbook.xml.rels',XML+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="${REL}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length+1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`);
  addXml('xl/styles.xml',styles);
  addXml('docProps/core.xml',XML+`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>智慧工程</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${xml(exportedAt)}</dcterms:created></cp:coreProperties>`);
  addXml('docProps/app.xml',XML+'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>智慧工程</Application></Properties>');
  let size=Object.values(files).reduce((n,bytes)=>n+bytes.length,0);
  for(const [index,sheet] of sheets.entries()){const content=worksheet(sheet);size+=Buffer.byteLength(content);if(size>MAX_XML_BYTES)fail(413,'经营导出解压内容超过64 MiB，未生成不完整文件');addXml(`xl/worksheets/sheet${index+1}.xml`,content);}
  const result=Buffer.from(zipSync(files,{level:6}));
  if(result.length>32*1024*1024)fail(413,'经营导出文件超过32 MiB，无法在网页及安卓安全下载');
  return result;
}

export function mountEngineeringExport(app,{base,authorize,store,access,financial,readProjectDetail}){
  app.get(base+'/projects/:pid/export',authorize,(req,res)=>{
    const snapshot=store.transaction(()=>{const {p,role}=access(req);if(!financial(role))fail(403,'仅项目经理、财务或管理员可以导出经营台账');return {detail:readProjectDetail(req.actor,p,role),exportedAt:new Date().toISOString()};});
    const bytes=buildEngineeringWorkbook(snapshot.detail,{exportedAt:snapshot.exportedAt});
    const stem=safeText(snapshot.detail.project.data.code||'工程').replace(/[\\/:*?"<>|\r\n]/g,'_').slice(0,60)||'工程';
    const localDate=new Date(Date.parse(snapshot.exportedAt)+8*3600*1000).toISOString().slice(0,10);
    const filename=stem+'_经营台账_'+localDate+'.xlsx';
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="engineering-ledger.xlsx"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())}`);
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Length',String(bytes.length));res.send(bytes);
  });
}
