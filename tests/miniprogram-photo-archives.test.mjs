import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {unzipSync,strFromU8} from 'fflate';
import {archiveServer,event,pixels,otherPixels} from './miniprogram-archive-harness.mjs';

const plain=value=>JSON.parse(JSON.stringify(value));
const mutations=runtime=>runtime.requests.filter(request=>['POST','PUT','DELETE'].includes(request.method));
const photoMutations=runtime=>runtime.requests.filter(request=>request.method==='POST' && /\/photos$/.test(request.path));
async function pageFor(runtime){const page=runtime.loadPage();await page.onLoad({});await runtime.settle();return page;}
async function newSaved(page,runtime){
  await page.newArchive();
  page.input(event({scope:'base',key:'title'},'隔离测试施工影像'));
  page.input(event({scope:'base',key:'projectName'},'模拟小程序的隔离工程'));
  page.input(event({scope:'base',key:'roadName'},'测试道路'));
  page.input(event({scope:'segment',key:'start'},'K0+000'));
  page.input(event({scope:'segment',key:'end'},'K0+100'));
  await page.saveArchive();await runtime.settle();
  assert.ok(page.data.archive?.id,'new archive is committed before photo upload');
  assert.equal(page.data.error,'');return page.data.archive;
}
async function upload(page,runtime,{bytes=pixels,path='/temp/photo.png',stageId}={}){
  runtime.choose([runtime.media(bytes,path)]);
  await page.addPhotos(event({stageId:stageId || page.data.current.stages[0].id}));await runtime.settle();
}
const photoCount=server=>server.store.db.prepare('SELECT COUNT(*) n FROM photo_archive_images').get().n;
const exportCount=server=>server.store.db.prepare('SELECT COUNT(*) n FROM photo_archive_exports').get().n;

test('mini-program archive model and private originals isolate scopes and preserve pending retry bytes',async t=>{
  const server=await archiveServer(t),runtime=server.runtime(),model=runtime.load('utils/photo-archives.js'),drafts=runtime.load('utils/archive-draft.js');
  const template={projectName:'隔离工程',roadName:'模拟道路',stages:['沟槽开挖','管道安装']},data=model.createArchive(template);
  assert.equal(model.validateStructure(data),true);const clone=model.clone(data);clone.segments[0].stages[0].name='人工开挖';assert.equal(data.segments[0].stages[0].name,'沟槽开挖');
  const archiveId=randomUUID(),userId=randomUUID(),key=model.draftKey(server.baseUrl,userId,archiveId),storage=drafts.createStorage(server.baseUrl,userId,archiveId);
  const selected=runtime.media(),photo={id:randomUUID(),segmentId:data.segments[0].id,stageId:data.segments[0].stages[0].id,name:'合成原图.png',caption:'非现场照片',mime:'image/png',width:320,height:180,bytes:pixels.length};
  const pending=await storage.copy(photo,selected.tempFilePath);model.writeDraft(key,{data,version:1,queue:[pending]});
  runtime.files.delete(selected.tempFilePath);
  assert.deepEqual(Buffer.from(await storage.readBase64(model.readDraft(key).queue[0]),'base64'),pixels);
  assert.equal(model.readDraft(model.draftKey(server.baseUrl,'other-user',archiveId)),null);
  assert.equal(model.readDraft(model.draftKey('https://other.example',userId,archiveId)),null);
  assert.equal(drafts.createStorage(server.baseUrl,'other-user',archiveId).validQueue([pending]).length,0);
  assert.equal(storage.validQueue([{...pending,filePath:'/private/unrelated.png'}]).length,0);
  runtime.files.set('/private/unrelated.png',Buffer.from('preserve'));storage.remove('/private/unrelated.png');await runtime.settle();assert.ok(runtime.files.has('/private/unrelated.png'));
  assert.notEqual(model.wordFileName('测试道路',randomUUID()),model.wordFileName('测试道路',randomUUID()));
});

