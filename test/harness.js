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
    runtime: { id: 'test-ext', lastError: undefined, getManifest: () => ({ version: require('../manifest.json').version }) },
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

  const failed = results.filter((r) => !r.pass);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
