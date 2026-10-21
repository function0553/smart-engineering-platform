/** Stable draft identity is independent of editable section names. No old combined draft is rewritten. */
export function sectionDraftKey(scope:string,userId:string,sectionId:string,projectId=''){return projectId?'smart-office:daily-report:section:v2:'+JSON.stringify([scope,userId,projectId,sectionId]):'smart-office:daily-report:section:v1:'+JSON.stringify([scope,userId,sectionId]);}
export function sectionCatalogKey(scope:string,userId:string,projectId=''){return projectId?'smart-office:daily-report:areas:v2:'+JSON.stringify([scope,userId,projectId]):'smart-office:daily-report:areas:v1:'+JSON.stringify([scope,userId]);}
export function extractSectionReport<T extends {sections:{tomorrow:string}[];photos:unknown[];nextPlan:string;otherItems:string}>(source:T,index:number,photoIndices:number[],includeShared=false):T{
 if(!Number.isInteger(index)||!source.sections[index])throw Error('请选择有效施工片区');
 if(new Set(photoIndices).size!==photoIndices.length||photoIndices.some(i=>!Number.isInteger(i)||i<0||i>=source.photos.length))throw Error('请核对本片区照片');
 const report=structuredClone(source),section=report.sections[index];
 return {...report,sections:[section],photos:report.photos.filter((_,i)=>photoIndices.includes(i)),nextPlan:includeShared?report.nextPlan:section.tomorrow,otherItems:includeShared?report.otherItems:''};
}
export type SectionArea={id:string;name:string;kind:'pipeline'|'meter';designQuantity:string};
/** Recover valid stable IDs even if one editable label is malformed; never replace the whole catalog. */
export function restoreSectionAreas(value:unknown,fallback:SectionArea[]):SectionArea[]{
 if(!Array.isArray(value))return fallback;
 const rows:SectionArea[]=[],seen=new Set<string>();
 for(const a of value){if(!a||typeof a.id!=='string'||!/^(preset-[0-3]|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(a.id)||seen.has(a.id))continue;seen.add(a.id);rows.push({id:a.id,name:typeof a.name==='string'?a.name.slice(0,100):'未命名片区',kind:a.kind==='meter'?'meter':'pipeline',designQuantity:typeof a.designQuantity==='string'?a.designQuantity.slice(0,24):''});}
 return rows.length?rows:fallback;
}
