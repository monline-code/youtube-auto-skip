/**
 * youtube-auto-skip 冒烟测试
 *
 * 前置：在仓库根目录执行 `npm install`
 * 运行：`npm test` 或 `node test/harness.js`
 *
 * 用 jsdom 真实加载 content.js，模拟 YouTube 广告页面的关键 DOM 结构，
 * 验证以下路径：
 *   A. 广告态 + 可见跳过按钮  -> 触发点击
 *   B. 广告态 + 无跳过按钮    -> 视频强跳（currentTime 推到片尾）
 *   C. 非广告态              -> 不点、不动进度（保护正片）
 *   D. seek 被忽略 -> 16x 加速 -> 广告结束后还原为「用户原速率」
 *   E. 扩展已禁用            -> 完全不动作
 */
const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (_) {
  console.error('缺少 jsdom，请先在仓库根目录执行: npm install');
  process.exit(3);
}

const EXT_DIR = path.join(__dirname, '..');
// YT_CONTENT 可指向另一份 content.js，用于回归对比（如验证某条防护是否真的起作用）
const CODE = fs.readFileSync(process.env.YT_CONTENT || path.join(EXT_DIR, 'content.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeChrome(init) {
  const sync = Object.assign({ enabled: true, debug: false }, init || {});
  const local = { skipped: 0 };
  const listeners = [];
  const fire = (area, changes) => listeners.forEach((l) => l(changes, area));
  const area = (bag, name) => ({
    get(defaults, cb) {
      const out = Object.assign({}, defaults);
      Object.keys(defaults).forEach((k) => { if (bag[k] !== undefined) out[k] = bag[k]; });
      setTimeout(() => cb(out), 0);
    },
    set(obj, cb) {
      const changes = {};
      Object.keys(obj).forEach((k) => {
        changes[k] = { oldValue: bag[k], newValue: obj[k] };
        bag[k] = obj[k];
      });
      setTimeout(() => { fire(name, changes); if (cb) cb(); }, 0);
    },
  });
  return {
    runtime: { id: 'test-ext', lastError: undefined, getManifest: () => ({ version: '1.3.0' }) },
    storage: {
      sync: area(sync, 'sync'),
      local: area(local, 'local'),
      onChanged: {
        addListener: (l) => listeners.push(l),
        removeListener: (l) => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); },
      },
    },
    __local: local,
    __sync: sync,
  };
}

// jsdom 不实现媒体播放，用自定义属性模拟 duration / currentTime / playbackRate
function makeVideo(win, opts) {
  const v = win.document.createElement('video');
  let t = opts.currentTime;
  let rate = opts.rate || 1;
  Object.defineProperty(v, 'duration', { get: () => opts.duration, configurable: true });
  Object.defineProperty(v, 'currentTime', {
    get: () => t,
    set: (val) => { if (opts.seekable !== false) t = val; },  // seekable:false 模拟「seek 被忽略」
    configurable: true,
  });
  Object.defineProperty(v, 'paused', { get: () => !!opts.paused, configurable: true });
  Object.defineProperty(v, 'readyState', { get: () => 4, configurable: true });
  Object.defineProperty(v, 'playbackRate', {
    get: () => rate,
    set: (val) => { rate = val; },
    configurable: true,
  });
  v.__getTime = () => t;
  return v;
}

async function loadPage(html, { video, enabled = true, debug = false, stub, zeroRect } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  // jsdom 的 getBoundingClientRect 恒为 0，会让 isVisible 全部判为不可见。
  // zeroRect 指定的元素仍返回 0×0，用来复现"用户看得见、但测量为 0"的按钮（真实日志场景）。
  win.Element.prototype.getBoundingClientRect = function () {
    if (zeroRect && this.matches && this.matches(zeroRect)) {
      return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0 };
    }
    return { width: 100, height: 30, left: 10, top: 10, right: 110, bottom: 40, x: 10, y: 10 };
  };
  const player = win.document.querySelector('#movie_player');
  if (video && player) player.appendChild(video);
  win.chrome = makeChrome({ enabled, debug });
  // debug 模式下截获扩展日志，供测试断言（如"是否为某按钮调度了点击"）
  const logs = [];
  if (debug) {
    win.console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  }
  if (stub) stub(win);
  win.eval(CODE);
  await sleep(60);   // 等 storage 回调 -> start()
  return { win, chrome: win.chrome, player, logs };
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
}