test('mini-program fills segments and custom stages, uploads actual PNG bytes and generates the supplied immutable Word template',async t=>{
  const server=await archiveServer(t),owner=await server.user('archive-owner'),runtime=server.runtime();await runtime.login(owner.username);const page=await pageFor(runtime);
  assert.equal(page.data.mode,'list');await newSaved(page,runtime);
  page.changeDate(event({scope:'segment'},'2026-10-09'));
  page.addStage();const extra=page.data.current.stages.length-1;page.input(event({scope:'stage',key:'name',index:extra},'自定义工序'));page.changeDate(event({scope:'stage',index:extra},'2026-10-09'));
  page.addSegment();page.input(event({scope:'segment',key:'content'},'临时探坑'));await page.removeSegment();await runtime.settle();assert.equal(page.data.segments.length,1);
  page.addSegment();page.input(event({scope:'segment',key:'content'},'正式探坑测试段'));await page.removeStage(event({index:0}));await runtime.settle();page.addStage();page.changeDate(event({scope:'segment'},'2026-10-10'));
  await page.saveArchive();await runtime.settle();
  await page.selectSegment(event({},'0'));await runtime.settle();
  await upload(page,runtime);assert.equal(photoCount(server),1);assert.equal(runtime.chooseOptions().sizeType[0],'original');
  assert.deepEqual(Buffer.from(server.store.db.prepare('SELECT bytes FROM photo_archive_images').get().bytes),pixels);
  await page.generate();await runtime.settle();assert.equal(exportCount(server),1);assert.equal(page.data.exports.length,1);
  const word=Buffer.from(server.store.db.prepare('SELECT document FROM photo_archive_exports').get().document),parts=unzipSync(word),xml=strFromU8(parts['word/document.xml']);
  assert.match(xml,/模拟小程序的隔离工程-测试道路/);assert.match(xml,/K0\+000～K0\+100段/);assert.match(xml,/自定义工序/);assert.match(xml,/2026-10-09/);assert.match(xml,/正式探坑测试段/);assert.match(xml,/2026-10-10/);
  const image=Object.keys(parts).find(path=>path.startsWith('word/media/'));assert.deepEqual(Buffer.from(parts[image]),pixels);
  const template=unzipSync(readFileSync(new URL('../server/templates/photo-archive.docx',import.meta.url)));for(const path of ['word/styles.xml','word/fontTable.xml','word/footer1.xml'])assert.deepEqual(parts[path],template[path]);
  const originalId=server.store.db.prepare('SELECT id FROM photo_archive_images').get().id;
  await page.removePhoto(event({id:originalId}));await runtime.settle();assert.equal(photoCount(server),0);assert.deepEqual(Buffer.from(server.store.db.prepare('SELECT document FROM photo_archive_exports').get().document),word);
  await page.backToList();await runtime.settle();assert.equal(page.data.items.length,1);
  const admin=server.runtime();await admin.login();const adminPage=await pageFor(admin);assert.equal(adminPage.data.items[0].id,page.data.items[0].id);
  const other=await server.user('archive-other'),foreign=server.runtime();await foreign.login(other.username);const foreignPage=await pageFor(foreign);assert.equal(foreignPage.data.total,0);
  await assert.rejects(foreign.api.request('/photo-archives/'+page.data.items[0].id),error=>error.status===404);
});

