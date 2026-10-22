import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { privateConfig, upstreamBase } from './camera4g-upstream.mjs';
import { attendanceMirror, cleanPerson, word } from './camera4g-attendance-store.mjs';

const ROOT='/api/camera4g-attendance', MAX=8*1024*1024;
const integer=(value,fallback,low,high)=>value===undefined?fallback:Number.isSafeInteger(value)&&value>=low&&value<=high?value:NaN;
const safeError=error=>['attendance_stream_changed','attendance_checkpoint_changed','attendance_invalid_response','attendance_concurrent_sync','attendance_cursor_rejected','attendance_upstream_unauthorized','attendance_upstream_unavailable','attendance_timeout','attendance_closed','attendance_not_configured'].includes(error?.message)?error.message:'attendance_unavailable';
function load(options) {
  try {
    const raw=privateConfig(options,'CAMERA4G_ATTENDANCE_CONFIG_FILE');
    if(!raw||!word(raw.sourceId)||typeof raw.token!=='string'||!/^[\x21-\x7e]{32,2048}$/.test(raw.token))return null;
    const base=upstreamBase(raw.baseUrl,{development:options.development,loopbackPort:28982});
    const config={sourceId:raw.sourceId,base,token:raw.token,pollIntervalMs:integer(raw.pollIntervalMs,5000,1000,3600000),pageSize:integer(raw.pageSize,200,1,500),maxPagesPerSync:integer(raw.maxPagesPerSync,10,1,50),requestTimeoutMs:integer(raw.requestTimeoutMs,10000,100,30000),enrollmentTimeoutMs:integer(raw.enrollmentTimeoutMs,60000,100,120000)};
    return Object.values(config).some(v=>typeof v==='number'&&!Number.isFinite(v))?null:config;
  } catch {return null;}
}

