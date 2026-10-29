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
const CODE = fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8');
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
    runtime: { id: 'test-ext', lastError: undefined, getManifest: () => ({ version: '1.2.4' }) },
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

async function loadPage(html, { video, enabled = true } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  // jsdom 的 getBoundingClientRect 恒为 0，会让 isVisible 全部判为不可见
  win.Element.prototype.getBoundingClientRect = () => ({
    width: 100, height: 30, left: 10, top: 10, right: 110, bottom: 40, x: 10, y: 10,
  });
  const player = win.document.querySelector('#movie_player');
  if (video && player) player.appendChild(video);
  win.chrome = makeChrome({ enabled });
  win.eval(CODE);
  await sleep(60);   // 等 storage 回调 -> start()
  return { win, chrome: win.chrome, player };
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

  const failed = results.filter((r) => !r.pass);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