test('read-only mini-program archive actions are inert even when invoked directly, while an administrator can view owner originals',async t=>{
  const server=await archiveServer(t),owner=await server.user('archive-readonly'),runtime=server.runtime();await runtime.login(owner.username);const page=await pageFor(runtime),archive=await newSaved(page,runtime);await upload(page,runtime);
  const user=server.store.db.prepare('SELECT id FROM users WHERE username=?').get(owner.username);server.store.db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(user.id);
  const viewer=server.runtime();await viewer.login(owner.username);const readonly=await pageFor(viewer);await readonly.openArchive(event({id:archive.id}));await viewer.settle();assert.equal(readonly.data.readOnly,true);
  const before=plain(readonly.data.archive.data),requestCount=mutations(viewer).length,photo=server.store.db.prepare('SELECT id FROM photo_archive_images').get();
  readonly.input(event({scope:'base',key:'title'},'forbidden'));readonly.changeDate(event({scope:'segment'},'2026-10-10'));readonly.addSegment();readonly.removeSegment();readonly.addStage();readonly.removeStage(event({index:0}));
  await readonly.saveArchive();await readonly.newArchive();await readonly.addPhotos(event({stageId:readonly.data.current.stages[0].id}));await readonly.removePhoto(event({id:photo.id}));await readonly.generate();await readonly.retryUploads();await viewer.settle();
  assert.deepEqual(plain(readonly.data.archive.data),before);assert.equal(mutations(viewer).length,requestCount);assert.equal(photoCount(server),1);assert.equal(exportCount(server),0);
  const admin=server.runtime();await admin.login();const adminPage=await pageFor(admin);await adminPage.openArchive(event({id:archive.id}));await admin.settle();assert.ok(adminPage.data.stageViews.some(stage=>stage.photos.some(photo=>photo.path)));assert.deepEqual([...admin.files.values()].find(bytes=>bytes.equals(pixels)),pixels);
});

test('archive optimistic conflict keeps the account draft; explicit reload and backend/user switches do not silently reuse it',async t=>{
  const server=await archiveServer(t),owner=await server.user('archive-conflict'),storage=new Map(),files=new Map(),runtime=server.runtime({storage,files});await runtime.login(owner.username);const page=await pageFor(runtime),archive=await newSaved(page,runtime);
  page.input(event({scope:'base',key:'title'},'本机仍需保留的修改'));page.onHide();
  const remote={...archive.data,title:'另外设备保存的标题'};await runtime.api.request('/photo-archives/'+archive.id,'PUT',{version:archive.version,data:remote});
  runtime.setScrollTop(2700);await page.saveArchive();await runtime.settle();assert.equal(page.data.conflict,true);assert.equal(page.data.base.title,'本机仍需保留的修改');assert.equal(page.data.archive.version,1);assert.equal(runtime.scrollTop(),0,'the stale-revision recovery action is revealed from the bottom of the editor');
  const model=runtime.load('utils/photo-archives.js'),key=model.draftKey(server.baseUrl,page.data.user.id,archive.id);assert.equal(model.readDraft(key).data.title,'本机仍需保留的修改');
  page.onUnload();const reopened=server.runtime({storage,files});await reopened.login(owner.username);const restored=await pageFor(reopened);await restored.openArchive(event({id:archive.id}));await reopened.settle();assert.equal(restored.data.base.title,'本机仍需保留的修改');
  await restored.reloadArchive();await reopened.settle();assert.equal(restored.data.base.title,'另外设备保存的标题');assert.equal(restored.data.archive.version,2);
  const other=await server.user('archive-draft-other'),otherRuntime=server.runtime({storage,files});await otherRuntime.login(other.username);const otherPage=await pageFor(otherRuntime);await otherPage.newArchive();assert.notEqual(otherPage.data.base.title,'本机仍需保留的修改');
  const count=mutations(reopened).length;reopened.api.setBaseUrl('http://127.0.0.1:1');restored.onShow();await restored.saveArchive();await reopened.settle();assert.equal(mutations(reopened).length,count);assert.ok(reopened.events.some(event=>event.type==='redirect'));
});

