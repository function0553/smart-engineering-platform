export type LibraryFilters = { projectId: string; wbsId: string; from: string; to: string; state: string; q: string };
export const emptyLibraryFilters = (): LibraryFilters => ({ projectId: '', wbsId: '', from: '', to: '', state: '', q: '' });
export function libraryFilterProblem(filters: LibraryFilters): string {
  for (const date of [filters.from, filters.to]) {
    if (!date) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) return '请选择有效的资料日期。';
  }
  if (filters.from && filters.to && filters.from > filters.to) return '开始日期不能晚于结束日期。';
  if (filters.state && !['draft', 'archived', 'withdrawn'].includes(filters.state)) return '请选择有效的资料状态。';
  return '';
}
export function libraryFilterKey(base: string, filters: LibraryFilters): string {
  return JSON.stringify([base, filters.projectId, filters.wbsId, filters.from, filters.to, filters.state, filters.q.trim()]);
}
export function libraryQuery(filters: LibraryFilters, limit: number, offset: number): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value.trim()) query.set(key, value.trim());
  query.set('limit', String(limit)); query.set('offset', String(offset)); return query;
}
export function packageFilters(filters: LibraryFilters): Partial<LibraryFilters> {
  return Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
}
export function libraryGroupKey(group: { projectId: string; wbsId: string; recordDate: string }): string {
  return JSON.stringify([group.projectId, group.wbsId, group.recordDate]);
}
export function libraryGroupFilters(filters: LibraryFilters, group: { projectId: string; wbsId: string; recordDate: string }): LibraryFilters {
  return { ...filters, projectId: group.projectId, wbsId: group.wbsId, from: group.recordDate, to: group.recordDate };
}
export function libraryPackagePath(url: string): string {
  // Grants are same-service paths. Never navigate to a server-supplied arbitrary origin.
  if (!/^\/api\/engineering-site-packages\/[A-Za-z0-9_-]{43}$/.test(url)) throw new Error('资料包下载凭据异常，请重新打包。');
  return url;
}
export function libraryPageLabel(offset: number, count: number, total: number): string {
  return total ? `${offset + 1}–${offset + count} / ${total}` : '0 项';
}
export function libraryBytes(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' 字节';
}
