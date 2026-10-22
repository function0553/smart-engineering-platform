"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const video = $("video"), canvas = $("overlay"), stage = $("stage");
  const ctx = canvas.getContext("2d");
  let config, hls = null, rtc = null, history = [], clockOffset = 0, historyFresh = false;
  let pollTimer, generation = 0, pollController = null, lastPoll = 0, playbackStamp = null;
  let overlayEnabled=false, alignmentOffset=0, timingState=null;
  let initializationStage="dependencies";
  let videoRetryTimer=null;
  let lastCount = 0, countTime = performance.now(), displayFps = 0, shownFrames = 0;
  const text = (id, value) => { $(id).textContent = value; };
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const labels = {
    "hardhat":"安全帽", "no-hardhat":"未戴安全帽",
    "safety vest":"反光背心", "no-safety vest":"未穿反光背心"
  };
  const visibleLabels=new Set(Object.keys(labels));
  const equipmentNames={helmet:"安全帽",vest:"反光背心"};
  const equipmentKeys=new Set(Object.keys(equipmentNames));
  const stateNames={worn:"已佩戴",not_worn:"未佩戴",unknown:"无法判断",pending:"确认中",
    observed:"当前观测",confirmed:"已确认",predicted:"预测",temporarily_lost:"短时丢失"};
  const copyJson=(value)=>JSON.parse(JSON.stringify(value));
  const visibleDetection=(d)=>d && visibleLabels.has(d.label);
  const detectionForDisplay=(d)=>({...copyJson(d),label:labels[d.label]});
  function equipmentOnly(values) {
    if (!values || typeof values!=="object" || Array.isArray(values)) return {};
    return Object.fromEntries(Object.entries(values).filter(([item])=>equipmentKeys.has(item)));
  }
  function statesForDisplay(states) {
    return Object.fromEntries(Object.entries(equipmentOnly(states)).map(([item,state])=>[equipmentNames[item],stateNames[state]||state]));
  }
  function personForDisplay(person) {
    const copy={};
    for(const key of ["track_id","byte_track_id","box","confidence","weak_person_observation","tracking_epoch",
      "observation_age_seconds"]) if(key in person)copy[key]=copyJson(person[key]);
    for (const key of ["states","raw_states","observed_states"]) if(key in person)copy[key]=statesForDisplay(person[key]);
    if("reasons" in person)copy.reasons=copyJson(equipmentOnly(person.reasons));
    if("evidence" in person)copy.evidence=Object.fromEntries(Object.entries(equipmentOnly(person.evidence))
      .map(([item,items])=>[equipmentNames[item],Array.isArray(items)?items.filter(visibleDetection).map(detectionForDisplay):[]]));
    for (const key of ["tracking_status","tracking_display"]) {
      const marker=person[key];
      if(typeof marker==="string")copy[key]=stateNames[marker]||marker;
      else if(marker && typeof marker==="object")copy[key]={...marker,
        ...(marker.state?{state:stateNames[marker.state]||marker.state}:{}),
        ...(marker.status?{status:stateNames[marker.status]||marker.status}:{})};
    }
    return copy;
  }

  function stopVideo() {
    clearTimeout(videoRetryTimer);videoRetryTimer=null;
    generation++;
    if (hls) { hls.destroy(); hls = null; }
    if (rtc) { rtc.close(); rtc = null; }
    video.srcObject = null; video.removeAttribute("src"); video.load();
    playbackStamp = null; ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function startVideo() {
    stopVideo();
    text("videoState", "连接原视频中");
    const current = generation;
    if (config.video_protocol === "webrtc") {
      rtc = new MediaMTXWebRTCReader({url: `/media/webrtc/${config.stream_path}/whep`,
        onError: () => { if (current === generation) text("videoState", "WebRTC 暂不可用；检查编码及媒体通道"); },
        onTrack: (event) => { if (current === generation) { video.srcObject = event.streams[0]; video.play().catch(() => {}); } }
      });
    } else if (Hls.isSupported()) {
      initializationStage="hls_constructor";
      hls = new Hls({lowLatencyMode:true,liveSyncDurationCount:2,liveMaxLatencyDurationCount:5,
        maxBufferLength:6,maxMaxBufferLength:10,backBufferLength:0,enableWorker:true});
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (current !== generation) return;
        if (data.fatal) {
          ctx.clearRect(0,0,canvas.width,canvas.height);
          if (data.type===Hls.ErrorTypes.NETWORK_ERROR) {
            text("videoState", "视频通道暂不可用，5 秒后重新连接");
            clearTimeout(videoRetryTimer);
            videoRetryTimer=setTimeout(()=>{if(current===generation)startVideo();},5000);
          } else text("videoState", "HLS 暂不可播放；需核对浏览器编码支持");
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      initializationStage="hls_media_attach";
      hls.loadSource(`/media/hls/${config.stream_path}/index.m3u8`);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = `/media/hls/${config.stream_path}/index.m3u8`;
      video.play().catch(() => {});
      // Native HLS exposes no hls.js playingDate anchor here; raw video remains
      // available while overlay is withheld until a separate verified anchor.
    } else {
      text("videoState", "此浏览器没有可用的 HLS 解码入口");
    }
  }

  async function pollResults() {
    const localStart = Date.now();
    pollController = new AbortController();
    const deadline = setTimeout(() => pollController.abort(), 2500);
    try {
      const response = await fetch("/api/results-history", {cache:"no-store",signal:pollController.signal});
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (!Array.isArray(data.results) || data.results.length > 100 || !finite(data.server_now_epoch_ms)) throw new Error("contract");
      clockOffset = data.server_now_epoch_ms - (localStart + Date.now())/2;
      history = data.results;
      historyFresh = data.state === "fresh";
      lastPoll = performance.now();
      const latest = history.at(-1);
      text("dataState", historyFresh && latest ? "采样结果可用" : "无新鲜结果");
      text("age", finite(data.latest_result_age_ms) ? `${Math.round(data.latest_result_age_ms)} ms` : "—");
      text("inference", latest && finite(latest.inference_ms) ? `${latest.inference_ms.toFixed(1)} ms` : "—");
      text("pts", latest && finite(latest.source_pts_seconds) ? latest.source_pts_seconds.toFixed(3) : "—");
      text("frameKey", latest ? `E${latest.capture_epoch} / S${latest.sequence}` : "—");
      text("people", latest && Array.isArray(latest.detections) ? latest.detections.filter(visibleDetection).length : "—");
      text("json", latest ? JSON.stringify({frame_size:latest.frame_size,source_pts_seconds:latest.source_pts_seconds,
        ppe_tracks:Array.isArray(latest.persons)?latest.persons.map(personForDisplay):[],
        detections:Array.isArray(latest.detections)?latest.detections.filter(visibleDetection).map(detectionForDisplay):[]},null,2) : "等待服务器检测 JSON");
    } catch (_) {
      history = []; historyFresh = false; text("dataState", "检测接口暂不可用");
    } finally {
      clearTimeout(deadline);
      pollTimer = setTimeout(pollResults, 200);
    }
  }

  function selectResult() {
    const playingDate = hls?.playingDate;
    const originalTime=playingDate instanceof Date ? playingDate.getTime() : NaN;
    const playTime = originalTime + alignmentOffset;
    playbackStamp = playTime;
    const serverNow=Date.now()+clockOffset;
    text("playDelay",finite(originalTime)?`${Math.round(serverNow-originalTime)} ms`:"—");
    timingState=OwnedOverlayTiming.selectSample({enabled:overlayEnabled,config,history,historyFresh,
      pollAgeMs:performance.now()-lastPoll,serverNowMs:serverNow,playingMs:playTime,videoSize:[video.videoWidth,video.videoHeight]});
    if (timingState.result) text("matchError",`${Math.round(timingState.errorMs)} ms（估计）`);
    return [timingState.result,timingState.message];
  }

  function drawBoxes(result, width, height) {
    const scale = Math.min(width/video.videoWidth,height/video.videoHeight);
    const ox=(width-video.videoWidth*scale)/2, oy=(height-video.videoHeight*scale)/2;
    const imageWidth=video.videoWidth*scale,imageHeight=video.videoHeight*scale;
    const placedLabels=[];
    const detections = Array.isArray(result.detections) ? result.detections.filter(visibleDetection).slice(0,300) : [];
    ctx.font="13px system-ui, sans-serif"; ctx.lineWidth=2;
    for (const det of detections) {
      const b=det.box;
      if (!Array.isArray(b) || b.length!==4 || !b.every(finite) || b[2]<=b[0] || b[3]<=b[1]) continue;
      const x=ox+Math.max(0,b[0])*scale, y=oy+Math.max(0,b[1])*scale;
      const w=(Math.min(video.videoWidth,b[2])-Math.max(0,b[0]))*scale;
      const h=(Math.min(video.videoHeight,b[3])-Math.max(0,b[1]))*scale;
      if (w<=0 || h<=0) continue;
      ctx.strokeStyle="#a6d878";ctx.strokeRect(x,y,w,h);
      const label=`${labels[det.label]}${finite(det.confidence)?` ${Math.round(det.confidence*100)}%`:""}`;
      if(imageWidth<=8 || imageHeight<20)continue;
      const labelWidth=Math.min(ctx.measureText(label).width+8,imageWidth),labelHeight=20;
      const labelLeft=Math.max(ox,Math.min(x,ox+imageWidth-labelWidth));
      const maxTop=oy+imageHeight-labelHeight;
      const findRow=(start)=>{
        let top=start;
        while(top<=maxTop){
          const overlaps=placedLabels.filter(r=>labelLeft<r.x+r.width && labelLeft+labelWidth>r.x &&
            top<r.y+r.height && top+labelHeight>r.y);
          if(!overlaps.length)return top;
          top=Math.max(...overlaps.map(r=>r.y+r.height))+2;
        }
        return null;
      };
      const initialTop=Math.max(oy,Math.min(y-21,maxTop));
      // Try rows below this label first; at the lower image edge, search from
      // the top instead of pushing text outside the actual video rectangle.
      const labelTop=findRow(initialTop)??findRow(oy);
      if(labelTop===null)continue;
      placedLabels.push({x:labelLeft,y:labelTop,width:labelWidth,height:labelHeight});
      ctx.fillStyle="rgba(8,18,30,.8)";ctx.fillRect(labelLeft,labelTop,labelWidth,labelHeight);
      ctx.fillStyle="#f3f6fa";ctx.fillText(label,labelLeft+4,labelTop+14,Math.max(1,labelWidth-8));
    }
  }

  function render() {
    const width=stage.clientWidth,height=stage.clientHeight,dpr=Math.min(window.devicePixelRatio||1,2);
    if (canvas.width!==Math.round(width*dpr) || canvas.height!==Math.round(height*dpr)) {canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
    const current = performance.now();
    if (current-countTime>1000) {displayFps=(shownFrames-lastCount)*1000/(current-countTime);lastCount=shownFrames;countTime=current;}
    text("fps", `显示帧率 ${displayFps.toFixed(1)} fps`);
    if (video.videoWidth) {text("dimensions",`${video.videoWidth}×${video.videoHeight}`);text("videoState", video.paused||video.readyState<3 ? "视频等待或暂停" : "原视频连续播放");}
    const [result, message]=selectResult();
    text("overlayState",message);
    if (!result) text("matchError","—");
    if (result && !video.paused && video.readyState>=3 && current-lastVideoFrameAt<750) drawBoxes(result,width,height);
    requestAnimationFrame(render);
  }
  let lastVideoFrameAt=0;
  function onVideoFrame() {shownFrames++;lastVideoFrameAt=performance.now();video.requestVideoFrameCallback(onVideoFrame);}

  window.addEventListener("DOMContentLoaded", async () => {
    try {
      initializationStage="configuration_fetch";
      const response=await fetch("/config.public.json",{cache:"no-store"});config=await response.json();
      if (typeof config.overlay_timing_verified!=="boolean") throw new Error("config");
      initializationStage="ui_bindings";
      for (const id of ["enableOverlay","offset","timingReport","playDelay","videoState","overlayState","matchError","restart","full"])
        if (!$(id)) throw new TypeError("owned_preview_dom_version_mismatch");
      alignmentOffset=config.overlay_clock_offset_ms;overlayEnabled=config.alignment_mode==="receive_time_estimate";
      $("offset").value=alignmentOffset;$("enableOverlay").checked=overlayEnabled;
      $("enableOverlay").addEventListener("change",()=>{overlayEnabled=$("enableOverlay").checked;});
      $("offset").addEventListener("input",()=>{const n=Number($("offset").value);if(Number.isInteger(n)&&n>=-10000&&n<=10000)alignmentOffset=n;});
      $("timingReport").addEventListener("click",()=>{
        const latest=history.at(-1);
        const selected=timingState?.result;
        const report={schema_version:"preview-calibration-1",recorded_at:new Date().toISOString(),
          receive_clock_approximation:true,sensor_exposure_or_exact_frame_verified:false,
          operator_preview_enabled:overlayEnabled,configured_timing_verified:config.overlay_timing_verified,
          alignment_mode:config.alignment_mode,
          overlay_clock_offset_ms:alignmentOffset,overlay_match_max_error_ms:config.overlay_match_max_error_ms,
          hls_playing_epoch_ms:finite(playbackStamp)?playbackStamp-alignmentOffset:null,
          corrected_playing_epoch_ms:finite(playbackStamp)?playbackStamp:null,server_clock_offset_ms:Math.round(clockOffset),
          result_frame_key:selected?{session_id:selected.session_id,capture_epoch:selected.capture_epoch,sequence:selected.sequence}:null,
          result_received_epoch_ms:selected?.decoder_received_epoch_ms??null,match_error_ms:timingState?.errorMs??null,
          latest_input_frame_key:latest?{session_id:latest.session_id,capture_epoch:latest.capture_epoch,sequence:latest.sequence}:null,
          video_size:[video.videoWidth,video.videoHeight],observed_display_fps:displayFps,
          visual_alignment_verified_by_operator:false};
        const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:"application/json"}));
        const link=document.createElement("a");link.href=url;link.download="preview-calibration.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      });
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onVideoFrame);
      else setInterval(() => {const count=video.getVideoPlaybackQuality?.().totalVideoFrames;if(finite(count)&&count>shownFrames){shownFrames=count;lastVideoFrameAt=performance.now();}},100);
      initializationStage="media_dependencies";
      if (typeof Hls!=="function" || typeof OwnedOverlayTiming?.selectSample!=="function") throw new ReferenceError("owned_preview_dependency_missing");
      startVideo();initializationStage="result_polling";pollResults();initializationStage="canvas_render";render();
      $("restart").addEventListener("click",startVideo);
      $("full").addEventListener("click",()=>{if(document.fullscreenElement)document.exitFullscreen();else stage.requestFullscreen?.();});
    } catch (error) {
      const name=["TypeError","ReferenceError","SyntaxError","RangeError","Error"].includes(error?.name)?error.name:"Error";
      text("videoState",`预览初始化失败：${initializationStage} (${name})`);
      console.error("owned_preview_initialization_failed",{stage:initializationStage,error_name:name});
    }
  });
  window.addEventListener("beforeunload",()=>{clearTimeout(pollTimer);pollController?.abort();stopVideo();});
})();