test('chooseMedia cancellation is neutral and oversized images fail early; partial original upload resumes from private files with stable retry identifiers',async t=>{
  const server=await archiveServer(t),owner=await server.user('archive-queue'),storage=new Map(),files=new Map(),runtime=server.runtime({storage,files});await runtime.login(owner.username);const page=await pageFor(runtime),archive=await newSaved(page,runtime),stageId=page.data.current.stages[0].id;
  runtime.cancelChoose();await page.addPhotos(event({stageId}));await runtime.settle();assert.equal(page.data.error,'');assert.equal(page.data.pendingCount,0);
  const oversized=Buffer.alloc(5242881);pixels.copy(oversized);runtime.choose([runtime.media(oversized,'/temp/large.png')]);await page.addPhotos(event({stageId}));await runtime.settle();assert.match(page.data.error,/5MB/);assert.equal(photoMutations(runtime).length,0);
  runtime.requestRule(record=>record.method==='POST' && /\/photos$/.test(record.path) && record.data.base64===otherPixels.toString('base64'),'fail-before');
  runtime.choose([runtime.media(pixels,'/temp/first.png'),runtime.media(otherPixels,'/temp/second.png')]);await page.addPhotos(event({stageId}));await runtime.settle();
  assert.equal(photoCount(server),1);assert.equal(page.data.pendingCount,1);const pending=plain(page.data.pendingPhotos[0]),failedRequest=photoMutations(runtime)[1];assert.equal(pending.id,failedRequest.data.id);assert.ok(files.has(pending.filePath));assert.deepEqual(files.get(pending.filePath),otherPixels);
  files.set('/private/unrelated.png',Buffer.from('keep'));files.delete('/temp/first.png');files.delete('/temp/second.png');page.onUnload();
  const reopened=server.runtime({storage,files});await reopened.login(owner.username);const next=await pageFor(reopened);await next.openArchive(event({id:archive.id}));await reopened.settle();assert.equal(next.data.pendingCount,1);assert.equal(next.data.pendingPhotos[0].id,pending.id);
  await next.retryUploads();await reopened.settle();assert.equal(photoCount(server),2);assert.equal(next.data.pendingCount,0);assert.equal(photoMutations(reopened)[0].data.id,pending.id);assert.equal(files.has(pending.filePath),false);assert.ok(files.has('/private/unrelated.png'));
});

test('committed photo and Word requests with lost responses retry their original identifiers without duplicate server records',async t=>{
  const server=await archiveServer(t),runtime=server.runtime();await runtime.login();const page=await pageFor(runtime);await newSaved(page,runtime);
  runtime.requestRule(record=>record.method==='POST' && /\/photos$/.test(record.path),'fail-after');await upload(page,runtime);
  assert.equal(photoCount(server),1);assert.equal(page.data.pendingCount,1);const photoId=photoMutations(runtime)[0].data.id;await page.retryUploads();await runtime.settle();assert.equal(photoCount(server),1);assert.equal(page.data.pendingCount,0);assert.equal(photoMutations(runtime)[1].data.id,photoId);
  runtime.requestRule(record=>record.method==='POST' && /\/exports$/.test(record.path),'fail-after');await page.generate();await runtime.settle();assert.equal(exportCount(server),1);
  const exportRequest=runtime.requests.find(record=>record.method==='POST' && /\/exports$/.test(record.path));await page.generate();await runtime.settle();assert.equal(exportCount(server),1);
  const retries=runtime.requests.filter(record=>record.method==='POST' && /\/exports$/.test(record.path));assert.equal(retries[1].data.exportId,exportRequest.data.exportId);assert.equal(page.data.exports.length,1);
});

