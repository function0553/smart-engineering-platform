export type SiteUploadPhase='queued'|'hashing'|'uploading'|'verifying'|'saved'|'paused'|'failed'|'needs-file';
export type SiteUploadItem={key:string;name:string;size:number;lastModified:number;stepId:string;phase:SiteUploadPhase;bytes:number;sha256:string;fileId:string;uploadId:string;attemptId:string|null;serverAttempted:boolean;fileAvailable:boolean;error:string;awaitingReadback:boolean};
export type SiteUploadState={schema:1;scopeKey:string;recordId:string;items:SiteUploadItem[]};
export type SiteUploadSelection={key:string;name:string;size:number;lastModified:number;stepId?:string};
export type SiteUploadEvent={scopeKey:string}&(
 {type:'select';files:SiteUploadSelection[]}|{type:'set-step';key:string;stepId:string}|{type:'clear-saved'}|{type:'discard';key:string}|{type:'reselect';key:string;name:string;size:number}|{type:'begin';key:string;attemptId:string}|{type:'validation-error';key:string;error:string}|
 {type:'start-request';key:string;attemptId:string}|{type:'rejected-before-start';key:string;attemptId:string;status:number;error:string}|{type:'progress';key:string;attemptId:string;phase:'hashing'|'uploading'|'verifying';bytes:number;sha256?:string;uploadId?:string}|
 {type:'pause';key:string;attemptId:string}|{type:'failure';key:string;attemptId:string;error:string;resultUnconfirmed?:boolean}|
 {type:'saved';key:string;attemptId:string;receipt:{id:string;state:string;sha256:string};readback:{recordId:string;file?:{id:string;name:string;byte_count:number;sha256:string;removed_at?:string|null;step_id?:string|null}}});
export function createSiteUploadState(scopeKey:string,recordId:string):SiteUploadState;
export function reduceSiteUploadState(state:SiteUploadState,event:SiteUploadEvent):SiteUploadState;
export function discardSiteUpload(state:SiteUploadState,key:string):SiteUploadState;
export function canDiscardSiteUpload(item:SiteUploadItem):boolean;
export function hasUnfinishedSiteUploads(state:SiteUploadState):boolean;
export function siteUploadCounts(state:SiteUploadState):{total:number;saved:number;remaining:number;failed:number;needsFile:number;active:number};
export function serializeSiteUploadState(state:SiteUploadState):string;
export function restoreSiteUploadState(raw:string|null,scopeKey:string,recordId:string):SiteUploadState;
