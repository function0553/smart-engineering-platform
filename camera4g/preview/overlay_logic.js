/* Pure receive-clock sampling policy; this does not claim exact frame matching. */
"use strict";
((root) => {
  const finite = (n) => typeof n === "number" && Number.isFinite(n);
  function selectSample(options) {
    const {enabled, config, history, historyFresh, pollAgeMs, serverNowMs, playingMs, videoSize} = options;
    if (!enabled) return {result:null,message:"等待时间校准"};
    if (!historyFresh || pollAgeMs > 1000 || !history.length) return {result:null,message:"结果已撤回"};
    if (!finite(playingMs)) return {result:null,message:"播放时间锚不可用"};
    if (serverNowMs-playingMs > config.history_seconds*1000 || playingMs-serverNowMs > 1000)
      return {result:null,message:"播放时间锚超出缓存窗口"};
    const newest=history.at(-1);
    if (!finite(newest.decoder_received_epoch_ms) || serverNowMs-newest.decoder_received_epoch_ms > config.overlay_sample_ttl_ms ||
        newest.decoder_received_epoch_ms-serverNowMs > 1000) return {result:null,message:"输入或推理已过期"};
    const candidates=history.filter(r => finite(r.decoder_received_epoch_ms) && r.decoder_received_epoch_ms<=playingMs &&
      r.session_id===newest.session_id && r.capture_epoch===newest.capture_epoch);
    // Choose the closest past receive time even if an upstream history is reordered.
    const selected=candidates.reduce((best,r) => !best || r.decoder_received_epoch_ms>best.decoder_received_epoch_ms ? r : best,null);
    if (!selected) return {result:null,message:"等待对应采样帧"};
    const errorMs=playingMs-selected.decoder_received_epoch_ms;
    if (errorMs>config.overlay_match_max_error_ms || errorMs>config.overlay_sample_ttl_ms)
      return {result:null,message:"播放帧附近没有新鲜结果"};
    if (!Array.isArray(selected.frame_size) || selected.frame_size[0]!==videoSize[0] || selected.frame_size[1]!==videoSize[1] ||
        selected.rotation_degrees!==0 || selected.mirror_horizontal!==false || selected.coordinate_space!=="oriented_source_pixels")
      return {result:null,message:"画面方向或尺寸尚未匹配"};
    return {result:selected,errorMs,message:"检测框：接收时间近似对齐"};
  }
  const api={selectSample};
  if (typeof module!=="undefined" && module.exports) module.exports=api;
  else root.OwnedOverlayTiming=api;
})(globalThis);
