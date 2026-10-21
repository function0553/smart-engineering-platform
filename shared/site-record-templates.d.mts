export type SiteTemplateCategory='site_measurement'|'work_photos'|'work_videos'|'material_measurement'|'hidden_work'|'construction_daily'|'supervision_daily';
export type SiteTemplateDefaults={titlePattern:string;note:string;workInfo?:{road:string;location:string}};
export type SiteTemplate={id:string;version:number;builtin?:boolean;state:'active'|'disabled';category:SiteTemplateCategory;name:string;scopeWbsId:string;description:string;defaults:SiteTemplateDefaults;created_by?:string;updated_at?:string};
export const siteTemplateCategories:Readonly<Record<SiteTemplateCategory,string>>;
export const builtinSiteTemplates:readonly SiteTemplate[];
export const siteTemplateVariables:readonly string[];
export function expandSiteTemplate(text:string,context:{projectName?:string;category:SiteTemplateCategory;recordDate:string;location?:string;address?:string},max?:number):string;
export function applySiteRecordTemplate<T extends {category:SiteTemplateCategory;recordDate:string;title:string;note:string;workInfo?:{road:string;location:string;number:string;completedAt:string}}>(template:SiteTemplate,current:T,context:{projectName?:string;location?:string;address?:string}):T&{templateRef:{id:string;version:number}};
export function defaultsFromSiteRecord(data:{category:SiteTemplateCategory;note:string;workInfo?:{road:string;location:string}}):SiteTemplateDefaults;