test('a new archive committed before its reply was lost reopens its durable draft and retries creation once',async t=>{
  const server=await archiveServer(t),owner=await server.user('archive-create-retry'),storage=new Map(),files=new Map(),runtime=server.runtime({storage,files});await runtime.login(owner.username);const page=await pageFor(runtime);
  await page.newArchive();page.input(event({scope:'segment',key:'content'},'隔离探坑'));
  runtime.requestRule(record=>record.method==='POST' && record.path==='/api/mobile/photo-archives','fail-after');await page.saveArchive();await runtime.settle();
  assert.equal(page.data.archive,null);assert.equal(server.store.db.prepare('SELECT COUNT(*) n FROM photo_archives').get().n,1);const creation=runtime.requests.find(record=>record.method==='POST' && record.path==='/api/mobile/photo-archives');page.onUnload();
  const reopened=server.runtime({storage,files});await reopened.login(owner.username);const restored=await pageFor(reopened);assert.equal(restored.data.newDraftAvailable,true);await restored.newArchive();assert.equal(restored.data.current.content,'隔离探坑');
  restored.input(event({scope:'base',key:'title'},'回复丢失后补充的标题'));await restored.saveArchive();await reopened.settle();
  assert.equal(server.store.db.prepare('SELECT COUNT(*) n FROM photo_archives').get().n,1);assert.equal(restored.data.archive.id,creation.data.creationId);assert.equal(restored.data.base.title,'回复丢失后补充的标题');
  const second=reopened.requests.find(record=>record.method==='POST' && record.path==='/api/mobile/photo-archives');assert.equal(second.data.creationId,creation.data.creationId);assert.deepEqual(second.data.data,creation.data.data);
});

test('creation acknowledgement followed by local index quota does not delete the earlier durable new draft',async t=>{
  const server=await archiveServer(t),owner=await server.user('archive-index-migration'),storage=new Map(),files=new Map(),runtime=server.runtime({storage,files});await runtime.login(owner.username);const page=await pageFor(runtime);await page.newArchive();page.input(event({scope:'segment',key:'content'},'迁移失败仍保留的探坑'));
  const creationId=page.creationId,model=runtime.load('utils/photo-archives.js'),newKey=model.draftKey(server.baseUrl,page.data.user.id);
  runtime.failStorage(key=>key.endsWith(':'+creationId));await page.saveArchive();await runtime.settle();assert.equal(server.store.db.prepare('SELECT COUNT(*) n FROM photo_archives').get().n,1);assert.ok(model.readDraft(newKey),'the earlier durable draft survives failed archive-key migration');page.onUnload();
  const reopened=server.runtime({storage,files});await reopened.login(owner.username);const restored=await pageFor(reopened);await restored.newArchive();assert.equal(restored.data.current.content,'迁移失败仍保留的探坑');await restored.saveArchive();await reopened.settle();assert.equal(restored.data.archive.id,creationId);assert.equal(server.store.db.prepare('SELECT COUNT(*) n FROM photo_archives').get().n,1);assert.equal(model.readDraft(newKey),null);
});

test('a Word committed before reply loss is found in history after reopen, and retrying the historical file creates no new version',async t=>{
  const server=await archiveServer(t),owner=await server.user('archive-word-reopen'),storage=new Map(),files=new Map(),runtime=server.runtime({storage,files});await runtime.login(owner.username);const page=await pageFor(runtime),archive=await newSaved(page,runtime);await upload(page,runtime);
  runtime.requestRule(record=>record.method==='POST' && /\/exports$/.test(record.path),'fail-after');await page.generate();await runtime.settle();assert.equal(exportCount(server),1);assert.equal(page.data.hasPendingExport,true);const exportId=server.store.db.prepare('SELECT id FROM photo_archive_exports').get().id;page.onUnload();
  const reopened=server.runtime({storage,files});await reopened.login(owner.username);const restored=await pageFor(reopened);await restored.openArchive(event({id:archive.id}));await reopened.settle();assert.equal(restored.data.hasPendingExport,false);assert.equal(restored.data.exports[0].id,exportId);
  await restored.downloadWord(event({id:exportId}));await reopened.settle();assert.equal(exportCount(server),1);assert.equal(reopened.requests.filter(record=>record.method==='POST' && /\/exports$/.test(record.path)).length,0);assert.ok(reopened.events.some(event=>event.type==='open'));
});

