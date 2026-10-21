import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibraryFilters, libraryFilterProblem, libraryFilterKey, libraryGroupFilters, libraryGroupKey, libraryPackagePath, libraryPageLabel, libraryQuery, packageFilters } from '../src/site-document-library-model.ts';

test('library filters validate real dates and keep project, place and record date separate', () => {
  const filters = { ...emptyLibraryFilters(), projectId: 'project-a', wbsId: 'part-a', from: '2026-10-01', to: '2026-10-21', q: '  收方  ' };
  assert.equal(libraryFilterProblem(filters), '');
  assert.match(libraryFilterProblem({ ...filters, from: '2026-02-30' }), /有效/);
  assert.match(libraryFilterProblem({ ...filters, from: '2026-10-22' }), /不能晚于/);
  assert.match(libraryFilterProblem({ ...filters, state: 'approved' }), /状态/);
  assert.equal(libraryQuery(filters, 20, 120).get('offset'), '120');
  assert.equal(libraryQuery(filters, 20, 120).get('q'), '收方');
  assert.deepEqual(packageFilters(filters), { projectId: 'project-a', wbsId: 'part-a', from: '2026-10-01', to: '2026-10-21', q: '收方' });
});
test('group packages bind to exact project place day and preserve applied state and search filters', () => {
  const filters = { ...emptyLibraryFilters(), state: 'archived', q: '照片' }, group = { projectId: 'A', wbsId: 'W', recordDate: '2026-10-21' };
  const one = libraryGroupFilters(filters, group);
  assert.deepEqual(one, { ...filters, projectId: 'A', wbsId: 'W', from: '2026-10-21', to: '2026-10-21' });
  for (const changed of [{ projectId: 'B' }, { wbsId: 'V' }, { from: '2026-10-20' }, { q: '其他' }, { state: 'draft' }]) assert.notEqual(libraryFilterKey('/engineering/site-library', one), libraryFilterKey('/engineering/site-library', { ...one, ...changed }));
  assert.notEqual(libraryGroupKey(group), libraryGroupKey({ ...group, projectId: 'B' }));
  assert.notEqual(libraryFilterKey('/engineering/site-library', one), libraryFilterKey('/engineering/projects/A/site-library', one));
});
test('only same-service controlled ZIP grant path may be downloaded without a giant blob', () => {
  const valid = '/api/engineering-site-packages/' + 'a'.repeat(43);
  assert.equal(libraryPackagePath(valid), valid);
  for (const invalid of ['https://other.test' + valid, '//other.test' + valid, valid + '?token=else', valid + '#fragment', valid + '/extra', '/api/engineering-site-media/' + 'a'.repeat(43)]) assert.throws(() => libraryPackagePath(invalid));
});
test('pagination labels never imply the first page is the complete register', () => {
  assert.equal(libraryPageLabel(0, 20, 121), '1–20 / 121');
  assert.equal(libraryPageLabel(120, 1, 121), '121–121 / 121');
  assert.equal(libraryPageLabel(0, 0, 0), '0 项');
});
