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
  const msgListeners = [];
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
    runtime: {
      id: 'test-ext',
      lastError: undefined,
      getManifest: () => ({ version: require('../manifest.json').version }),
      getURL: (p) => 'chrome-extension://test-ext/' + p,
      onMessage: { addListener: (l) => msgListeners.push(l) },
    },
    storage: {
      sync: area(sync, 'sync'),
      local: area(local, 'local'),
      onChanged: {
        addListener: (l) => listeners.push(l),
        removeListener: (l) => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); },
      },
    },
    // 模拟 popup -> content script 的消息往返（popup 的「复制调试日志」走这条）
    __sendMessage: (msg) => {
      let out;
      msgListeners.forEach((l) => l(msg, {}, (r) => { out = r; }));
      return out;
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
  // readyState 可变：v1.3.5 的用例要复现"广告媒体没挂上 / 推完被摘流"的 readyState=0
  Object.defineProperty(v, 'readyState', {
    get: () => (opts.readyState === undefined ? 4 : opts.readyState),
    configurable: true,
  });
  Object.defineProperty(v, 'playbackRate', {
    get: () => rate,
    set: (val) => { rate = val; },
    configurable: true,
  });
  v.__getTime = () => t;
  return v;
}

// 模拟 inj.js 的 postMessage 上报（jsdom 里外部脚本不会执行，只能手工派事件）
function bridgePush(win, urlId, cands, playing) {
  try {
    win.dispatchEvent(new win.MessageEvent('message', {
      data: {
        __ytas: 'ytas-bridge', op: 'push',
        urlId: urlId, playing: playing || '', cands: cands || [], playerApi: true,
      },
      source: win,
    }));
  } catch (_) { /* ignore */ }
}