(async () => {
  // ---------- A: 有可见跳过按钮 -> 应点击 ----------
  {
    const html = `
      <div id="movie_player" class="html5-video-player ad-showing">
        <div class="ytp-ad-skip-button-modern">跳过广告</div>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: false });
    const { win } = await loadPage(html, { video });
    let clicks = 0;
    win.document.querySelector('.ytp-ad-skip-button-modern')
      .addEventListener('click', () => { clicks += 1; });
    await sleep(1200);
    check('A 可见跳过按钮被点击', clicks > 0, `clicks=${clicks}`);
  }

  // ---------- B: 无跳过按钮 -> 视频强跳 ----------
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: false });
    const { win } = await loadPage(html, { video });
    await sleep(2000);
    const t = win.document.querySelector('video').__getTime();
    check('B 广告视频被推到片尾', t > 14 && t <= 15, `currentTime=${t.toFixed(2)}`);
  }

  // ---------- C: 非广告态 -> 不动进度 ----------
  {
    const html = `<div id="movie_player" class="html5-video-player"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 600, currentTime: 120, paused: false });
    const { win } = await loadPage(html, { video });
    await sleep(1500);
    const t = win.document.querySelector('video').__getTime();
    check('C 非广告态不动正片进度', Math.abs(t - 120) < 0.01, `currentTime=${t}`);
  }

  // ---------- D: seek 无效 -> 16x 加速 -> 结束后还原原速率 ----------
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const video = makeVideo(new JSDOM('').window, {
      duration: 15, currentTime: 0.5, paused: false, seekable: false, rate: 2,
    });
    const { win, player } = await loadPage(html, { video });
    await sleep(4800);   // 等 seek 连续失败 -> 触发加速
    const rateDuringAd = win.document.querySelector('video').playbackRate;
    player.classList.remove('ad-showing');
    await sleep(900);
    const rateAfter = win.document.querySelector('video').playbackRate;
    check('D1 seek 无效时改用 16x 加速', rateDuringAd === 16, `ad 中 rate=${rateDuringAd}`);
    check('D2 广告结束后还原为用户原速率 2', rateAfter === 2, `结束后 rate=${rateAfter}`);
  }

  // ---------- E: 禁用状态下不动作 ----------
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: false });
    const { win } = await loadPage(html, { video, enabled: false });
    await sleep(1500);
    const t = win.document.querySelector('video').__getTime();
    check('E 已禁用时不动作', Math.abs(t - 0.5) < 0.01, `currentTime=${t}`);
  }

  // ---------- F: 跳过按钮藏在 <a> 宿主 shadow 内 -> 绝不能被调度/点击（S1 防御纵深） ----------
  // 第一道闸是 scheduleClick 里的 `document.contains(el)`：节点在 shadow root 内时
  // document.contains() 为 false，点击会被直接放弃。因此本用例断言两件事：
  //   (1) 按钮从未被点击；(2) 扩展从未为该按钮打印"准备点击"/排入队列。
  // 旧 isSafeClickTarget 用 closest('a[href]')（不跨 shadow）会误判安全并排入队列，
  // v1.2.6 沿 getRootNode().host 逐层检查后，连排入队列都不会发生。
  {
    const html = `
      <div id="movie_player" class="html5-video-player ad-showing">
        <a href="https://advertiser.example/landing">
          <div id="ad-host"></div>
        </a>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: false });
    const { win, logs } = await loadPage(html, { video, debug: true });
    let clicks = 0;
    const host = win.document.getElementById('ad-host');   // div 是合法 shadow 宿主
    const shadow = host.attachShadow({ mode: 'open' });
    const btn = win.document.createElement('button');
    btn.className = 'ytp-skip-ad-button';
    btn.textContent = '跳过';
    btn.addEventListener('click', () => { clicks += 1; });
    shadow.appendChild(btn);
    await sleep(2000);   // 留足深度扫描（800ms 节流）+ tick
    const scheduled = logs.filter((l) => l.indexOf('准备点击') >= 0 && l.indexOf('ytp-skip-ad-button') >= 0);
    check('F shadow 内跳过按钮既不被点击也不被调度（防落地页弹窗）',
      clicks === 0 && scheduled.length === 0,
      `clicks=${clicks}, 调度=${scheduled.length}`);
  }

  // ---------- G: 仅 overlay 信号、无 ad-showing -> 视频层强跳不得误伤正片（S2） ----------
  // adStateStrong() 仍会因 .ytp-ad-overlay-container 返回 true（点击路径仍可用），
  // 但视频层强跳（破坏性改 currentTime）现在用 isRealVideoAd() 仅看 .ad-showing，
  // 正片不得被推到结尾。这是 S2 的核心价值：避免把正片跳到大结局。
  {
    // 正片正在播放（duration=600, currentTime=120），播放器带 overlay 类但无 ad-showing
    const html = `<div id="movie_player" class="html5-video-player ytp-ad-overlay-container"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 600, currentTime: 120, paused: false });
    const { win } = await loadPage(html, { video });
    await sleep(1500);
    const t = win.document.querySelector('video').__getTime();
    check('G overlay 信号无 ad-showing 不误跳正片（S2）', Math.abs(t - 120) < 0.01, `currentTime=${t}`);
  }

  // ---------- H: shadow 内的跳过按钮应当被真实点击（v1.2.8 修复）----------
  // 深度扫描本来就是为"按钮藏在 shadow root 里"而加的，但点击前的存活判定用
  // document.contains(el) —— 对 shadow 内节点恒为 false，于是"找到了却被丢弃"。
  // v1.2.8 改用 isConnected 后，这条路径才真正走通。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing">
        <div id="safe-host"></div>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: false });
    const { win } = await loadPage(html, { video });
    const host = win.document.getElementById('safe-host');
    const shadow = host.attachShadow({ mode: 'open' });
    const btn = win.document.createElement('button');
    btn.className = 'ytp-skip-ad-button';
    btn.setAttribute('aria-label', '跳过广告');
    btn.textContent = '跳过广告';
    let clicks = 0;
    btn.addEventListener('click', () => { clicks += 1; });
    shadow.appendChild(btn);
    await sleep(3500);   // 深扫节流 2000ms + 点击延迟 300~900ms
    check('H shadow 内跳过按钮被真实点击', clicks > 0, `clicks=${clicks}`);
  }

  // ---------- I: 宿主被隐藏 -> shadow 内按钮不可见，不得点击（跨边界可见性）----------
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing">
        <div id="hidden-host" style="display:none"></div>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: false });
    const { win } = await loadPage(html, { video });
    const host = win.document.getElementById('hidden-host');
    const shadow = host.attachShadow({ mode: 'open' });
    const btn = win.document.createElement('button');
    btn.className = 'ytp-skip-ad-button';
    btn.setAttribute('aria-label', '跳过广告');
    let clicks = 0;
    btn.addEventListener('click', () => { clicks += 1; });
    shadow.appendChild(btn);
    await sleep(3500);
    check('I 宿主 display:none 时 shadow 内按钮不点击', clicks === 0, `clicks=${clicks}`);
  }

  // ---------- J: shadow 宿主是广告创意区 -> 仍不得点击（防落地页）----------
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing">
        <div id="creative-host" class="ytp-ad-clickable"></div>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: false });
    const { win } = await loadPage(html, { video });
    const host = win.document.getElementById('creative-host');
    const shadow = host.attachShadow({ mode: 'open' });
    const btn = win.document.createElement('button');
    btn.className = 'ytp-skip-ad-button';
    btn.setAttribute('aria-label', '跳过广告');
    let clicks = 0;
    btn.addEventListener('click', () => { clicks += 1; });
    shadow.appendChild(btn);
    await sleep(3500);
    check('J shadow 宿主为广告创意区时仍不点击', clicks === 0, `clicks=${clicks}`);
  }

  // ---------- K: 延迟点击期间广告结束、且期间没有 tick -> 仍不得点击（S1 + force）----------
  // 用例 3 之所以能拦住，是因为广告 DOM 被移除了（元素脱离文档）。这里保留按钮可见，
  // 只做"广告结束"这一件事，并用两个桩隔离变量：
  //   - MutationObserver 置空：广告结束不再触发即时重扫，制造"两次 tick 之间"的窗口
  //   - Math.random 固定为 0：点击延迟恒为 300ms，早于 600ms 的兜底轮询
  // 于是回调里的 adStateStrong() 只能读到上一次 tick 的结论（true）。若不复算，就会点击。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing">
        <div class="ytp-skip-ad-button" id="kb">跳过广告</div>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: true });
    const { win, player } = await loadPage(html, {
      video,
      stub: (w) => {
        w.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
        w.Math.random = () => 0;
      },
    });
    let clicks = 0;
    win.document.querySelector('#kb').addEventListener('click', () => { clicks += 1; });
    // 点击延迟已缩到 150–400ms（Math.random=0 -> 150ms），loadPage 内部等 60ms，
    // 首次 tick 已排入点击但尚未执行，此刻撤掉广告态才能落在延迟窗口内。
    player.className = 'html5-video-player';   // 广告结束：按钮仍在、依旧可见
    await sleep(700);
    check('K 延迟点击期间广告已结束则不点击', clicks === 0, `clicks=${clicks}`);
  }

  // ---------- L: 按钮 CSS 可见但 0×0 -> 仍应点击（真实日志场景）----------
  // 2026-11 的 YouTube 日志：`.ytp-skip-ad-button` 的 text="跳过"、rect=0x0，
  // 用户肉眼可见，扩展却因为尺寸为 0 一直拒绝，表现为"看到按钮但不点/点得晚"。
  // v1.3.0 对跳过语义的元素放宽：CSS 未隐藏即可点，点击走 el.click()。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing">
        <button id="zb" class="ytp-skip-ad-button">跳过</button>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: true });
    const { win } = await loadPage(html, { video, zeroRect: '#zb' });
    let clicks = 0;
    let firstAt = 0;
    const t0 = Date.now();
    win.document.querySelector('#zb').addEventListener('click', () => { clicks += 1; if (!firstAt) firstAt = Date.now() - t0; });
    await sleep(900);
    check('L 0×0 但可见的跳过按钮被点击', clicks > 0, `clicks=${clicks}, 首次点击 ${firstAt}ms`);
  }

  // ---------- N: 0×0 且 CSS 隐藏 -> 不得点击（放宽不能变成无脑点）----------
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing">
        <button id="hb" class="ytp-skip-ad-button" style="display:none">跳过</button>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: true });
    const { win } = await loadPage(html, { video, zeroRect: '#hb' });
    let clicks = 0;
    win.document.querySelector('#hb').addEventListener('click', () => { clicks += 1; });
    await sleep(900);
    check('N 0×0 且 display:none 的按钮不点击', clicks === 0, `clicks=${clicks}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