test('an unavailable original displays a retry state and retryPhoto restores the original bytes without writing business data',async t=>{
  const server=await archiveServer(t),runtime=server.runtime();await runtime.login();const page=await pageFor(runtime);await newSaved(page,runtime);
  runtime.requestRule(record=>record.method==='GET' && /\/photos\//.test(record.path),'fail-before');await upload(page,runtime);const stage=page.data.stageViews[0],photo=stage.photos[0];assert.equal(photo.failed,true);assert.equal(photo.path,'');const before=mutations(runtime).length;
  await page.retryPhoto(event({id:photo.id}));await runtime.settle();const restored=page.data.stageViews[0].photos[0];assert.equal(restored.failed,false);assert.deepEqual(runtime.files.get(restored.path),pixels);assert.equal(mutations(runtime).length,before);
  page.previewPhoto(event({id:photo.id}));assert.equal(runtime.events.at(-1).type,'preview');assert.equal(runtime.events.at(-1).options.current,restored.path);
});

test('private original copy and draft index failures keep the committed queue and prevent non-durable uploads',async t=>{
  const server=await archiveServer(t),runtime=server.runtime();await runtime.login();const page=await pageFor(runtime);await newSaved(page,runtime);const stageId=page.data.current.stages[0].id;
  runtime.requestRule(record=>record.method==='POST' && /\/photos$/.test(record.path),'fail-before');await upload(page,runtime);assert.equal(page.data.pendingCount,1);
  const model=runtime.load('utils/photo-archives.js'),key=model.draftKey(server.baseUrl,page.data.user.id,page.data.archive.id),before=plain(runtime.storage.get(key)),oldPending=page.data.pendingPhotos[0],beforeRequests=photoMutations(runtime).length;
  runtime.failCopies(()=>true);runtime.choose([runtime.media(otherPixels,'/temp/copy-failure.png')]);await page.addPhotos(event({stageId}));await runtime.settle();assert.match(page.data.error,/原图草稿保存失败/);assert.deepEqual(plain(runtime.storage.get(key)),before);assert.equal(photoMutations(runtime).length,beforeRequests);assert.ok(runtime.files.has(oldPending.filePath));
  runtime.failCopies(null);runtime.failStorage(candidate=>candidate===key);runtime.choose([runtime.media(otherPixels,'/temp/index-failure.png')]);await page.addPhotos(event({stageId}));await runtime.settle();assert.match(page.data.error,/原图草稿记录保存失败/);assert.deepEqual(plain(runtime.storage.get(key)),before);assert.equal(page.data.pendingCount,1);assert.equal(photoMutations(runtime).length,beforeRequests);assert.ok(runtime.files.has(oldPending.filePath));
  assert.equal([...runtime.files.keys()].filter(path=>path.startsWith('/private/photo-archive-draft_')).length,1,'only the prior durable original remains');
  runtime.failStorage(null);await page.retryUploads();await runtime.settle();assert.equal(photoCount(server),1);assert.equal(page.data.pendingCount,0);
});

test('metadata and generation retries never submit without a durable account draft when its index is unavailable',async t=>{
  const server=await archiveServer(t),runtime=server.runtime();await runtime.login();const page=await pageFor(runtime);await newSaved(page,runtime);await upload(page,runtime);
  const model=runtime.load('utils/photo-archives.js'),key=model.draftKey(server.baseUrl,page.data.user.id,page.data.archive.id),committed=plain(runtime.storage.get(key)),before=mutations(runtime).length;
  runtime.failStorage(candidate=>candidate===key);page.input(event({scope:'base',key:'title'},'尚未耐久保存的标题'));await page.saveArchive();await runtime.settle();assert.equal(mutations(runtime).length,before);assert.deepEqual(plain(runtime.storage.get(key)),committed);
  page.input(event({scope:'base',key:'title'},committed.data.title));await page.generate();await runtime.settle();assert.equal(exportCount(server),0);assert.equal(runtime.requests.filter(request=>request.method==='POST' && /\/exports$/.test(request.path)).length,0);
  runtime.failStorage(null);await page.saveArchive();await runtime.settle();
  let commits=0;runtime.failStorage(candidate=>candidate===key && ++commits>=2);await page.generate();await runtime.settle();assert.equal(exportCount(server),0);assert.equal(runtime.requests.filter(request=>request.method==='POST' && /\/exports$/.test(request.path)).length,0);
  const pendingId=page.pendingExport.id;await page.generate();await runtime.settle();assert.equal(exportCount(server),0);assert.equal(page.pendingExport.id,pendingId);assert.equal(runtime.requests.filter(request=>request.method==='POST' && /\/exports$/.test(request.path)).length,0);
  runtime.failStorage(null);await page.generate();await runtime.settle();assert.equal(exportCount(server),1);assert.equal(server.store.db.prepare('SELECT id FROM photo_archive_exports').get().id,pendingId);
});

test('long-page generation and historical Word failures reveal their retained feedback without changing version identity',async t=>{
  const server=await archiveServer(t),runtime=server.runtime();await runtime.login();const page=await pageFor(runtime);await newSaved(page,runtime);
  runtime.setScrollTop(1800);await page.generate();await runtime.settle();assert.equal(runtime.scrollTop(),0);assert.match(page.data.error,/至少上传/);assert.equal(exportCount(server),0);
  await upload(page,runtime);runtime.setScrollTop(2500);runtime.requestRule(request=>request.method==='POST' && /\/exports$/.test(request.path),'fail-after');await page.generate();await runtime.settle();assert.equal(runtime.scrollTop(),0);assert.equal(page.data.hasPendingExport,true);const pendingId=server.store.db.prepare('SELECT id FROM photo_archive_exports').get().id;
  runtime.setScrollTop(2500);runtime.requestRule(request=>request.method==='GET' && /\/word$/.test(request.path),'fail-before');await page.generate();await runtime.settle();assert.equal(runtime.scrollTop(),0);assert.match(page.data.notice,/保存在服务器/);assert.match(page.data.error,/连接失败/);
  const exportId=page.data.exports[0].id,initial=plain(page.data.exports),serverBytes=Buffer.from(server.store.db.prepare('SELECT document FROM photo_archive_exports').get().document);assert.equal(exportId,pendingId);assert.equal(exportCount(server),1);
  runtime.setScrollTop(3200);runtime.failWrites(path=>path.endsWith('.docx'));await page.downloadWord(event({id:exportId}));await runtime.settle();assert.equal(runtime.scrollTop(),0);assert.match(page.data.error,/保存失败/);assert.deepEqual(plain(page.data.exports),initial);
  runtime.failWrites(null);runtime.setScrollTop(3200);runtime.failOpening(true);await page.downloadWord(event({id:exportId}));await runtime.settle();assert.equal(runtime.scrollTop(),0);assert.match(page.data.notice,/预览未完成/);assert.ok(runtime.files.has(page.data.savedFile));assert.deepEqual(plain(page.data.exports),initial);
  runtime.failOpening(false);runtime.setScrollTop(3200);runtime.failSharing('shareFileMessage:fail blocked');page.shareWord();await runtime.settle();assert.equal(runtime.scrollTop(),0);assert.match(page.data.notice,/转发未完成/);
  runtime.setScrollTop(3200);runtime.failSharing('shareFileMessage:fail cancel');const notice=page.data.notice;page.shareWord();await runtime.settle();assert.equal(runtime.scrollTop(),3200);assert.equal(page.data.notice,notice);
  runtime.failSharing('');runtime.wx.canIUse=()=>false;runtime.setScrollTop(3200);page.shareWord();await runtime.settle();assert.equal(runtime.scrollTop(),0);assert.match(page.data.notice,/不支持直接转发/);
  assert.equal(exportCount(server),1);assert.equal(page.data.exports[0].id,exportId);assert.deepEqual(Buffer.from(server.store.db.prepare('SELECT document FROM photo_archive_exports').get().document),serverBytes);
});

test('a native document failure arriving after page/session change cannot scroll the new page or expose old feedback',async t=>{
  const server=await archiveServer(t),runtime=server.runtime();await runtime.login();const page=await pageFor(runtime);await newSaved(page,runtime);await upload(page,runtime);await page.generate();await runtime.settle();
  const originalNotice=page.data.notice,session=runtime.api.session(),first=runtime.holdOpening();page.openWord();assert.ok(first.release);runtime.api.clearSession();runtime.setScrollTop(1800);const before=runtime.events.filter(event=>event.type==='scroll').length;first.release();await runtime.settle();
  assert.equal(runtime.scrollTop(),1800);assert.equal(runtime.events.filter(event=>event.type==='scroll').length,before);assert.equal(page.data.notice,originalNotice);
  runtime.api.setSession(session);const second=runtime.holdOpening();page.openWord();assert.ok(second.release);page.onUnload();runtime.setScrollTop(2100);const after=runtime.events.filter(event=>event.type==='scroll').length;second.release();await runtime.settle();assert.equal(runtime.scrollTop(),2100);assert.equal(runtime.events.filter(event=>event.type==='scroll').length,after);assert.equal(page.data.notice,originalNotice);
});

test('generated Word history survives download, private storage and preview failures and two same-minute versions use different files',async t=>{
  const server=await archiveServer(t),runtime=server.runtime();await runtime.login();const page=await pageFor(runtime);await newSaved(page,runtime);await upload(page,runtime);
  runtime.requestRule(record=>record.method==='GET' && /\/word$/.test(record.path),'fail-before');await page.generate();await runtime.settle();assert.equal(exportCount(server),1);assert.equal(page.data.exports.length,1);
  const firstId=page.data.exports[0].id;
  runtime.failWrites(path=>path.endsWith('.docx'));await page.downloadWord(event({id:firstId}));await runtime.settle();assert.equal(page.data.exports.length,1);assert.match(page.data.error,/保存失败/);
  runtime.failWrites(null);runtime.failOpening(true);await page.downloadWord(event({id:firstId}));await runtime.settle();const firstPath=runtime.events.filter(event=>event.type==='open').at(-1).options.filePath;assert.ok(runtime.files.has(firstPath));assert.equal(page.data.exports.length,1);
  runtime.failOpening(false);await page.downloadWord(event({id:firstId}));await runtime.settle();assert.equal(runtime.events.filter(event=>event.type==='open').at(-1).options.filePath,firstPath);
  page.input(event({scope:'base',key:'title'},'第二个 Word 版本'));await page.generate();await runtime.settle();assert.equal(exportCount(server),2);assert.equal(page.data.exports.length,2);
  const secondPath=runtime.events.filter(event=>event.type==='open').at(-1).options.filePath;assert.notEqual(secondPath,firstPath);assert.ok(runtime.files.has(firstPath));assert.ok(runtime.files.has(secondPath));assert.match(firstPath,new RegExp(firstId));
});

test('an original image response arriving after backend/session change cannot recreate or display the previous private cache',async t=>{
  const server=await archiveServer(t),owner=await server.user('archive-late'),runtime=server.runtime();await runtime.login(owner.username);const page=await pageFor(runtime),archive=await newSaved(page,runtime);await upload(page,runtime);
  const second=server.runtime();await second.login(owner.username);const viewing=await pageFor(second),held=second.requestRule(record=>record.method==='GET' && /\/photos\//.test(record.path),'hold');const opening=viewing.openArchive(event({id:archive.id}));
  await second.waitFor(()=>held.release,'held original response');second.api.setBaseUrl('http://127.0.0.1:1');viewing.onShow();held.release();await opening;await second.settle();
  assert.equal(second.writes.filter(file=>file.bytes.equals(pixels)).length,0);assert.equal([...second.files.values()].filter(bytes=>bytes.equals(pixels)).length,0);assert.ok(second.events.some(event=>event.type==='redirect'));
});