async function loadPage(html, { video, enabled = true, debug = false, stub, zeroRect, url } = {}) {
  // v1.4.4：默认给一个 watch 页 URL —— 正片时长参照要靠 URL 里的 video id 判断归属
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: url || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
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

  // ---------- O: 广告 pod（连播两支）复用同一 DOM 节点 -> 第二支不被上一支冷却挡住 ----------
  // 现场日志里出现过 30.1s + 39.7s 连续两支广告。YouTube 在 pod 内复用同一个
  // .ytp-skip-ad-button 节点，而点击冷却（3.5s）是按元素记的，不重置就会把
  // 第二支的点击挡掉一大截。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing">
        <button id="pb" class="ytp-skip-ad-button ytp-ad-skip-button-modern">跳过</button>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 20, currentTime: 1, paused: true });
    const { win } = await loadPage(html, { video });
    const times = [];
    const player = win.document.querySelector('#movie_player');
    const btn = win.document.querySelector('#pb');
    btn.addEventListener('click', () => times.push(Date.now()));
    await sleep(650);                                     // 第一支广告：点击已落地
    const firstAdClicks = times.length;
    // 第一支结束。注意 .ytp-ad-skip-button-modern 本身就是强广告信号，
    // 只摘 ad-showing 不足以让广告态退出 —— 必须把按钮移出文档。
    player.className = 'html5-video-player';
    btn.remove();
    await sleep(300);
    const secondAdStart = Date.now();
    player.className = 'html5-video-player ad-showing';   // 第二支开始
    player.appendChild(btn);                              // 复用同一个节点对象
    await sleep(700);
    const secondAdClicks = times.filter((t) => t >= secondAdStart).length;
    check('O 广告 pod 第二支不被上一支的点击冷却挡住',
      firstAdClicks > 0 && secondAdClicks > 0,
      `第1支 clicks=${firstAdClicks}, 第2支 clicks=${secondAdClicks}`);
  }

  // ---------- P: pod 两支广告且全程不摘 ad-showing（现场日志形态）----------
  // 真实日志里 15s → 36s 两支广告只记了"第 1 次"，说明 .ad-showing 没切换过，
  // v1.3.1 靠 adEpoch 的重置不会触发。这种形态只能靠"被跳的视频时长变了"认出下一支。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing">
        <button id="qb" class="ytp-skip-ad-button">跳过</button>
      </div>`;
    const opts = { duration: 15, currentTime: 1, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { win } = await loadPage(html, { video });
    let clicks = 0;
    win.document.querySelector('#qb').addEventListener('click', () => { clicks += 1; });
    await sleep(1300);                       // 第一支：点击已落地、且已被视频层强跳
    const afterFirst = clicks;
    opts.duration = 36;                      // 第二支广告：时长变了，但仍是同一个 <video>
    video.currentTime = 1;
    await sleep(1800);
    check('P pod 不摘 ad-showing 时第二支仍能点击',
      afterFirst > 0 && clicks > afterFirst,
      `第1支 clicks=${afterFirst}，累计 clicks=${clicks}`);
  }

  // ---------- Q: 已知正片时长且与广告不同 -> 不再统一等 800ms ----------
  // v1.3.3：原来 tick 里写死"广告态满 800ms 才强跳"，用户体感就是"广告先播一秒"。
  // 现在只要能证明"这个 video 不是正片"（时长与 mainDur 明显不同）就立刻动手。
  {
    const html = `<div id="movie_player" class="html5-video-player"></div>`;
    const opts = { duration: 600, currentTime: 120, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { win, player, logs } = await loadPage(html, { video, debug: true });
    await sleep(700);                       // 先让 mainDur 记到 600（非广告态）
    opts.duration = 15;                     // 切广告
    video.currentTime = 0.5;
    player.classList.add('ad-showing');
    await sleep(1600);
    // 用日志里的相对时间戳量"从认出广告到真的强跳"的间隔，比按墙钟取整更稳
    const stamp = (re) => {
      for (const line of logs) {
        const m = new RegExp(re + '.*?\\+(\\d+)ms').exec(String(line)) ||
                  new RegExp('\\+(\\d+)ms.*?' + re).exec(String(line));
        if (m) return Number(m[1]);
      }
      return -1;
    };
    const tAd = stamp('检测到广告开始');
    const tJump = stamp('视频层强跳');
    const delta = tAd >= 0 && tJump >= 0 ? tJump - tAd : -1;
    check('Q mainDur 已知时广告不再等 800ms 才强跳',
      delta >= 0 && delta <= 450,
      `认广告 +${tAd}ms → 强跳 +${tJump}ms（间隔 ${delta}ms）`);
  }

  // ---------- R: mainDur 未知（打开链接先播广告）-> 仍保留 800ms 确认窗口 ----------
  // 这是 Q 的安全边界：证明不了"不是正片"时不能省这 0.8 秒，
  // 否则可能把正片当成广告推到片尾。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: false });
    const { win } = await loadPage(html, { video });
    await sleep(500);
    const early = win.document.querySelector('video').__getTime();
    await sleep(800);
    const late = win.document.querySelector('video').__getTime();
    check('R mainDur 未知时保留 800ms 确认窗口',
      early < 14 && late > 14, `500ms 时=${early.toFixed(2)}, 1300ms 时=${late.toFixed(2)}`);
  }

  // ---------- S: 0×0 按钮 + 有尺寸的外壳 -> 点击升级到外壳 ----------
  // 没有布局盒的元素上 el.click() 常是空操作，YouTube 的命中测试按几何盒子走。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing">
        <div id="sh" class="ytp-ad-skip-button-container">
          <button id="sb" class="ytp-skip-ad-button">跳过</button>
        </div>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: true });
    const { win } = await loadPage(html, { video, zeroRect: '#sb' });
    let shellClicks = 0;
    win.document.querySelector('#sh').addEventListener('click', () => { shellClicks += 1; });
    await sleep(900);
    check('S 0×0 按钮的点击升级到有尺寸的外壳', shellClicks > 0, `shell clicks=${shellClicks}`);
  }

  // ---------- T: 广告贴尾但被暂停 -> 主动续播（现场 9.2s 卡顿）----------
  // 日志里第一支跳到 27.7 后，播放器暂停等切流，之后 9.2 秒 tick 全被
  // "暂停中不动进度"静默挡掉，用户看到的就是广告一直挂着。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const opts = { duration: 15, currentTime: 14.8, paused: true };
    const video = makeVideo(new JSDOM('').window, opts);
    let plays = 0;
    video.play = () => { plays += 1; return Promise.resolve(); };
    const { win } = await loadPage(html, { video });
    await sleep(1400);
    const t = win.document.querySelector('video').__getTime();
    check('T 广告贴尾且暂停时主动续播', plays > 0, `play() ${plays} 次, currentTime=${t.toFixed(2)}`);
  }

  // ---------- U: 推完结尾后 video 停在 readyState=0 -> 催流（现场 7~9 秒切流）----------
  // 2026-11-02 日志：每推完一支广告，<video> 就在 readyState=0 上挂 7~9 秒，
  // 期间 .ad-showing 还在、画面停在最后一帧，seek 一定无效。能做的只有把
  // media element 的资源加载算法重新拉起来 —— 对 readyState=0 的元素调 play()。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const opts = { duration: 15, currentTime: 0.5, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    let plays = 0;
    video.play = () => { plays += 1; return Promise.resolve(); };
    const { win, logs } = await loadPage(html, { video, debug: true });
    await sleep(1200);                       // 此时已强跳到 14.95
    const jumped = win.document.querySelector('video').__getTime();
    const playsBefore = plays;
    opts.readyState = 0;                     // 播放器把媒体摘了（切流）
    await sleep(1600);
    const nudged = logs.filter((l) => l.indexOf('催流') >= 0).length;
    check('U 推完结尾后 readyState=0 会催流 play()',
      jumped > 14 && playsBefore === 0 && plays > 0 && plays <= 3 && nudged > 0,
      `跳后 currentTime=${jumped.toFixed(2)}, play() 前=${playsBefore} 后=${plays}, 催流日志=${nudged}`);
  }

  // ---------- V: 没推过的广告在 readyState=0 时不得 play()、不得 seek ----------
  // 边界：媒体压根没加载时 play() 也可能被调用去拉流，但那属于"广告还没开始播"，
  // 不是我们该插手的地方；此处的催流只针对"我们自己把它推到了结尾"的那种 0。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const opts = { duration: 15, currentTime: 0.5, paused: false, readyState: 0 };
    const video = makeVideo(new JSDOM('').window, opts);
    let plays = 0;
    video.play = () => { plays += 1; return Promise.resolve(); };
    const { win, logs } = await loadPage(html, { video, debug: true });
    await sleep(1600);
    const t = win.document.querySelector('video').__getTime();
    const reason = logs.some((l) => l.indexOf('readyState=0（广告媒体未加载）') >= 0);
    check('V 媒体未加载时不催流、不 seek，并说清原因',
      plays === 0 && Math.abs(t - 0.5) < 0.01 && reason,
      `play()=${plays}, currentTime=${t.toFixed(2)}, 原因日志=${reason}`);
  }

  // ---------- W: 广告结束打印耗时归因汇总 ----------
  // 现场 18.2 秒里只有 1.8 秒真的在播广告，靠人工数日志才能看出来。
  // 现在这条汇总直接给出：总时长 / 首次动手 / 强跳次数 / 媒体未就绪累计。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const opts = { duration: 15, currentTime: 0.5, paused: false, readyState: 0 };
    const video = makeVideo(new JSDOM('').window, opts);
    const { win, player, logs } = await loadPage(html, { video, debug: true });
    await sleep(1500);                       // 全程 readyState=0，累计"媒体未就绪"
    opts.readyState = 1;
    await sleep(700);                        // 媒体就绪 -> 强跳
    player.className = 'html5-video-player'; // 广告结束
    await sleep(800);
    const sum = logs.find((l) => l.indexOf('📊 广告结束') >= 0) || '';
    const ready = logs.find((l) => l.indexOf('🎬 广告媒体就绪') >= 0) || '';
    const m = /媒体未就绪累计 (\d+)ms/.exec(sum);
    check('W 广告结束打印耗时归因汇总',
      !!sum && !!ready && m && Number(m[1]) > 300,
      sum || '（没有汇总日志）');
  }

  // ---------- X: popup「复制调试日志」只回本扩展的行 ----------
  // 现场日志动辄几百行 YouTube 噪音（preload / CSP / serviceworker），
  // 手工从控制台挑行既慢又容易被长文本粘贴截断。改成由内容脚本自己攒缓冲。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: false });
    const { chrome: ch } = await loadPage(html, { video, debug: true });
    await sleep(1200);
    const resp = ch.__sendMessage({ type: 'ytAutoSkip:dumpLog' });
    const ver = require('../manifest.json').version;
    const first = String((resp && resp.text) || '').split('\n')[0];
    const ok = !!resp && resp.count > 0 && resp.version === ver
      && /视频层强跳/.test(resp.text)
      && first.indexOf('v' + ver) >= 0          // 首行是版本头（v1.3.7）
      && String(resp.text).split('\n').every((l) => l.indexOf('[YT-AutoSkip]') >= 0);
    check('X popup 可一键导出扩展日志（不含页面噪音）',
      ok, resp ? `count=${resp.count}, version=${resp.version}, 首行=${first.slice(0, 40)}` : '无响应');
  }

  // ---------- Y: 调试关闭时导出为空，且不误报"有日志" ----------
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: false });
    const { chrome: ch } = await loadPage(html, { video, debug: false });
    await sleep(900);
    const resp = ch.__sendMessage({ type: 'ytAutoSkip:dumpLog' });
    check('Y 调试关闭时导出为空并如实回报 debug=false',
      !!resp && resp.count === 0 && resp.debug === false,
      resp ? `count=${resp.count}, debug=${resp.debug}` : '无响应');
  }

  // ---------- Z: 广告起播卡在 ct=0 也直接强跳（v1.3.7）----------
  // 现场日志（v1.3.6）：第二支广告媒体就绪时 ct=0，起播卡住，3 个 tick 后才爬过
  // 0.3——`ct < 0.3` 这条门白吃 800ms。贴尾 seek 在 ct≈0 时其实照样有效。
  {
    const html = `<div id="movie_player" class="html5-video-player"></div>`;
    const opts = { duration: 600, currentTime: 120, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { win, player, logs } = await loadPage(html, { video, debug: true });
    await sleep(700);                        // 先记下 mainDur=600（跳过 800ms 确认窗口）
    opts.duration = 15;                      // 切广告
    video.currentTime = 0;                   // 起播卡在 0：时钟一直不走
    player.classList.add('ad-showing');
    await sleep(900);
    const t = win.document.querySelector('video').__getTime();
    const earlyLog = logs.some((l) => l.indexOf('起播期 ct=') >= 0);
    check('Z 广告起播卡在 ct=0 也直接强跳（不等 0.3s）',
      t > 14 && earlyLog, `currentTime=${t.toFixed(2)}, 起播期日志=${earlyLog}`);
  }

  // ---------- AA: 起播期 seek 被播放器丢弃 -> 不计入 seekFails、不误触 16× ----------
  // 宽容必须有限：起播期 seek 最多放宽 EARLY_SEEK_MAX 次，用完之后回到原来的等待，
  // 免得"seek 一直被忽略"变成无限重试，也免得把 seekFails 顶到 2 误开 16× 加速。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const video = makeVideo(new JSDOM('').window,
      { duration: 15, currentTime: 0, paused: false, seekable: false, rate: 1 });
    const { win, logs } = await loadPage(html, { video, debug: true });
    await sleep(4400);                       // 宽容 2 次用完（tick 间隔约 1.2s）
    const v = win.document.querySelector('video');
    const dropped = logs.some((l) => l.indexOf('起播期 seek 被丢弃') >= 0);
    const capped = logs.some((l) => l.indexOf('起播期已宽容') >= 0);
    check('AA 起播期 seek 被丢弃不算无效、不误触 16× 加速',
      v.playbackRate === 1 && dropped && capped,
      `rate=${v.playbackRate}, 丢弃日志=${dropped}, 宽容用完=${capped}`);
  }

  // ---------- AB: 点不动的按钮 -> 点满预算就熔断（v1.3.8）----------
  // 现场事故：那支 589 秒的广告里我们每 4.2 秒点一次同一个按钮，共 140 次，
  // 一次都没生效，还把 500 行日志缓冲刷满、把"广告开始"挤掉了。
  // 时长设成 600s 是为了让"时长超上限"分支先挡住强跳，纯看点击这一路。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing">
        <button id="sb" class="ytp-skip-ad-button">跳过</button>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 600, currentTime: 1, paused: false });
    const { logs } = await loadPage(html, { video, debug: true });
    await sleep(20000);                      // 冷却 3.5s × 5 次 + 熔断那一条
    const clicks = logs.filter((l) => l.indexOf('🖱️ 实际点击') >= 0).length;
    const capped = logs.some((l) => l.indexOf('停止重试') >= 0);
    check('AB 按钮点击无效时按预算熔断（不再无限重试）',
      clicks > 0 && clicks <= 4 && capped, `实际点击=${clicks}, 熔断日志=${capped}`);
  }

  // ---------- AC: 广告态 + 媒体时长超过上限 -> 不推、只解释一次（v1.3.8）----------
  // 现场那支 581.7 秒的"广告"让 dur=581.681 每 5 秒重复一行，几百行里看不出
  // 结论。这里要求：不碰进度 + 只打一条说清"这不是能跳的东西"。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 581.7, currentTime: 0, paused: false });
    const { win, logs } = await loadPage(html, { video, debug: true });
    await sleep(4000);
    const t = win.document.querySelector('video').__getTime();
    const explain = logs.filter((l) => l.indexOf('不参与强跳') >= 0).length;
    check('AC 时长超过上限的"广告"不推、只解释一次',
      Math.abs(t) < 0.01 && explain === 1, `currentTime=${t.toFixed(2)}, 解释行=${explain}`);
  }

  // ---------- AD: 广告自己播完的，不算"我们跳掉的"（v1.3.8）----------
  // 以前只判"期间动过手"，于是点了 140 次全无效、一路播到底的那支也被记成
  // "自动跳过 1 次"。现在要求动作发生在上一次点击 5 秒内，才计数。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing">
        <button id="sb" class="ytp-skip-ad-button">跳过</button>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 600, currentTime: 1, paused: false });
    const { win, player, chrome: ch } = await loadPage(html, { video });
    // 点一次就让按钮消失：否则冷却一过又会点，最后一次动作永远离结束很近
    const btn = win.document.querySelector('#sb');
    btn.addEventListener('click', () => btn.remove(), { once: true });
    await sleep(1500);                       // 已经点过（epochActed=true），按钮随即消失
    await sleep(6000);                       // 之后广告还继续播了 6 秒
    player.className = 'html5-video-player'; // 广告自己结束
    await sleep(400);
    check('AD 广告自己播完不虚增计数', (ch.__local.skipped || 0) === 0,
      `skipped=${ch.__local.skipped}`);
  }

  // ---------- AE: 点完马上结束 -> 正常计数（AD 的对照，防一刀切）----------
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing">
        <button id="sb" class="ytp-skip-ad-button">跳过</button>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 600, currentTime: 1, paused: false });
    const { player, chrome: ch } = await loadPage(html, { video });
    await sleep(1200);                       // 点击发生
    player.className = 'html5-video-player'; // 紧接着广告结束
    await sleep(400);
    check('AE 点完立即结束仍然计数', (ch.__local.skipped || 0) === 1,
      `skipped=${ch.__local.skipped}`);
  }

  // ---------- AF: 有可见广告 UI -> 仍判广告态并点击（双条件不误伤真广告）----------
  // v1.3.9 把 adStateStrong 收紧为"必须有可见广告 UI"。这里确保：广告 UI 在时
  // （覆盖层可见 + 跳过按钮可见），点击路径照常工作，不会被新判据误伤。
  {
    const html = `
      <div id="movie_player" class="html5-video-player ad-showing">
        <div class="ytp-ad-player-overlay"></div>
        <div class="ytp-skip-ad-button">跳过广告</div>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: false });
    const { win, logs } = await loadPage(html, { video, debug: true });
    let clicks = 0;
    win.document.querySelector('.ytp-skip-ad-button').addEventListener('click', () => { clicks += 1; });
    await sleep(1200);
    const beat = logs.find((l) => l.indexOf('调试心跳') >= 0) || '';
    check('AF 有可见广告 UI 时判为广告态并点击',
      clicks > 0 && beat.indexOf('strong= true') >= 0, `clicks=${clicks}, 心跳=${beat.slice(0, 46)}`);
  }

  // ---------- AG: .ad-showing 残留（无任何可见广告 UI）-> 判为非广告态 ----------
  // v1.3.8 现场：广告结束后 .ad-showing 残留、正片在播，但扩展每 tick 仍当广告处理，
  // 干等近 10 分钟、统计虚报 360s。v1.3.9 要求：没有任何可见广告 UI 时，心跳判 non-ad。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 341.8, currentTime: 0, paused: false });
    const { win, logs } = await loadPage(html, { video, debug: true });
    await sleep(1500);
    const beat = logs.find((l) => l.indexOf('调试心跳') >= 0) || '';
    const t = win.document.querySelector('video').__getTime();
    check('AG ad-showing 残留（无广告 UI）判为非广告态且不动进度',
      beat.indexOf('strong= false') >= 0 && Math.abs(t) < 0.01,
      `心跳=${beat.slice(0, 46)}, currentTime=${t.toFixed(2)}`);
  }

  // ---------- AH: 只有广告覆盖层、没有 .ad-showing -> 仍然强跳（v1.4.0）----------
  // 现场（v1.3.9，连续 970 秒）：adPlaying= true / strong= true（覆盖层可见），
  // 但强跳窗口只看 .ad-showing，于是一次都没动手，日志里连"未动进度"都没有。
  {
    const html = `<div id="movie_player" class="html5-video-player">
        <div class="ytp-ad-player-overlay"></div>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 15, currentTime: 0.5, paused: false });
    const { win, logs } = await loadPage(html, { video, debug: true });
    await sleep(2500);
    const t = win.document.querySelector('video').__getTime();
    check('AH 只有广告覆盖层（无 ad-showing）也强跳', t > 14,
      `currentTime=${t.toFixed(2)}, 有强跳日志=${logs.some((l) => l.indexOf('强跳') >= 0)}`);
  }

  // ---------- AI: 真残留（媒体时长 = 正片时长 + 可见空壳按钮）-> 8s 判残留退出 ----------
  // 现场（v1.3.8）：广告结束后 .ad-showing 残留、播放器里跑的是正片，跳过按钮还是
  // 86x36 的空壳。旧版点满预算 → 每 4 秒刷"冷却/排队中" → 📊 永不触发，一挂 700 秒。
  // v1.4.1：判据从"时长 > 300s"改成"时长 = mainDur"。这里先让正片播 700ms 记下
  // mainDur=3225，再挂 .ad-showing 模拟残留。
  {
    const html = `<div id="movie_player" class="html5-video-player">
        <button class="ytp-skip-ad-button">跳过</button>
      </div>`;
    const opts = { duration: 3225, currentTime: 3.4, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { player, logs } = await loadPage(html, { video, debug: true });
    await sleep(700);                       // 非广告态：记下 mainDur = 3225
    player.classList.add('ad-showing');     // 广告结束，类名残留
    await sleep(10000);
    const residual = logs.some((l) => l.indexOf('判定为广告态残留') >= 0);
    const summary = logs.some((l) => l.indexOf('📊 广告结束') >= 0);
    const t = video.__getTime();
    check('AI 残留（时长与正片一致）8s 内退出、不碰进度、不写广告汇总',
      residual && !summary && Math.abs(t - 3.4) < 0.01,
      `残留=${residual}, 📊=${summary}, ct=${t.toFixed(2)}`);
  }

  // ---------- AJ: 长广告（时长是广告自己的，与正片明显不同）-> 照样强跳 ----------
  // v1.4.1 现场：那支广告本身是 3225 秒，mainDur= 5536.081。旧规则只看"3225 > 300"
  // 就判成正片，一句 🚫 之后 700 秒不再动手，用户实打实看了 16 分钟广告。
  // 正确判据是"和 mainDur 比"：差得远 → 这不是正片 → 多长都能推。
  {
    const html = `<div id="movie_player" class="html5-video-player"></div>`;
    const opts = { duration: 5536, currentTime: 300, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { player, logs } = await loadPage(html, { video, debug: true });
    await sleep(700);                        // 记下 mainDur = 5536
    opts.duration = 3225;                    // 切到那支 53 分钟的长广告
    video.currentTime = 3.4;
    player.classList.add('ad-showing');
    await sleep(1600);
    const t = video.__getTime();
    check('AJ 长广告（时长 ≠ 正片）照样强跳到结尾',
      t > 3224, `currentTime=${t.toFixed(2)}, 有长广告日志=${logs.some((l) => l.indexOf('长广告强跳') >= 0)}`);
  }

  // ---------- AK: 长时长 + mainDur 未知 -> 仍然不推（AJ 的安全边界）----------
  // 打开链接先播广告时没有任何参照。宁可漏跳这一支，也不能把正片推到大结局。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 3225, currentTime: 3.4, paused: false });
    const { logs } = await loadPage(html, { video, debug: true });
    await sleep(2500);
    const t = video.__getTime();
    const explain = logs.filter((l) => l.indexOf('不参与强跳') >= 0).length;
    check('AK 没有正片时长作参照时不碰长媒体',
      Math.abs(t - 3.4) < 0.01 && explain >= 1, `ct=${t.toFixed(2)}, 解释行=${explain}`);
  }

  // ---------- AL: 广告在播但没挂 .ad-showing -> 也要强跳（v1.4.2）----------
  // 现场（v1.3.9 日志前 970 秒 ≈ 16 分钟）：`adPlaying= true | .ad-showing= false |
  // 命中数= 0`，心跳一直 strong= true（有广告覆盖层可见），可窗口既不看 adPlaying
  // 也不看这个覆盖层 → 整段没开窗、一次都没动手。用户确认那段时间广告是真的在播。
  // 这里用 #player-ads（在 AD_OVERLAY 里、不在 AD_FRAME 里）+ 时长已证明 ≠ 正片。
  {
    const html = `<div id="movie_player" class="html5-video-player"></div>
      <div id="player-ads"></div>`;
    const opts = { duration: 5536, currentTime: 300, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { logs } = await loadPage(html, { video, debug: true });
    await sleep(700);                        // 非广告态：记下 mainDur = 5536
    opts.duration = 3225;                    // 换成广告（没有 .ad-showing）
    video.currentTime = 3.4;
    await sleep(1800);
    const t = video.__getTime();
    check('AL 只有广告覆盖层、没有 ad-showing 的长广告也强跳',
      t > 3224, `currentTime=${t.toFixed(2)}, 检测=${logs.some((l) => l.indexOf('检测到广告开始') >= 0)}`);
  }

  // ---------- AM: 覆盖层可见 + 时长就是正片 -> 仍然不动（AL 的安全边界）----------
  // #player-ads 在正片播放时也常驻可见，单靠 isAdPlaying() 会把正片当广告。
  // 所以 AL 那条必须叠加"时长 ≠ 正片"，这里验证时长一致时一步都不动。
  {
    const html = `<div id="movie_player" class="html5-video-player"></div>
      <div id="player-ads"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 5536, currentTime: 300, paused: false });
    const { logs } = await loadPage(html, { video, debug: true });
    await sleep(2000);
    const t = video.__getTime();
    check('AM 覆盖层可见但时长等于正片时不动进度',
      Math.abs(t - 300) < 0.01 && !logs.some((l) => l.indexOf('检测到广告开始') >= 0),
      `currentTime=${t.toFixed(2)}`);
  }

  // ---------- AN: 跳过 pod 里第一支后，正片时长参照仍然有效 -> 下一支长广告照样跳 ----------
  // 现场（v1.4.2 日志）：+363689 跳掉 15s 那支时把 mainDur 清零，5 秒后 ad 3 换上一支
  // 3225s 的媒体时已经没有参照，只能 🚫 放弃、用户继续硬看。跳一支广告不会改变
  // 正片时长，参照只该由"换视频"作废。
  {
    const html = `<div id="movie_player" class="html5-video-player"></div>`;
    const opts = { duration: 5536, currentTime: 300, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { player, logs } = await loadPage(html, { video, debug: true });
    await sleep(700);                        // 记下 mainDur = 5536
    opts.duration = 15;                      // pod 第一支：15s 短广告
    video.currentTime = 0.5;
    player.classList.add('ad-showing');
    await sleep(1400);
    const afterFirst = video.__getTime();
    opts.duration = 3225;                    // pod 第二支：53 分钟长广告（.ad-showing 不摘）
    video.currentTime = 0;
    await sleep(1800);
    const t = video.__getTime();
    check('AN 跳完一支后 mainDur 不作废，pod 里下一支长广告照样强跳',
      afterFirst > 14 && t > 3224,
      `第一支 ct=${afterFirst.toFixed(1)}, 第二支 ct=${t.toFixed(1)}, 长广告日志=${logs.some((l) => l.indexOf('长广告强跳') >= 0)}`);
  }

  // ---------- AO: 残留期的"点不动"只提示一次，不再每 6 秒刷屏 ----------
  // 现场（v1.4.2 日志）：+762057 判残留后仍然每 4~6 秒一行"冷却/排队中"，挂了 180 秒。
  {
    const html = `<div id="movie_player" class="html5-video-player">
        <button class="ytp-skip-ad-button">跳过</button>
      </div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 3225, currentTime: 3.4, paused: false });
    const { player, logs } = await loadPage(html, { video, debug: true });
    await sleep(700);                        // 记下 mainDur = 3225
    player.classList.add('ad-showing');      // 广告结束，类名残留
    await sleep(24000);                      // 残留 8s 退出后还要继续挂一段才看得出刷屏
    const residual = logs.some((l) => l.indexOf('判定为广告态残留') >= 0);
    const cool = logs.filter((l) => l.indexOf('不再重复点击') >= 0).length;
    check('AO 残留期"点不动"只提示一次', residual && cool <= 1, `残留=${residual}, 提示行=${cool}`);
  }

  // ---------- AP: 心跳必须带判据事实（dur / ct / mainDur / 窗口）----------
  // 现场那份日志里 321 秒 `strong=true | .ad-showing=false | 命中数=0`，光看这几项
  // 判不出是"广告在播"还是"正片 + #player-ads 常驻横幅"，只能再赌一次。
  {
    const html = `<div id="movie_player" class="html5-video-player"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 600, currentTime: 120, paused: false });
    const { logs } = await loadPage(html, { video, debug: true });
    await sleep(1200);
    const beat = logs.filter((l) => l.indexOf('调试心跳') >= 0).pop() || '';
    check('AP 心跳带 dur/ct/mainDur/窗口 四个事实',
      /dur=/.test(beat) && /ct=/.test(beat) && /mainDur=/.test(beat) && /窗口=/.test(beat),
      beat.replace(/^\[YT-AutoSkip\]\s*/, '').slice(0, 120));
  }

  // ---------- AQ: 预播广告没有 mainDur -> 用页面元数据里的正片时长兜底 ----------
  // 现场（v1.4.3 日志）：换视频后 `yt-navigate-finish` 清掉 mainDur，新正片的 metadata
  // 还没进 <video>（那时报的是广告时长），于是 dur=1086.5 的广告"没有参照"只能 🚫。
  // watch 页 <meta itemprop="duration"> 描述的是正片，广告在播时也读得到。
  {
    const html = `<meta itemprop="duration" content="PT16M14S">
      <div id="movie_player" class="html5-video-player"></div>`;
    const opts = { duration: 313.5, currentTime: 100, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { win, player, logs } = await loadPage(html, { video, debug: true });
    await sleep(700);                                   // 先记下上一支视频 mainDur=313.5
    win.history.pushState({}, '', '/watch?v=newVideoId');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));  // 换视频 -> 参照归零
    opts.duration = 1086.5;                            // 新视频的预播广告
    video.currentTime = 0.5;
    player.classList.add('ad-showing');
    await sleep(2000);
    const t = video.__getTime();
    const metaLog = logs.some((l) => l.indexOf('正片时长参照取自页面') >= 0);
    check('AQ 没有 mainDur 时用页面元数据当正片参照',
      t > 1086 && metaLog, `currentTime=${t.toFixed(2)}, 元数据日志=${metaLog}`);
  }

  // ---------- AR: 元数据时长就是当前媒体 -> 仍然不动（AQ 的安全边界）----------
  // 少一个"元数据读错/过期"就推错的风险口子：两者一致时它只可能是正片。
  {
    const html = `<meta itemprop="duration" content="PT18M6.5S">
      <div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 1086.5, currentTime: 0.5, paused: false });
    const { logs } = await loadPage(html, { video, debug: true });
    await sleep(2500);
    const t = video.__getTime();
    check('AR 元数据时长与媒体一致时不碰进度',
      Math.abs(t - 0.5) < 0.01, `currentTime=${t.toFixed(2)}, 强跳日志=${logs.some((l) => l.indexOf('视频层强跳') >= 0)}`);
  }

  // ---------- AS: 同一个视频重发导航事件 -> 参照保留；换了 video id -> 参照作废 ----------
  // 现场（v1.4.3 日志）+386286：跳完 15s 那支后 mainDur 突然变"未知"，正是导航事件
  // 清掉的。同一支视频里清参照等于自废武功，必须只在 id 真变了时才清。
  {
    const html = `<meta itemprop="duration" content="PT5M13.5S">
      <div id="movie_player" class="html5-video-player"></div>`;
    const opts = { duration: 313.5, currentTime: 100, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { win, logs } = await loadPage(html, { video, debug: true });
    await sleep(700);                                  // 记下 mainDur = 313.5（id=dQw4w9WgXcQ）
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));  // 同一支视频重发
    opts.duration = 1086.5;                            // 预播广告
    video.currentTime = 0.5;
    win.document.querySelector('#movie_player').classList.add('ad-showing');
    await sleep(1800);
    const t1 = video.__getTime();
    check('AS1 同一视频重发导航事件不作废 mainDur（广告照样跳）',
      t1 > 1086, `currentTime=${t1.toFixed(2)}`);
    // 换视频：pushState 改 id 后再发导航事件 -> 参照必须作废
    win.history.pushState({}, '', '/watch?v=otherVideoId');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    const player = win.document.querySelector('#movie_player');
    player.classList.remove('ad-showing');
    opts.duration = 700;                               // 新正片（与旧参照 313.5 不同）
    video.currentTime = 5;
    await sleep(300);
    player.classList.add('ad-showing');                // 残留广告类名
    await sleep(1500);
    const t2 = video.__getTime();
    check('AS2 换成别的 video id 后参照作废，不碰新正片',
      Math.abs(t2 - 5) < 0.01, `currentTime=${t2.toFixed(2)}`);
  }

  // ---------- AT: 没有 meta 时用 playerResponse 里的正片时长（来源 2）----------
  // 现场（v1.4.4 日志，68 行）：进广告那一刻页面里没有 <meta itemprop="duration">，
  // v1.4.4 的 `🎯` 一次都没打出来 —— 兜底等于没写。playerResponse 是首屏就带的。
  {
    const html = `<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"newVideoId","title":"t","lengthSeconds":"1201"}};</script>
      <div id="movie_player" class="html5-video-player"></div>`;
    const opts = { duration: 313.5, currentTime: 100, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { win, player, logs } = await loadPage(html, { video, debug: true });
    await sleep(700);                                  // 先记下上一支视频 mainDur=313.5
    win.history.pushState({}, '', '/watch?v=newVideoId');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));   // 换视频 -> 参照归零
    opts.duration = 1086.5;                            // 新视频的预播广告
    video.currentTime = 0.5;
    player.classList.add('ad-showing');
    await sleep(2200);
    const t = video.__getTime();
    const srcLog = logs.some((l) => l.indexOf('内联playerResponse') >= 0);
    check('AT 没有 meta 时用 playerResponse 的正片时长（id 校验）',
      t > 1086 && srcLog, `currentTime=${t.toFixed(2)}, 来源日志=${srcLog}`);
  }

  // ---------- AU: playerResponse 属于别的视频 -> 不采用（AT 的安全边界）----------
  // SPA 换视频后 playerResponse 还留着上一支的 lengthSeconds；用错了就是把新正片推到底。
  {
    const html = `<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"someOtherId","title":"t","lengthSeconds":"1201"}};</script>
      <div id="movie_player" class="html5-video-player"></div>`;
    const opts = { duration: 313.5, currentTime: 100, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { win, player, logs } = await loadPage(html, { video, debug: true });
    await sleep(700);
    win.history.pushState({}, '', '/watch?v=newVideoId');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    opts.duration = 1086.5;
    video.currentTime = 0.5;
    player.classList.add('ad-showing');
    await sleep(2200);
    const t = video.__getTime();
    check('AU playerResponse 的 videoId 与当前页不符时不采用',
      Math.abs(t - 0.5) < 0.01, `currentTime=${t.toFixed(2)}, 强跳=${logs.some((l) => l.indexOf('视频层强跳') >= 0)}`);
  }

  // ---------- AV: 参照晚到 -> 边播边等，补上后照跳 ----------
  // v1.4.4 只"进广告那一刻"取一次参照，取不到就永久 🚫。读者看得见的现场就是
  // "广告已经播了 10 秒，参照才在页面里出现"，by then 已经放弃。
  {
    const html = `<div id="movie_player" class="html5-video-player ad-showing"></div>`;
    const video = makeVideo(new JSDOM('').window, { duration: 1086.5, currentTime: 0.5, paused: false });
    const { win } = await loadPage(html, { video, debug: true });
    await sleep(2000);                              // 前 2 秒没有任何参照 -> 应该没动
    const before = video.__getTime();
    const s = win.document.createElement('script');
    s.textContent = 'var ytInitialPlayerResponse = {"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"t","lengthSeconds":"1201"}}';
    win.document.body.appendChild(s);                // 元数据晚到
    await sleep(5000);
    const after = video.__getTime();
    check('AV 参照晚到时边播边等，补上后仍强跳',
      Math.abs(before - 0.5) < 0.01 && after > 1086, `之前=${before.toFixed(2)}, 之后=${after.toFixed(2)}`);
  }

  // ---------- AW: 页面桥补上正片参照 -> 长广告照样跳 ----------
  // 现场（v1.4.5 日志）那句 `🎯` 一次没出现：隔离世界既看不到页面 JS 全局，也啃不动
  // 内联脚本。改成 inj.js 在页面世界读、postMessage 回来。这条用例模拟"桥推送到位"。
  {
    const html = `<div id="movie_player" class="html5-video-player"></div>`;
    const opts = { duration: 313.5, currentTime: 100, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { win, player, logs } = await loadPage(html, { video, debug: true });
    await sleep(400);
    bridgePush(win, 'dQw4w9WgXcQ', [{ src: 'player.getPlayerResponse', id: 'dQw4w9WgXcQ', dur: 313.5 }]);
    await sleep(300);
    win.history.pushState({}, '', '/watch?v=newVideoId');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));   // 换视频 -> 参照归零
    opts.duration = 1086.5;                            // 新视频的预播长广告
    video.currentTime = 0.5;
    player.classList.add('ad-showing');
    bridgePush(win, 'newVideoId', [{ src: 'player.getPlayerResponse', id: 'newVideoId', dur: 1201 }]);
    await sleep(2200);
    const t = video.__getTime();
    const gotRef = logs.some((l) => l.indexOf('🎯 正片时长参照取自页面桥') >= 0);
    check('AW 页面桥补上参照后长广告照跳',
      t > 1086 && gotRef, `currentTime=${t.toFixed(2)}, 桥参照日志=${gotRef}`);
  }

  // ---------- AX: 桥报的是广告自己的 playerResponse -> 不采用（AT 的安全边界）----------
  // 播放器在播广告时可能报广告的 videoDetails，lengthSeconds 是广告时长。拿它当正片
  // 参照结论正好反过来（把广告当正片，一律不跳），所以只认 id 与 URL 一致的那个。
  {
    const html = `<div id="movie_player" class="html5-video-player"></div>`;
    const opts = { duration: 313.5, currentTime: 100, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { win, player, logs } = await loadPage(html, { video, debug: true });
    await sleep(400);
    win.history.pushState({}, '', '/watch?v=newVideoId');
    win.document.dispatchEvent(new win.Event('yt-navigate-finish'));
    opts.duration = 1086.5;
    video.currentTime = 0.5;
    player.classList.add('ad-showing');
    bridgePush(win, 'newVideoId', [{ src: 'player.getPlayerResponse', id: 'adVideoId', dur: 1086.5 }]);
    await sleep(2200);
    const t = video.__getTime();
    const miss = logs.filter((l) => l.indexOf('❓ 拿不到正片时长参照') >= 0);
    check('AX 桥的 id 与页面不符时不采用', Math.abs(t - 0.5) < 0.01 && miss.length === 1
      && miss[0].indexOf('adVideoId') >= 0,
      `currentTime=${t.toFixed(2)}, 缺参照行=${miss.length}`);
  }

  // ---------- AY: 三个来源全空 -> 只打一条逐项事实，不刷屏 ----------
  {
    const html = `<div id="movie_player" class="html5-video-player"></div>`;
    // 现场：页面加载了但播放器没起来（`dur= 未知` 撑了 372 秒）就进了预播广告
    const opts = { duration: NaN, currentTime: 0, paused: false };
    const video = makeVideo(new JSDOM('').window, opts);
    const { player, logs } = await loadPage(html, { video, debug: true });
    await sleep(500);
    opts.duration = 1086.5;
    video.currentTime = 0.5;
    player.classList.add('ad-showing');
    await sleep(4500);                                 // 足有两轮重试
    const miss = logs.filter((l) => l.indexOf('❓ 拿不到正片时长参照') >= 0);
    check('AY 三来源全空时只打一条事实行', miss.length === 1
      && miss[0].indexOf('桥=') >= 0 && miss[0].indexOf('meta=') >= 0 && miss[0].indexOf('内联=') >= 0,
      `行数=${miss.length}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
