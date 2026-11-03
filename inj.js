/**
 * 页面世界的中转脚本（由 content.js 通过 <script src> 注入，见 manifest 的
 * web_accessible_resources）。
 *
 * 为什么需要它：content.js 跑在隔离世界，DOM 是共享的，但**页面的 JS 全局和
 * 元素上挂的方法不共享** —— `window.ytInitialPlayerResponse`、
 * `movie_player.getPlayerResponse()` 在隔离世界里全是 undefined。
 * 而"正片时长参照"这条命脉在现场连着三版都没读到：
 *   v1.4.4 只读 `meta[itemprop=duration]`  → 进广告那一刻页面里没有这行 meta
 *   v1.4.5 又加"内联脚本正则"              → 现场 `🎯` 仍然一次没出现
 * 所以把读取搬进页面世界，并且**把候选值和它的 videoId 一起报回去**：
 * 播放器在播广告时可能报广告自己的 playerResponse（lengthSeconds 是广告时长），
 * 拿它当正片参照结论正好反过来。归属判断留给 content.js（id 与 URL 不符就不采用）。
 */
(function () {
  'use strict';
  var TAG = 'ytas-bridge';
  var lastJson = '';

  function urlId() {
    try {
      var u = new URL(location.href);
      var v = u.searchParams.get('v');
      if (v) return v;
      var m = /\/shorts\/([\w-]+)/.exec(u.pathname);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  function cand(src, vd) {
    if (!vd || !vd.videoId) return null;
    var d = parseFloat(vd.lengthSeconds);
    if (!(d > 0)) return null;
    return { src: src, id: String(vd.videoId), dur: d };
  }

  function read() {
    var mp = document.getElementById('movie_player');
    var cands = [];
    var api = false;
    // 1) 播放器当前的 playerResponse：SPA 换视频后它是新的（首屏那份不是）
    try {
      if (mp && typeof mp.getPlayerResponse === 'function') {
        api = true;
        var pr = mp.getPlayerResponse();
        var c1 = cand('player.getPlayerResponse', pr && pr.videoDetails);
        if (c1) cands.push(c1);
      }
    } catch (e) { /* ignore */ }
    // 2) 首屏内联那份：直接读对象，不用拿正则去啃几 MB 的脚本文本
    try {
      var c2 = cand('ytInitialPlayerResponse',
        window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails);
      if (c2) cands.push(c2);
    } catch (e) { /* ignore */ }
    // 3) 播放器此刻在播的 video id（辅助判断归属；播放器没初始化就是空）
    var playing = '';
    try {
      var vd = mp && typeof mp.getVideoData === 'function' ? mp.getVideoData() : null;
      playing = (vd && vd.video_id) || '';
    } catch (e) { /* ignore */ }
    return {
      __ytas: TAG, op: 'push',
      urlId: urlId(), playing: playing, cands: cands, playerApi: api,
    };
  }

  function push(force) {
    var d;
    try { d = read(); } catch (e) { return; }
    var json;
    try { json = JSON.stringify({ u: d.urlId, p: d.playing, c: d.cands, a: d.playerApi }); }
    catch (e) { return; }
    if (!force && json === lastJson) return;
    lastJson = json;
    try { window.postMessage(d, '*'); } catch (e) { /* ignore */ }
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__ytas !== TAG || d.op !== 'get') return;
    push(true);
  }, false);

  push(true);
  try { setInterval(function () { push(false); }, 1000); } catch (e) { /* ignore */ }
})();
