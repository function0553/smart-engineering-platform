export type SubmissionReceipt = { projectId?:string;id: string; authorId: string; authorName: string; projectName: string; region: string;
  sectionName?:string;sectionCount?:number;reportDate: string; number: string; photoCount: number; createdAt: string; documentSha256: string; replayed?: boolean };
export type CloudError = Error & { status?: number; fields?: { path: string; message: string }[] };
export async function cloudRequest<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/daily-report/submissions' + path, { signal, credentials: 'same-origin',
    ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Request': '1' }, body: JSON.stringify(data) }) });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || '汇报读取失败，请重试'), { status: response.status, fields: body.fields });
  return body as T;
}
const pending = new Map<string, { digest: string; id: string }>();
/** Keep only a content hash and retry ID locally; originals stay in the existing photo draft. */
export async function submissionKey(scope: string, data: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const key = 'daily-report:submission:' + scope;
  let previous = pending.get(key);
  try { const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved?.digest === digest && typeof saved.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(saved.id)) previous = saved;
  } catch { /* The in-memory key still protects retries when storage is unavailable. */ }
  const current = previous?.digest === digest ? previous : { digest, id: crypto.randomUUID() };
  pending.set(key, current);
  try { localStorage.setItem(key, JSON.stringify(current)); } catch { /* Report remains in the existing draft. */ }
  return current.id;
}

export const submissionRecoveryKey = (scope: string) => 'daily-report:pending:v1:' + scope;
export const submissionRecoveryPayloadKey = (scope: string, submissionId: string) => 'daily-report:pending-body:v1:' + JSON.stringify([scope,submissionId]);
type SubmissionData = { photos: { base64: string }[]; weatherAuto?: boolean; weather?: string; weatherInfo?: unknown };
export type FrozenSubmission<T> = { submissionId: string; digest: string; authoredDigest?: string; data?: T; projectId?: string; wbsId?: string; receipt?: SubmissionReceipt; newlyCreated?: boolean };
type SubmissionIndex = { schema: 1; scope: string; phase: 'pending'|'saved'|'rejected'; submissionId: string; digest: string; authoredDigest?: string; projectId?: string; wbsId?: string; receipt?: SubmissionReceipt };
const hashPayload = async (data: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)))), b => b.toString(16).padStart(2, '0')).join('');
function authoredContent<T extends SubmissionData>(data: T) {
  if (!data.weatherAuto) return data;
  // This comparison chooses an existing immutable snapshot. Its full original
  // payload (including fetchedAt) is always replayed, never a changed fingerprint.
  const { weather: _weather, weatherInfo: _weatherInfo, ...authored } = data;
  return authored;
}
export const sameAuthoredSubmissionContent = async <T extends SubmissionData>(a:T,b:T) => await hashPayload(authoredContent(a))===await hashPayload(authoredContent(b));
export const frozenSubmissionMatchesDraft = async <T extends SubmissionData>(attempt:FrozenSubmission<T>,data:T) => attempt.authoredDigest?await hashPayload(authoredContent(data))===attempt.authoredDigest:attempt.data?await sameAuthoredSubmissionContent(attempt.data,data):false;

/** Separate frozen request storage: never overwrite or migrate the editable draft. */
export function createSubmissionRecovery<T extends SubmissionData>(scope: string, projectId: string | undefined,
  storage: Pick<Storage,'getItem'|'setItem'>, payloads: (submissionId:string) => { load: () => Promise<T|null>; save: (data:T) => Promise<void> }) {
  const key = submissionRecoveryKey(scope);
  function index(): SubmissionIndex|null {
    const raw=storage.getItem(key); if(!raw)return null;
    const row=JSON.parse(raw);
    if(row?.schema!==1||row.scope!==scope||row.projectId!==projectId||!['pending','saved','rejected'].includes(row.phase)
      ||typeof row.digest!=='string'||!/^[a-f0-9]{64}$/.test(row.digest)||typeof row.submissionId!=='string'||!/^[a-f0-9-]{36}$/i.test(row.submissionId)
      ||row.receipt&&(!row.receipt.id||row.receipt.projectId&&row.receipt.projectId!==projectId))throw Error('上次日报保存凭据无法读取，已阻止覆盖。请保留本机草稿并联系管理员核对。');
    return row;
  }
  function retain(row: SubmissionIndex) {const raw=JSON.stringify(row);storage.setItem(key,raw);if(storage.getItem(key)!==raw)throw Error('日报保存凭据未能保存在本机，尚未发送新保存请求。');}
  async function load(): Promise<FrozenSubmission<T>|null> {
    const row=index();if(!row||row.phase==='rejected')return null;
    let data:T|null=null;try{data=await payloads(row.submissionId).load();if(data&&await hashPayload(data)!==row.digest)data=null;}catch{/* A known server receipt remains usable even if its local snapshot is unreadable. */}
    if(!data&&!row.receipt)throw Error('上次日报保存原件暂不可读，已阻止改用新内容重试。请保留本机草稿并恢复原保存凭据。');
    return {submissionId:row.submissionId,digest:row.digest,authoredDigest:row.authoredDigest,...(data?{data}:{}),projectId:row.projectId,wbsId:row.wbsId,...(row.receipt?{receipt:row.receipt}:{})};
  }
  async function prepareOnce(data:T,wbsId?:string): Promise<FrozenSubmission<T>> {
    const old=await load();
    if(old&&(!old.receipt||await frozenSubmissionMatchesDraft(old,data)))return old;
    const snapshot=JSON.parse(JSON.stringify(data)) as T;
    const submissionId=await submissionKey(scope,snapshot),digest=await hashPayload(snapshot),authoredDigest=await hashPayload(authoredContent(snapshot));
    await payloads(submissionId).save(snapshot);
    retain({schema:1,scope,phase:'pending',submissionId,digest,authoredDigest,...(projectId?{projectId}:{}),...(wbsId?{wbsId}:{})});
    return {submissionId,digest,authoredDigest,data:snapshot,projectId,wbsId,newlyCreated:true};
  }
  let preparing:Promise<FrozenSubmission<T>>|undefined;
  async function prepare(data:T,wbsId?:string):Promise<FrozenSubmission<T>>{
    if(preparing)return preparing;
    const run=()=>prepareOnce(data,wbsId);
    const task=typeof navigator!=='undefined'&&navigator.locks?.request?navigator.locks.request('daily-report:pending-lock:'+scope,run):run();
    preparing=task;try{return await task;}finally{if(preparing===task)preparing=undefined;}
  }
  function saved(attempt:FrozenSubmission<T>,receipt:SubmissionReceipt){
    const row=index();if(!row||row.submissionId!==attempt.submissionId||row.digest!==attempt.digest)throw Error('原日报保存凭据已变化，请保留服务器回执并核对原保存。');
    retain({...row,phase:'saved',receipt});
  }
  function rejected(attempt:FrozenSubmission<T>){
    // Only a first, definitive validation rejection permits editing this request.
    // A replay can have been committed previously; never discard its identity.
    if(!attempt.newlyCreated)return;
    const row=index();if(row?.submissionId===attempt.submissionId&&row.phase==='pending')retain({...row,phase:'rejected'});
  }
  return {load,prepare,saved,rejected};
}
