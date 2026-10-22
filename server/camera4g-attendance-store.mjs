import { createHash } from 'node:crypto';

export const word = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 40 && !/[\u0000-\u001f]/.test(value);
export const day = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && day(value.slice(0,10)) && Number.isFinite(Date.parse(value));
const VOICES = new Set(['pending','sending','submitted_unverified','playback_confirmed','failed_not_sent','delivery_unknown','expired_not_sent']);
export const invalid = () => new Error('attendance_invalid_response');

export function cleanPerson(value) {
  if (!value || !word(value.person_id) || !name(value.name) || !timestamp(value.enrolled_at) || ![undefined,0,1,false,true].includes(value.active)) throw invalid();
  return { person_id:value.person_id,name:value.name,enrolled_at:value.enrolled_at,active:value.active === undefined ? 1 : Number(value.active) };
}

export function cleanRecord(value) {
  if (!value || !word(value.attendance_id) || !word(value.person_id) || !name(value.name) || !word(value.camera_id) || !day(value.business_date) || !timestamp(value.occurred_at) || !VOICES.has(value.voice_status) || !['passed','not_checked'].includes(value.liveness_status) || !['on_time','late','legacy_unclassified'].includes(value.attendance_status) || !Number.isFinite(value.similarity) || value.similarity < .65 || value.similarity > 1.000001 || !(value.late_seconds === null || Number.isFinite(value.late_seconds) && value.late_seconds >= 0 && value.late_seconds <= 86400)) throw invalid();
  if (new Date(Date.parse(value.occurred_at)+8*3600000).toISOString().slice(0,10) !== value.business_date) throw invalid();
  return Object.fromEntries(['attendance_id','person_id','name','business_date','occurred_at','camera_id','similarity','voice_status','liveness_status','attendance_status','late_seconds'].map(key=>[key,value[key]]));
}

