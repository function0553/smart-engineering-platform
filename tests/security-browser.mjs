// Isolated browser acceptance only. Never opens the normal workspace database.
import { openStore } from '../server/store.mjs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const database = resolve('.data/browser-acceptance.sqlite');
if (!database.endsWith('browser-acceptance.sqlite')) throw new Error('QA database required');
const store = openStore(database);
const camera = store.list('devices').find(r => r.data.code === 'QA-CAM-01');
if (!camera) throw new Error('Expected isolated QA camera missing');
const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/security-acceptance-only.png', Buffer.from(base64, 'base64'));
const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const old = store.db.prepare("SELECT * FROM integrations WHERE name='浏览器验收识别服务（合成输入）'").get();
const id = old?.id || randomUUID();
store.transaction(() => {
  if (old) store.db.prepare('UPDATE integrations SET token_hash=?,revoked=0 WHERE id=?').run(hash, id);
  else store.db.prepare('INSERT INTO integrations(id,name,kind,token_hash,device_ids,created_at) VALUES(?,?,?,?,?,?)').run(id, '浏览器验收识别服务（合成输入）', 'ai', hash, JSON.stringify([camera.id]), new Date().toISOString());
});
if (process.argv[2] === 'send') {
  const watch = store.list('watches').find(r => r.state === 'armed' && r.data.integrationId === id);
  const fence = store.list('fences').find(r => r.state === 'armed' && r.data.integrationId === id);
  if (!watch || !fence) throw new Error('Create and arm QA watch and fence in browser first');
  const portrait = store.get(watch.data.portraitIds[0]);
  const call = async (kind, data, eventId) => {
    const response = await fetch(`http://localhost:5190/api/ingest/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ deviceId: camera.id, eventId, data }) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
  };
  const eventId = `browser-${Date.now()}`;
  const face = { occurredAt: new Date().toISOString(), objectId: 'qa-object-not-a-real-person', modelId: watch.data.modelId, mime: 'image/png', base64, appliedRules: [{ ruleId: watch.id, version: watch.version }], matches: [{ portraitId: portrait.id, portraitVersion: portrait.version, similarity: 0.96 }] };
  const first = await call('captures', face, `${eventId}-a`);
  const second = await call('captures', face, `${eventId}-b`);
  const replay = await call('captures', face, `${eventId}-a`);
  const region = await call('detections', { occurredAt: new Date().toISOString(), objectId: 'qa-region-object', ruleId: fence.id, ruleVersion: fence.version, eventType: fence.data.eventType, point: [0.5, 0.5], confidence: 0.97, image: { mime: 'image/png', base64 } }, `${eventId}-region`);
  console.log(JSON.stringify({ first: first.alarmIds.length, second: second.alarmIds.length, replayDeduplicated: replay.duplicate, region: region.alarmIds.length, syntheticInputsOnly: true }));
} else console.log('Isolated QA integration and image prepared; no real devices or portraits.');
store.close();
