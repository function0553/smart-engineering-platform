import type { SubmissionReceipt } from './report-cloud';

export type FilingProject = { id: string; name: string; canCreate: boolean; nodes: { id: string; data: { code: string; title: string; parentId?: string } }[] };
export type DailyFilingJournal = {
  status: 'pending' | 'confirmed' | 'confirmed_restricted';
  receipt: SubmissionReceipt;
  id?: string;
  body: { requestId: string; data: { category: 'construction_daily'; title: string; recordDate: string; wbsId: string; taskId: string; note: string; dailyReportId: string } };
};
export type FilingRequest = <T>(path: string, method?: string, data?: unknown) => Promise<T>;
// This is the existing identity. Never migrate or discard an uncertain request.
export const filingKey = (scope: string, userId: string, projectId: string, receiptId: string) => 'site:daily-filing:v1:' + JSON.stringify([scope, userId, projectId, receiptId]);

export function readDailyFilingJournal(raw: string | null, receipt: SubmissionReceipt): DailyFilingJournal | null {
  if (!raw) return null;
  const value = JSON.parse(raw), body = value?.body || value;
  if (body?.data?.dailyReportId !== receipt.id || body?.data?.category !== 'construction_daily'
    || typeof body?.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.requestId)
    || typeof body?.data?.wbsId !== 'string' || !body.data.wbsId
    || (value.status !== undefined && !['pending','confirmed','confirmed_restricted'].includes(value.status))
    || (value.status === 'confirmed' && (typeof value.id !== 'string' || !value.id))) throw Error('原归入凭据无法读取，请保留本机数据并联系管理员核对。');
  return { body, receipt, status: value.status || 'pending', ...(value.id ? { id: value.id } : {}) };
}

export function createDailyFilingJournal(receipt: SubmissionReceipt, project: FilingProject, wbsId: string): DailyFilingJournal {
  if (receipt.projectId && receipt.projectId !== project.id) throw Error('日报属于其他项目，已阻止跨项目归入。');
  if (!project.canCreate || !project.nodes.some(node => node.id === wbsId)) throw Error('请先选择当前授权范围内的施工部位。');
  return { status: 'pending', receipt, body: { requestId: crypto.randomUUID(), data: {
    category: 'construction_daily', title: ('施工日报 · ' + (receipt.sectionName || receipt.projectName) + ' · ' + receipt.reportDate).slice(0, 160),
    recordDate: receipt.reportDate, wbsId, taskId: '', note: '由在线日报归入，保留原Word和原图。', dailyReportId: receipt.id,
  } } };
}

/** Persist before any write and resolve the original request before retrying. No approval is submitted here. */
export async function confirmDailyFiling(project: FilingProject, receipt: SubmissionReceipt, journal: DailyFilingJournal,
  request: FilingRequest, retain: (journal: DailyFilingJournal) => void): Promise<DailyFilingJournal> {
  if (receipt.projectId && receipt.projectId !== project.id) throw Error('日报属于其他项目，已阻止跨项目归入。');
  if (journal.body.data.dailyReportId !== receipt.id) throw Error('归入凭据与日报不一致，原记录未改动。');
  retain(journal);
  const prefix = `/engineering/projects/${encodeURIComponent(project.id)}`;
  const result = await request<{ status: string; id?: string }>(`${prefix}/site-daily-filings/requests/${encodeURIComponent(journal.body.requestId)}?dailyReportId=${encodeURIComponent(receipt.id)}`);
  if (result.status === 'confirmed_restricted') {
    const {id:_id,...pending}=journal;
    const confirmed = { ...pending, status: 'confirmed_restricted' as const }; retain(confirmed); return confirmed;
  }
  let id = result.id;
  if (result.status === 'not_found') {
    if (!project.canCreate || !project.nodes.some(node => node.id === journal.body.data.wbsId)) throw Error('原施工部位权限已变化，尚不能确认归入结果。请保留原归入，联系项目管理员核对；不会改投其他部位。');
    id = (await request<{ id: string }>(`${prefix}/site-records`, 'POST', journal.body)).id;
  } else if (result.status !== 'confirmed') throw Error('归入结果尚未确认，请核对原办理。');
  if (!id) throw Error('保存凭据未确认，请重试原办理。');
  const confirmed = { ...journal, status: 'confirmed' as const, id }; retain(confirmed); return confirmed;
}

export function retainDailyFilingJournal(storage: Pick<Storage, 'setItem' | 'getItem'>, key: string, journal: DailyFilingJournal) {
  const raw = JSON.stringify(journal); storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw Error('原归入凭据未能保存在本机，请保持当前页面并重试。');
}

/** Web and native requests both release the screen after a timeout; the journal remains recoverable. */
export function timedDailyFilingRequest(transport: <T>(path: string, method?: string, data?: unknown, signal?: AbortSignal) => Promise<T>, timeoutMs = 90000): FilingRequest {
  return async <T>(path: string, method?: string, data?: unknown): Promise<T> => {
    const controller = new AbortController();
    const timeoutError = new Error('归入核对超时，原请求已保留。请重试原归入，系统会核对结果，不会重复创建。');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(timeoutError); }, timeoutMs); });
    try { return await Promise.race([transport<T>(path, method, data, controller.signal), expired]); }
    catch (error) { if (controller.signal.aborted) throw timeoutError; throw error; }
    finally { clearTimeout(timer); }
  };
}

export function readRetainedDailyFilings(scope:string,userId:string,projectId:string,sources:(()=>Pick<Storage,'length'|'key'|'getItem'>)[]){
 const rows:{receipt:SubmissionReceipt;key:string}[]=[],seen=new Set<string>();let warning='';
 const stores:Pick<Storage,'length'|'key'|'getItem'>[]=[];
 for(const source of sources){try{stores.push(source());}catch{warning='本机归入凭据暂时无法读取；服务器清单仍可查阅。归入前必须成功保留原请求。';}}
 for(const storage of stores){
  let length=0;try{length=storage.length;}catch{warning='本机归入凭据暂时无法读取；服务器清单仍可查阅。';continue;}
  for(let i=0;i<length;i++){
   let key:string|null;try{key=storage.key(i);}catch{warning='部分本机归入凭据暂时无法读取，请保留本机数据。';continue;}
   if(!key?.startsWith('site:daily-filing:v1:')||seen.has(key))continue;
   try{const ids=JSON.parse(key.slice('site:daily-filing:v1:'.length)),v=JSON.parse(storage.getItem(key)||'null'),body=v?.body||v;if(ids[0]!==scope||ids[1]!==userId||ids[2]!==projectId||body?.data?.dailyReportId!==ids[3]||!body?.requestId||v.status==='confirmed')continue;seen.add(key);rows.push({receipt:v.receipt||{id:ids[3],authorId:userId,authorName:'',projectName:body.data.title,region:'',reportDate:body.data.recordDate,number:'',photoCount:0,createdAt:'',documentSha256:''},key});}catch{warning='部分本机归入凭据无法读取，原记录保留；请联系管理员核对。';}
  }
 }
 return {rows,warning};
}
