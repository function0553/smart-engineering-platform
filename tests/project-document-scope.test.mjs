import test from 'node:test';import assert from 'node:assert/strict';
import {archiveDraftScope} from '../src/photo-archive-recovery.ts';
import {sectionDraftKey,sectionCatalogKey} from '../src/report-sections.ts';
test('both daily and archive scopes separate projects without renaming existing drafts',()=>{assert.notEqual(archiveDraftScope('o','b','u','a'),archiveDraftScope('o','b','u','b'));assert.equal(archiveDraftScope('o','b','u'),'photo-archive:o:b:u:');assert.notEqual(sectionDraftKey('s','u','area','a'),sectionDraftKey('s','u','area','b'));assert.notEqual(sectionCatalogKey('s','u','a'),sectionCatalogKey('s','u','b'));});