export function mountCameraAttendance(app,{store,auth},options={}) {
  const config=load(options), mirror=config?attendanceMirror(store,config.sourceId):null;
  let closed=false,timer=null,inflight=null,active=0;
  const requests=new Set();
  function read(path,{method='GET',body,timeout=config?.requestTimeoutMs}={}) {
    if(closed)return Promise.reject(new Error('attendance_closed'));
    if(active>=4)return Promise.reject(new Error('attendance_upstream_unavailable'));
    active++;
    return new Promise((resolve,reject)=>{
      const url=new URL(path,config.base),payload=body===undefined?null:JSON.stringify(body);
      let request,deadline;
      const finish=()=>{active--;clearTimeout(deadline);requests.delete(request);};
      request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method,headers:{authorization:`Bearer ${config.token}`,accept:'application/json','accept-encoding':'identity',...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{})}},response=>{
        const chunks=[];let size=0;
        response.on('data',chunk=>{size+=chunk.length;if(size>MAX)response.destroy(new Error('attendance_invalid_response'));else chunks.push(chunk);});
        response.once('error',reject);
        response.once('end',()=>{
          if(method==='POST' && [400,413,422].includes(response.statusCode)) {
            let code='invalid_enrollment';
            try {
              const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if(['face_count','face_too_small','invalid_feature','invalid_image','invalid_image_size','unsupported_image','invalid_dimensions','invalid_base64','image_too_large','name_voice_mismatch','pcma8_voice_required','invalid_person_id','invalid_name','invalid_enrollment'].includes(value.error))code=value.error;
            } catch {}
            const error=new Error(code);error.rejectedStatus=response.statusCode;reject(error);return;
          }
          if(response.statusCode!==200){reject(new Error(response.statusCode===401||response.statusCode===403?'attendance_upstream_unauthorized':response.statusCode===400&&method==='GET'?'attendance_cursor_rejected':'attendance_upstream_unavailable'));return;}
          try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('attendance_invalid_response'));}
        });
      });
      requests.add(request);
      deadline=setTimeout(()=>request.destroy(new Error('attendance_timeout')),timeout);
      request.once('error',reject);request.once('close',finish);request.end(payload);
    });
  }
  function sync() {
    if(!config)return Promise.reject(new Error('attendance_not_configured'));
    if(closed)return Promise.reject(new Error('attendance_closed'));
    if(inflight)return inflight;
    inflight=(async()=>{
      let imported=0,hasMore=false;
      try {
        for(let n=0;n<config.maxPagesPerSync;n++) {
          const after=mirror.state().cursor;
          const page=await read(`/api/attendance/changes?after=${after}&limit=${config.pageSize}`);
          if(closed)throw new Error('attendance_closed');
          imported+=mirror.applyPage(page,after,config.pageSize);hasMore=page.has_more;
          if(!hasMore)break;
        }
        const people=await read('/api/people');
        if(closed)throw new Error('attendance_closed');
        mirror.replacePeople(people.people);
        return {imported,has_more:hasMore,cursor:mirror.state().cursor};
      } catch(error) {if(!closed)mirror.failure(safeError(error));throw error;}
      finally {inflight=null;}
    })();
    return inflight;
  }
  const guard=(req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(req.actor?.role!=='admin')return res.status(403).json({error:'attendance_admin_required'});
    if(!config)return res.status(503).json({error:'attendance_not_configured'});
    if(closed)return res.status(503).json({error:'attendance_closed'});
    next();
  };
  const fail=(res,error,enrollment=false)=>{
    if(res.destroyed||res.headersSent)return;
    if(enrollment&&error.rejectedStatus)return res.status(error.rejectedStatus).json({error:error.message,outcome:'rejected'});
    res.status(503).json({error:safeError(error),...(enrollment?{outcome:'unknown',message:'录入结果尚未确认，请先查询GPU人员列表，勿自动重试。'}:{})});
  };
  app.get(`${ROOT}/status`,auth,guard,(_req,res)=>{
    const state=mirror.state();res.json({configured:true,source_id:config.sourceId,stream_id:state.stream_id,cursor:state.cursor,last_sync:state.last_sync,people_synced:state.people_synced,error:state.error,syncing:!!inflight});
  });
  app.get(`${ROOT}/people`,auth,guard,(_req,res)=>res.json({people:mirror.people(),last_sync:mirror.state().people_synced}));
  app.get(`${ROOT}/records`,auth,guard,(req,res)=>{
    try {
      const url=new URL(req.originalUrl,'http://local'),allowed=new Set(['after','limit','from','to','person_id']);
      if([...url.searchParams.keys()].some(k=>!allowed.has(k)||url.searchParams.getAll(k).length!==1))throw Error();
      const params=Object.fromEntries(url.searchParams);
      for(const key of ['after','limit'])if(params[key]!==undefined&&!/^\d{1,16}$/.test(params[key]))throw Error();
      res.json(mirror.records({after:Number(params.after??0),limit:Number(params.limit??200),from:params.from,to:params.to,personId:params.person_id}));
    }catch{res.status(400).json({error:'attendance_invalid_query'});}
  });
  app.post(`${ROOT}/sync`,auth,guard,async(_req,res)=>{try{res.json(await sync());}catch(error){fail(res,error);}});
  app.post(`${ROOT}/people/enroll`,auth,guard,async(req,res)=>{
    const value=req.body;
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['person_id','name','photo_base64'].includes(k))||typeof value.person_id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(value.person_id)||typeof value.name!=='string'||!/^[\w\u3400-\u9fff·• .-]{1,40}$/u.test(value.name.trim())||typeof value.photo_base64!=='string'||value.photo_base64.length>7*1024*1024||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.photo_base64)||!value.photo_base64.length||Buffer.from(value.photo_base64,'base64').length>5*1024*1024)return res.status(400).json({error:'attendance_invalid_enrollment'});
    try {
      const request={person_id:value.person_id,name:value.name.trim(),photo_base64:value.photo_base64};
      const result=cleanPerson(await read('/api/enroll',{method:'POST',body:request,timeout:config.enrollmentTimeoutMs}));
      if(result.person_id!==request.person_id||result.name!==request.name)throw new Error('attendance_invalid_response');
      if(closed)return;
      mirror.person(result);res.json(result);
    }catch(error){fail(res,error,true);}
  });
  app.use(ROOT,auth,guard,(_req,res)=>res.status(404).json({error:'attendance_path_not_found'}));
  return {configured:!!config,sync,
    start(){if(!config||timer||closed)return;const tick=()=>{if(closed)return;sync().catch(()=>{}).finally(()=>{if(!closed){timer=setTimeout(tick,config.pollIntervalMs);timer.unref();}});};timer=setTimeout(tick,0);timer.unref();},
    close(){closed=true;clearTimeout(timer);for(const request of requests)request.destroy(new Error('attendance_closed'));requests.clear();}
  };
}
