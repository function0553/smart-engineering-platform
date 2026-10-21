// New scan entries use explicit rules. Missing policy identifies retained historical/auxiliary records.
export const scanImageCategories = Object.freeze(['site_measurement','material_measurement','construction_daily','supervision_daily']);
export const scanImageRecord = data => data.uploadPolicy === 'seven_v1' && scanImageCategories.includes(data.category);
export const imageMime = mime => ['image/png','image/jpeg','image/webp'].includes(mime);
export function sameSiteContext(a,b) {
  // Parent title is descriptive; stable ID owns the relationship. Frozen titles remain in saved snapshots.
  const normalize=s=>({...s,path:s.path?.map(({version,...node})=>node),task:s.task?Object.fromEntries(Object.entries(s.task).filter(([k])=>k!=='linkVersion')):null,...(s.photoGroup?{photoGroup:{id:s.photoGroup.id}}:{})});
  return JSON.stringify(normalize(a))===JSON.stringify(normalize(b));
}