export function attendanceMirror(store, sourceId) {
  const db=store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS camera4g_attendance_state (
    source_id TEXT PRIMARY KEY,stream_id TEXT,cursor INTEGER NOT NULL DEFAULT 0,last_sync TEXT,people_synced TEXT,error TEXT);
    CREATE TABLE IF NOT EXISTS camera4g_attendance_people (
    source_id TEXT NOT NULL,person_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source_id,person_id));
    CREATE TABLE IF NOT EXISTS camera4g_attendance_records (
    source_id TEXT NOT NULL,attendance_id TEXT NOT NULL,first_sequence INTEGER NOT NULL,data TEXT NOT NULL,source_reset INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(source_id,attendance_id));
    CREATE INDEX IF NOT EXISTS camera4g_attendance_page ON camera4g_attendance_records(source_id,first_sequence);
    CREATE TABLE IF NOT EXISTS camera4g_attendance_events (
    source_id TEXT NOT NULL,sequence INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(source_id,sequence));`);
  db.prepare('INSERT OR IGNORE INTO camera4g_attendance_state(source_id) VALUES(?)').run(sourceId);
  if(!db.prepare('PRAGMA table_info(camera4g_attendance_state)').all().some(column=>column.name==='cursor_digest'))db.exec('ALTER TABLE camera4g_attendance_state ADD COLUMN cursor_digest TEXT');
  const state=()=>db.prepare('SELECT * FROM camera4g_attendance_state WHERE source_id=?').get(sourceId);
  const upsertPerson=value=>{const person=cleanPerson(value);db.prepare('INSERT INTO camera4g_attendance_people VALUES(?,?,?) ON CONFLICT(source_id,person_id) DO UPDATE SET data=excluded.data').run(sourceId,person.person_id,JSON.stringify(person));return person;};
  return {
    state,
    person:upsertPerson,
    people:()=>db.prepare('SELECT data FROM camera4g_attendance_people WHERE source_id=? ORDER BY person_id').all(sourceId).map(row=>JSON.parse(row.data)),
    replacePeople(values) {
      if (!Array.isArray(values) || values.length>10000) throw invalid();
      const people=values.map(cleanPerson);
      if (new Set(people.map(p=>p.person_id)).size!==people.length) throw invalid();
      store.transaction(()=>{
        db.prepare('DELETE FROM camera4g_attendance_people WHERE source_id=?').run(sourceId);
        for (const person of people) upsertPerson(person);
        db.prepare('UPDATE camera4g_attendance_state SET people_synced=? WHERE source_id=?').run(new Date().toISOString(),sourceId);
      });
    },
    applyPage(page, after, limit) {
      if (!page || !word(page.stream_id) || !Array.isArray(page.events) || page.events.length>limit || !Number.isSafeInteger(page.next_cursor) || typeof page.has_more!=='boolean') throw invalid();
      let previous=after;
      const events=page.events.map(event=>{
        if (!Number.isSafeInteger(event.sequence) || event.sequence!==previous+1 || !/^[a-f0-9]{64}$/.test(event.digest) || !['checkin','voice_update','test_reset'].includes(event.kind) || event.attendance_id!==event.record?.attendance_id) throw invalid();
        previous=event.sequence;
        return {sequence:event.sequence,kind:event.kind,digest:event.digest,record:cleanRecord(event.record)};
      });
      if (page.next_cursor!==previous || page.has_more && !events.length) throw invalid();
      store.transaction(()=>{
        const prior=state();
        if (prior.cursor!==after) throw new Error('attendance_concurrent_sync');
        if (prior.stream_id && prior.stream_id!==page.stream_id) throw new Error('attendance_stream_changed');
        if (page.after_digest!==prior.cursor_digest || after>0&&!prior.cursor_digest) throw new Error('attendance_checkpoint_changed');
        for (const event of events) {
          const id=event.record.attendance_id, data=JSON.stringify(event.record);
          const fingerprint=createHash('sha256').update(JSON.stringify(event)).digest('hex');
          const old=db.prepare('SELECT * FROM camera4g_attendance_records WHERE source_id=? AND attendance_id=?').get(sourceId,id);
          if (event.kind==='checkin' && old) throw invalid();
          if (event.kind!=='checkin' && !old) throw invalid();
          db.prepare('INSERT INTO camera4g_attendance_events VALUES(?,?,?)').run(sourceId,event.sequence,fingerprint);
          db.prepare(`INSERT INTO camera4g_attendance_records VALUES(?,?,?,?,?) ON CONFLICT(source_id,attendance_id)
            DO UPDATE SET data=excluded.data,source_reset=excluded.source_reset`).run(sourceId,id,old?.first_sequence??event.sequence,data,event.kind==='test_reset'?1:old?.source_reset??0);
        }
        db.prepare('UPDATE camera4g_attendance_state SET stream_id=?,cursor=?,cursor_digest=?,last_sync=?,error=NULL WHERE source_id=?').run(page.stream_id,page.next_cursor,events.at(-1)?.digest??prior.cursor_digest,new Date().toISOString(),sourceId);
      });
      return events.length;
    },
    failure(code) {db.prepare('UPDATE camera4g_attendance_state SET error=? WHERE source_id=?').run(code,sourceId);},
    records({after=0,limit=200,from,to,personId}={}) {
      if (!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>500||from!==undefined&&!day(from)||to!==undefined&&!day(to)||personId!==undefined&&!word(personId)||from&&to&&from>to) throw new Error('attendance_invalid_query');
      const conditions=['source_id=?','first_sequence>?'], params=[sourceId,after];
      for(const [key,value,op] of [['business_date',from,'>='],['business_date',to,'<='],['person_id',personId,'=']])if(value!==undefined){conditions.push(`json_extract(data,'$.${key}')${op}?`);params.push(value);}
      const rows=db.prepare(`SELECT * FROM camera4g_attendance_records WHERE ${conditions.join(' AND ')} ORDER BY first_sequence LIMIT ?`).all(...params,limit+1);
      const selected=rows.slice(0,limit);
      return { records:selected.map(row=>({...JSON.parse(row.data),source_reset:!!row.source_reset})),next_cursor:selected.at(-1)?.first_sequence??after,has_more:rows.length>limit };
    }
  };
}
