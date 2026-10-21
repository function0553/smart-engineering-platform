export function siteWorkflow(record:any):string;
export function siteSaveStatus(value?:{record?:any;files?:number;pending?:boolean;pendingUploads?:number;items?:any[]}):string;
export function siteNextStep(detail:any):string;
export function permittedSiteNodes<T extends {id:string;data:{parentId?:string}}>(nodes:T[],permission?:any):T[];
export type SiteUnfinishedRow={key:string;recordId:string;title:string;count:number;serverCount:number;hasOperation:boolean;hasUpload:boolean};
export function readSiteUnfinishedQueues(storage:Pick<Storage,'length'|'key'|'getItem'>,scope:{namespace:string;backend:string;userId:string;projectId:string}):{recordId:string;title:string;count:number}[];
export function mergeSiteUnfinished(value?:{pending?:any;upload?:any;queues?:{recordId:string;title:string;count:number}[];serverRecords?:{recordId:string;title:string;count:number}[];liveQueue?:any}):SiteUnfinishedRow[];
