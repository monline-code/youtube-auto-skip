/**
 * YouTube 自动跳过广告 - 内容脚本
 * 原理：监听播放器 DOM 变化，当广告处于可跳过状态时，
 * 模拟点击 YouTube 官方渲染的「跳过广告 / Skip Ad」按钮；
 * 同时关闭可关闭的贴片（overlay / banner）广告。
 *
 * v1.1：加固快进/拖动进度条触发的插播广告（mid-roll seek ad）识别：
 *  - 扩大广告状态检测（.ytp-ad-player-overlay 等覆盖层信号）
 *  - 文本兜底改为在"广告覆盖层内"直接生效，不依赖 .ad-showing
 *  - 匹配 aria-label / title，兼容按钮无文字只有图标的情况
 *  - 点击后若按钮未消失，升级点击外层容器，再不行发送 "s" 快捷键
 *
 * v1.2.0：解决"看得见跳过按钮但点了没反应"：
 *  - 事件改为 composed:true（穿透 shadow root），否则 YouTube 收不到指针事件
 *  - 点击目标穿透 shadow DOM 取最内层真 <button>（不再点 yt-button-shape 宿主）
 *  - 新增"视频层强跳"：广告播放 1.2s 仍未被跳过时，直接把广告视频推到结尾
 *  - 盲点计数按广告场次(epoch)重置，不再出现"点满 6 次后彻底不点"
 *
 * v1.2.1：按实测日志修正（大量广告根本没有可见的跳过按钮）
 *  - 视频层强跳改为主力手段，广告起播 0.8s 即执行，不再等按钮
 *  - 删除"时长变化=已切回正片"的永久锁定（它导致同段广告的第二支被放行）
 *  - 新防误伤：非广告态记录正片时长 mainDur，广告里时长相符则绝不跳；
 *    广告结束后 1.5s 内禁止动进度，避开 .ad-showing 摘除的时间差
 *  - 盲点次数 6 → 2（0×0 空壳点了没用，纯粹刷屏）
 *
 * v1.2.2：seek 结果校验 + 加速兜底
 *  - 每次强跳后回读 currentTime：若进度明显落后目标（seek 被广告播放器忽略）
 *    则累计失败，连续 2 次后改用 playbackRate=16 让广告迅速播完；广告结束还原
 *  - 加载时无条件打印版本号，避免"改了代码但页面跑的还是旧版"
 *  - 调试日志的重复拒绝提示窗口 1.5s → 3s，进一步降噪
 *
 * v1.2.3：修复"跳过时弹出广告主页面/窗口"
 *  - 删除"点击后按钮仍在 → 升级点击外层容器"：外层容器就是广告创意本身，
 *    点它会触发广告主落地页（用户看到的弹窗来源）
 *  - 删除盲点阶段与 skipAd API 兜底（0×0 空壳点了没用，且有误点风险）
 *  - 所有点击路径前置 `adStateStrong()`：非明确广告态绝不查找/点击任何元素
 *  - pickBest 只接受"按钮语义"节点(rank>=1)，并拒绝 a[href]、ytp-ad-clickable 等
 *  - isAdPlaying 不再因残留的 .ytp-ad-skip-button 空壳而误报广告态
 *
 * v1.2.4：审计修复（性能 / 状态泄漏 / 健壮性）
 *  - MutationObserver 改为节流调度（≤5 次/秒），杜绝高频 DOM 抖动触发重扫描
 *  - isVisible / visibleText 增加"单次 tick 内"缓存；pickBest 改为先做廉价过滤
 *  - 加速播放会记录并还原用户原本的速率；shutdown / 关闭开关时必定还原
 *  - 广告卡在尾部（seek 后不触发 ended）超 3s 自动改用加速播放
 *  - 正片时长参照不再要求 >60s，短视频同样受"别误跳正片"保护
 *  - 消除"扩展已禁用但首次 tick 仍动作"的启动竞态；storage 监听在停机时解绑
 *  - 类名读取改用 getAttribute('class')，修正 SVG 元素取不到类名导致的检查失效
 *  - 清理死代码（onStuck / VERIFY_DELAY / lastSkipAttempt），版本号改读 manifest
 */
(() => {
  'use strict';

  if (window.__ytAutoSkipLoaded) return;
  window.__ytAutoSkipLoaded = true;

  // 版本号：每次加载无条件打印一行，方便确认"页面里跑的到底是哪一版"
  // （排查时最常见的问题就是改了代码但没刷新扩展/页面）
  const VERSION = (() => {
    try { return chrome.runtime.getManifest().version; } catch (_) { return '1.2.4'; }
  })();
  try { console.log('[YT-AutoSkip] v' + VERSION + ' 已加载'); } catch (_) { /* ignore */ }

  // ---------------- 配置 ----------------
  const CHECK_INTERVAL_MS = 600;      // 兜底轮询间隔
  const CLICK_DELAY_MIN = 300;        // 点击前随机延迟，模拟人工
  const CLICK_DELAY_MAX = 900;
  const RECLICK_COOLDOWN = 3500;      // 同一元素重复点击冷却
  // MutationObserver 事件合并后的最小 tick 间隔（上限 5 次/秒）。
  // 没有这层节流时，YouTube 播放期间的 DOM 抖动会让 tick 每秒跑十几次，
  // 每次都做全量查询 + 计算样式，低端机上明显掉帧。
  const TICK_MIN_GAP = 200;

  // 跳过按钮选择器（桌面版 + 新版播放器 + 移动端 + IMA3）
  const SKIP_SELECTORS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-container',
    '.ytp-skip-ad-button',
    'tp-yt-paper-button.ytp-ad-skip-button-modern',
    'button.ytp-ad-skip-button',
    '.ytp-ad-skip-component button',
    '.ytp-skip-ad-button-modern',
  ];

  // 贴片广告关闭按钮
  const CLOSE_SELECTORS = [
    '.ytp-ad-overlay-close-button',
    '.ytp-ad-overlay-container .ytp-ad-overlay-close-button',
    '.ytp-ad-banner-dismiss button',
    'button.ytp-ad-overlay-close-button',
    '.ytp-ad-toggle-ui-dismiss button',
  ];

  // 广告覆盖层信号：这些容器只在广告播放时存在，
  // 出现在其中的"跳过"按钮一定是广告跳过按钮（快进插播广告常用）
  const AD_OVERLAY_SELECTORS = [
    '.ytp-ad-player-overlay',
    '.ytp-ad-player-overlay-skip-or-preview',
    '.ytp-ad-player-overlay-flyout-cta',
    '#player-ads',
    '.ytp-ad-visit-advertiser-button',
    '.ytp-ad-overlay-container',
    '#ima3-container',
    '.ima3-ad-container',
  ];

  // 明确排除：不是广告的「跳过」（如跳过片头）
  const EXCLUDE_SELECTOR = '.ytp-skip-intro-button, .ytp-bigger-playable-overlay';

  // 多语言覆盖：只认中英会漏掉日/韩/西/法/德等界面的「跳过」按钮
  const SKIP_TEXT_RE = /(跳过|跳過|略过|略過|skip|スキップ|건너뛰기|omitir|ignorar|ignorer|überspringen|salta|pular|atla)/i;
  // 误点防护（v1.1.7 修正）：ytSpecButtonShapeNext* 是 YouTube 新版通用按钮组件名
  // （"next"指组件版本，不是"下一个"），新版广告"跳过广告"按钮就是它渲染的，
  // 不能按类名排除；只按"文本含义"排除真正的非广告按钮。
  const BAD_TEXT_RE = /(下一个|上一[个条]|个视频|next video|previous|自动播放|影片速览|影片预告)/i;
  // 倒计时文案（只作用于"可见文本"，见 visibleText）
  const COUNTDOWN_RE = /(\d+\s*(秒|s\b))|skip\s+in|\d+\s*秒后|后跳过|还剩\s*\d|^\s*\d+\s*$/i;

  // ---------------- 状态 ----------------
  // 初始值必须是 false：storage 是异步读取的。若默认 true，用户在弹窗里
  // 关掉开关后打开新页面，第一次 tick 仍会以"已启用"运行。真正的取值在
  // storage 回调里通过 applyState() 落地。
  let enabled = false;
  let debug = false;                  // 调试日志开关
  let destroyed = false;              // 扩展上下文失效后自我销毁标记
  let started = false;                // 主循环是否已启动（幂等）
  const lastClickMap = new WeakMap(); // el -> timestamp
  const pendingSet = new WeakSet();   // 已排队等待点击的元素

  // 单次 tick 内的可见性 / 文本缓存：同一元素会在 pickBest、inCountdown、
  // deepFindSkipButton 里被反复询问，重复算样式极其浪费。
  // 每个 tick 开头清空（tick 内部不修改 DOM，缓存不会失真）。
  let visCache = new Map();
  let textCache = new Map();

  // ---------------- 扩展上下文保护 ----------------
  // 扩展被刷新/卸载/重载后，旧内容脚本仍在页面里运行，
  // 但 chrome.* API 上下文已失效，此时任何 storage 调用都会抛
  // "Extension context invalidated"。检测到后立刻自我销毁。
  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  let observer = null;
  let pollTimer = null;
  let seekHandler = null;
  let tickTimer = null;               // 节流用的待执行 tick
  let storageListener = null;         // 便于停机时解绑

  function shutdown(reason) {
    if (destroyed) return;
    destroyed = true;
    // 关键：把我们改过的 playbackRate 还回去。否则脚本销毁后正片会一直
    // 以 16× 播放，而那时已经没有任何代码能还原它了。
    releaseRateBoost();
    try { if (observer) observer.disconnect(); } catch (_) { /* ignore */ }
    try { if (pollTimer) clearInterval(pollTimer); } catch (_) { /* ignore */ }
    try { if (tickTimer) clearTimeout(tickTimer); } catch (_) { /* ignore */ }
    try { if (seekHandler) document.removeEventListener('seeked', seekHandler, true); } catch (_) { /* ignore */ }
    if (storageListener) {
      try { chrome.storage.onChanged.removeListener(storageListener); } catch (_) { /* ignore */ }
      storageListener = null;
    }
    observer = null;
    pollTimer = null;
    tickTimer = null;
    seekHandler = null;
  }

  // 安全地访问 storage：上下文失效时自动停机和访问
  function safeStorage(fn) {
    if (destroyed || !contextAlive()) { shutdown('扩展上下文已失效'); return; }
    try {
      fn();
    } catch (err) {
      if (err && /context invalidated|Extension context/i.test(String(err && err.message))) {
        shutdown('扩展上下文已失效');
      }
      /* 其他存储错误忽略 */
    }
  }

  // 调试日志：chrome.storage.sync.set({debug:true}) 打开，set({debug:false}) 关闭。
  // 也可在扩展弹窗里勾选「调试日志」。
  function dlog(...args) {
    if (debug) console.log('[YT-AutoSkip]', ...args);
  }

  // 节流版调试日志：同一 key 每 3s 最多打印一次，避免广告期间刷屏
  const rejectLogTimes = {};
  function dlogReject(key, ...args) {
    if (!debug) return;
    const now = Date.now();
    if (rejectLogTimes[key] && now - rejectLogTimes[key] < 3000) return;
    rejectLogTimes[key] = now;
    dlog(...args);
  }

  function loadDebug() {
    safeStorage(() => {
      chrome.storage.sync.get({ debug: false }, (data) => {
        if (chrome.runtime.lastError) return;
        debug = !!data.debug;
        dlog('调试已开启，开始记录广告检测过程');
      });
    });
  }

  // ---------------- 工具函数 ----------------
  function queryAllSafe(sel) {
    try { return document.querySelectorAll(sel); } catch (_) { return []; }
  }

  // 取类名字符串。SVG 元素的 el.className 是 SVGAnimatedString 对象，
  // String() 之后会变成 "[object SVGAnimatedString]"：用它做正则/包含判断
  // 会静默失效（安全检查被绕过、跳过按钮漏识别）。
  function classOf(el) {
    if (!el || !el.getAttribute) return '';
    try { return el.getAttribute('class') || ''; } catch (_) { return ''; }
  }

  function isVisible(el) {
    if (!el) return false;
    const cached = visCache.get(el);
    if (cached !== undefined) return cached;
    const result = computeVisible(el);
    visCache.set(el, result);
    return result;
  }

  function computeVisible(el) {
    const self = getComputedStyle(el);
    if (self.display === 'none' || self.visibility === 'hidden' || self.opacity === '0') return false;
    // 任意祖先被隐藏，则整体不可见（opacity:0 的祖先同样让子树看不出来）
    let p = el.parentElement;
    while (p) {
      const ps = getComputedStyle(p);
      if (ps.display === 'none' || ps.visibility === 'hidden' || ps.opacity === '0') return false;
      p = p.parentElement;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // 元素"可直接点击"的程度：2 = 真正的按钮语义，1 = 播放器按钮类，0 = 普通容器
  function clickableRank(c) {
    if (!c || !c.tagName) return 0;
    const tag = c.tagName;
    if (tag === 'BUTTON' || tag === 'TP-YT-PAPER-BUTTON') return 2;
    if (c.getAttribute && c.getAttribute('role') === 'button') return 2;
    // yt-button-shape 只是"宿主"，真正的 <button> 在 shadow root 里，
    // 宿主本身点不出效果 → 只算 1 分，让深层的真按钮（2 分）胜出
    if (/^YT-BUTTON-SHAPE|^YT-SPEC-BUTTON-SHAPE/.test(tag)) return 1;
    if (c.classList && c.classList.contains('ytp-button')) return 1;
    // 老版跳过按钮是带 skip/button 类名的 div；容器和倒计时遮罩不算
    const cn = classOf(c);
    if (/skip/i.test(cn) && /button/i.test(cn) && !/container|countdown|overlay|inactive/i.test(cn)) return 1;
    return 0;
  }

  // 穿透 Shadow DOM 收集内部所有"可点击"节点。
  // 新版 YouTube 的可见跳过按钮由 <yt-button-shape> 这类自定义元素渲染，
  // 真正的 <button> 和 click 监听都在它的 shadow root 里——
  // 只点外层宿主元素是"点了个寂寞"，这就是之前"有日志但没跳过动作"的原因。
  function collectClickableDeep(root, out) {
    if (!root) return out;
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 40) {
      const node = stack.pop();
      let kids = [];
      try { kids = node.querySelectorAll('*'); } catch (_) { kids = []; }
      for (const k of kids) {
        if (clickableRank(k) > 0) out.push(k);
        try { if (k.shadowRoot) stack.push(k.shadowRoot); } catch (_) { /* ignore */ }
      }
    }
    return out;
  }

  // 安全兜底（v1.2.3）：绝不点击会触发广告主落地页的东西。
  // 曾经"点击外层容器"和"盲点空壳"就是这样把用户带进了广告页面/弹出窗口。
  const UNSAFE_CLASS_RE = /(ytp-ad-clickable|ytp-ad-visit-advertiser|ytp-ad-overlay-slot|ytp-ad-image-overlay|ytp-ad-player-overlay-layout)/i;
  function isSafeClickTarget(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === 'A') return false;
    // 祖先里有链接 → 点击会跳转
    if (el.closest && el.closest('a[href]')) return false;
    // 广告创意 / "访问广告主" 区域
    if (el.closest && el.closest('[class*="ytp-ad-clickable"], [class*="ytp-ad-visit-advertiser"]')) return false;
    if (UNSAFE_CLASS_RE.test(classOf(el))) return false;
    return true;
  }

  // 在候选里挑"可见 + 最像真按钮 + 面积最小（最深层）"的那个
  function pickBest(cands) {
    let best = null;
    let bestRank = 0;
    let bestArea = Infinity;
    for (const c of cands) {
      if (!c || isDisabled(c)) continue;
      // 过滤顺序按"开销从低到高"排列。inCountdown 会遍历文本节点并逐个算样式，
      // 放在最前面会让大量"根本不可见、甚至不是按钮"的容器白跑一遍全文遍历。
      const rank = clickableRank(c);
      // 只要"按钮语义"的节点（rank>=1）。普通容器一律不点：
      // 广告覆盖层里的容器往往就是广告创意本身，点它会打开广告主页面。
      if (rank < 1) continue;
      if (c.matches && c.matches(EXCLUDE_SELECTOR)) continue;
      if (!isSafeClickTarget(c)) continue;
      if (!isVisible(c)) continue;
      if (inCountdown(c)) continue;
      const r = c.getBoundingClientRect();
      const area = r.width * r.height;
      if (rank > bestRank || (rank === bestRank && area < bestArea)) {
        best = c;
        bestRank = rank;
        bestArea = area;
      }
    }
    return best;
  }

  // 从某元素出发，挑出"肉眼可见、真正可点"的目标：
  // 自身、后代 button/[role=button]（含 shadow root 内部）、最近的广告跳过容器。
  // 注意：这里不做任何"盲点"兜底——盲点逻辑统一放在 findSkipButton，
  // 且必须全局所有候选都不可见时才允许（避免误点迷你播放器的隐藏副本）。
  function pickVisible(el) {
    if (!el || isDisabled(el) || inCountdown(el)) return null;
    const cands = [el];
    if (el.querySelectorAll) {
      try {
        el.querySelectorAll('button, [role="button"], .ytp-button, tp-yt-paper-button')
          .forEach((b) => cands.push(b));
      } catch (_) { /* ignore */ }
    }
    const anc = el.closest && el.closest('.ytp-ad-skip-button-container, .ytp-ad-skip-component, [role="button"]');
    if (anc && anc !== el) cands.push(anc);
    const shallow = pickBest(cands);
    // 只有"真按钮/播放器按钮"才直接返回；命中普通容器时再穿透 Shadow DOM
    // 找更深的真按钮（新版 UI 可见按钮 = 宿主元素 + shadow 内的 button）
    if (shallow && clickableRank(shallow) >= 2) return shallow;

    const deep = collectClickableDeep(el, []);
    const deepBest = deep.length ? pickBest(deep) : null;
    if (deepBest && (!shallow || clickableRank(deepBest) > clickableRank(shallow))) return deepBest;
    return shallow;
  }

  function isCoolingDown(el) {
    const t = lastClickMap.get(el);
    return t && Date.now() - t < RECLICK_COOLDOWN;
  }

  function clickElement(el) {
    lastClickMap.set(el, Date.now());
    const rect = el.getBoundingClientRect();
    // 0 尺寸节点（如 YouTube 为兼容保留的隐藏 .ytp-skip-ad-button 壳）：
    // 不能用 (0,0) 坐标派发鼠标事件（可能命中无关位置），只发原生 click()。
    if (rect.width <= 0 || rect.height <= 0) {
      try { el.click(); } catch (_) { /* ignore */ }
      return;
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    // composed: true 是关键——新版按钮在 shadow root 内，
    // 非 composed 的事件穿不出 shadow 边界，YouTube 的监听器收不到，
    // 于是"点了没反应"。
    const base = {
      bubbles: true, cancelable: true, composed: true,
      view: window, clientX: x, clientY: y,
    };
    const seq = [
      ['pointerdown', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }],
      ['mousedown', { ...base, button: 0, buttons: 1 }],
      ['pointerup', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 }],
      ['mouseup', { ...base, button: 0, buttons: 0 }],
      ['click', { ...base, button: 0, buttons: 0 }],
    ];
    for (const [type, opts] of seq) {
      try {
        el.dispatchEvent(type.indexOf('pointer') === 0
          ? new PointerEvent(type, opts)
          : new MouseEvent(type, opts));
      } catch (_) { /* ignore */ }
    }
    try { el.click(); } catch (_) { /* ignore */ }
  }

  function humanDelay() {
    return CLICK_DELAY_MIN + Math.random() * (CLICK_DELAY_MAX - CLICK_DELAY_MIN);
  }

  // 可点击性：disabled / aria-disabled 的按钮不点（还在倒计时的容器除外，交给倒计时判断）
  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    if (el.classList && el.classList.contains('ytp-ad-skip-button-inactive')) return true;
    return false;
  }

  function elementText(el) {
    return ((el.textContent || '') + ' ' +
            (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title')) || '')).trim();
  }

  // 只收集"可见"的文本：跳过按钮可点击后，隐藏的倒计时遮罩
  // （ytp-ad-skip-button-overlay）里仍残留"X 秒后跳过"字样，
  // 若直接读 textContent 会误判为仍在倒计时。
  function visibleText(el) {
    if (!el) return '';
    const cached = textCache.get(el);
    if (cached !== undefined) return cached;
    let out = '';
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const p = n.parentElement;
        if (p && isVisible(p)) out += n.textContent;
      }
    } catch (_) {
      out = el.textContent || '';
    }
    out = out.trim();
    textCache.set(el, out);
    return out;
  }

  // 是否仍在倒计时（不可点击）
  function inCountdown(el) {
    if (!el) return true;
    if (el.classList && el.classList.contains('ytp-ad-skip-button-inactive')) return true;
    // 倒计时遮罩仍然可见 → 未结束
    const overlay = el.querySelector &&
      el.querySelector('.ytp-ad-skip-button-overlay, .ytp-ad-skip-button-countdown-text');
    if (overlay && isVisible(overlay)) return true;
    // 兜底：可见文本里出现倒计时样式
    return COUNTDOWN_RE.test(visibleText(el));
  }

  function scheduleClick(el, onDone, label) {
    if (!el || isCoolingDown(el) || pendingSet.has(el)) return false;
    pendingSet.add(el);
    // 只有真正调度了点击才打日志，避免"找到按钮"日志在冷却期内刷屏
    dlog('✅ 准备点击:', label || classOf(el).slice(0, 60) || el.tagName);
    setTimeout(() => {
      pendingSet.delete(el);
      if (destroyed || !enabled || isCoolingDown(el) || !document.contains(el)) return;
      clickElement(el);
      if (onDone) onDone();
    }, humanDelay());
    return true;
  }

  // 计数写入串行化：storage 的 get→set 是两步异步操作，
  // 连续两次 bump 会读到同一个旧值，导致少记一次。
  let pendingBumps = 0;
  let bumpRunning = false;

  function bumpCount() {
    pendingBumps += 1;
    if (bumpRunning) return;
    flushBumps();
  }

  function flushBumps() {
    if (destroyed || !pendingBumps) { bumpRunning = false; pendingBumps = 0; return; }
    bumpRunning = true;
    const add = pendingBumps;
    pendingBumps = 0;
    let invoked = false;
    safeStorage(() => {
      invoked = true;
      chrome.storage.local.get({ skipped: 0 }, (data) => {
        if (chrome.runtime.lastError) { bumpRunning = false; return; }
        chrome.storage.local.set({ skipped: (data.skipped || 0) + add }, () => {
          flushBumps();
        });
      });
    });
    // safeStorage 因上下文失效直接拦下时不会执行回调，别把队列卡在"运行中"
    if (!invoked) { bumpRunning = false; }
  }

  // ---------------- 广告状态检测 ----------------
  function inAdOverlay(el) {
    return el.closest && el.closest(AD_OVERLAY_SELECTORS.join(','));
  }

  function isAdPlaying() {
    if (document.querySelector('.ad-showing')) return true;
    if (document.querySelector('.html5-video-player.ad-interrupting')) return true;
    if (document.querySelector('#player-mobile .ad-showing')) return true;
    if (document.querySelector('video#ad-frame')) return true;
    // 注意（v1.2.3）：这里曾经"只要出现 .ytp-skip-ad-button 等节点就算广告态"，
    // 但那个按钮是预创建的空壳，广告结束后仍留在 DOM 里，导致广告结束后
    // 仍然报告 adPlaying=true、并继续去找/点按钮。现在只看覆盖层是否真的可见。
    for (const sel of AD_OVERLAY_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return true;
    }
    return false;
  }

  // 强广告信号：判定标准必须"足够硬"，否则视频层强跳可能把正片跳到大结局。
  // 只看 ad-showing 类，或广告专用覆盖层/跳过组件是否真的可见；
  // 不看 ad-interrupting（它在广告结束的一瞬间会残留，容易误判）。
  const STRONG_AD_SELECTORS = [
    '.ytp-ad-player-overlay',
    '.ytp-ad-skip-button-container',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-overlay-container',
    '.ytp-ad-player-overlay-layout',
    '.ytp-ad-progress-list',
    '.ytp-ad-duration-remaining',
  ];

  function adStateStrong() {
    const p = document.querySelector('#movie_player, .html5-video-player');
    if (p && p.classList && p.classList.contains('ad-showing')) return true;
    if (document.querySelector('.ad-showing')) return true;
    // 新版广告 UI 有时不挂 ad-showing，靠广告独有覆盖层判定
    for (const sel of STRONG_AD_SELECTORS) {
      let el = null;
      try { el = document.querySelector(sel); } catch (_) { el = null; }
      if (el && isVisible(el)) return true;
    }
    return false;
  }

  // ---------------- 视频层强跳（不依赖任何按钮 DOM） ----------------
  // 广告本质上是播放器在播另一段视频：把它的播放进度推到结尾，广告就立刻结束。
  // 这条路径绕开"按钮找不到 / 按钮是空壳 / shadow 点击无效"的所有问题，
  // 是保证"一定有跳过动作"的最后一道保险。
  const AD_MAX_DURATION = 300;   // 只处理 ≤5 分钟的片子（广告），先把长视频排除
  const VIDEO_SKIP_GAP = 900;    // 同一 video 元素最小间隔
  const END_STALL_MS = 3000;     // 贴到结尾却迟迟不结束时，多久后改用加速
  let lastVideoSkip = 0;
  let mainDur = 0;               // 最近一次"非广告态"观察到的正片时长
  let adEndGuardUntil = 0;       // 广告刚结束的一小段时间内禁止动进度
  let jumpTarget = 0;            // 上次 seek 的目标位置（0 = 无需校验）
  let jumpEl = null;             // 上次 seek 的那个 video 元素
  let jumpDur = 0;               // 上次 seek 时该视频的总时长（用于识别"已经换了一支广告"）
  let seekFails = 0;             // 连续 seek 无效次数
  let rateBoostEl = null;        // 被我们加速过的 video 元素
  let rateBoostPrev = 1;         // 加速前的原速率（用户本来可能就在 2×）
  let endStallSince = 0;         // 广告贴在尾部不动的起始时间戳（0 = 未卡住）
  const videoSkipTimes = new WeakMap();

  // 广告结束后把播放速度还原，别把正片也加速了
  function releaseRateBoost() {
    if (!rateBoostEl) return;
    // 还原成"用户原本的速率"，而不是硬编码 1×，
    // 否则"看正片设了 2×、广告结束后掉回 1×"就成了副作用。
    try { if (rateBoostEl.playbackRate > 1.5) rateBoostEl.playbackRate = rateBoostPrev; } catch (_) { /* ignore */ }
    rateBoostEl = null;
    rateBoostPrev = 1;
  }

  function currentVideo() {
    const p = document.querySelector('#movie_player, .html5-video-player');
    return p ? p.querySelector('video') : null;
  }

  // 非广告态持续记录正片时长：广告里若出现"时长≈正片时长"的视频，
  // 说明播放器已经切回正片、只是 .ad-showing 还没来得及摘掉，绝不能跳。
  function recordMainDur() {
    const v = currentVideo();
    if (!v) return;
    const d = v.duration;
    // 不再要求 >60s：短视频（含 Shorts）以前完全没有参照时长，
    // "时长≈正片就别动进度"这道防线对它们等于不存在。
    // 代价：广告起播瞬间若还没挂上广告标记，可能把广告时长误记成正片，
    // 之后同长度的广告会被放过一次——"漏跳一次"远好于"把正片跳到大结局"。
    if (isFinite(d) && d > 1 && !v.paused) mainDur = d;
  }

  function forceSkipAdViaVideo() {
    const now = Date.now();
    if (now - lastVideoSkip < 700) return false;
    if (now < adEndGuardUntil) return false;   // 广告刚结束，防误判保护窗口
    if (!adStateStrong()) return false;

    const player = document.querySelector('#movie_player, .html5-video-player');
    if (!player) return false;

    // 先校验上一次 seek 是否真的生效：有的广告播放器会忽略 currentTime 赋值。
    // 若被忽略（进度明显落后于目标），累计失败次数，转为加速播放。
    if (jumpTarget > 0) {
      const pv = (jumpEl && document.contains(jumpEl)) ? jumpEl : currentVideo();
      const sameClip = pv && isFinite(pv.duration) && Math.abs(pv.duration - jumpDur) <= 1;
      if (pv && sameClip && isFinite(pv.currentTime) && pv.currentTime < jumpTarget - 2) {
        seekFails += 1;
        dlog('⏩ 上次 seek 未生效（currentTime=', Math.round(pv.currentTime * 10) / 10,
          '目标=', Math.round(jumpTarget * 10) / 10, '），连续第', seekFails, '次');
      } else if (sameClip) {
        seekFails = 0;
      }
      // 时长变了 = 已经换了一支广告，上一次的结果无从判断，计数保持不变
      jumpTarget = 0;
    }

    for (const v of player.querySelectorAll('video')) {
      if (!v || v.readyState < 1) continue;
      const dur = v.duration;
      if (!isFinite(dur) || dur <= 0 || dur > AD_MAX_DURATION) continue;
      if (v.paused) continue;                          // 暂停中不动进度
      if (v.currentTime < 0.3) continue;               // 刚起播，等它真的在放
      // 时长与正片一致 → 这是正片，绝不碰（避免"跳到大结局"）
      if (mainDur && Math.abs(dur - mainDur) <= 1) {
        dlogReject('maindur', '⏩ 时长与正片一致（', Math.round(dur * 10) / 10, 's），判定为正片，不动进度');
        continue;
      }

      const t = videoSkipTimes.get(v);
      if (t && now - t < VIDEO_SKIP_GAP) continue;

      // 贴尾判定：有的广告播放器接受 currentTime 赋值后并不触发 ended，
      // 广告就永远停在最后一帧。贴尾超过 END_STALL_MS 仍未结束 → 改用加速。
      const atEnd = dur - v.currentTime < 1;
      if (atEnd) {
        if (!endStallSince) endStallSince = now;
      } else if (endStallSince) {
        endStallSince = 0;
      }
      const stuckAtEnd = atEnd && now - endStallSince >= END_STALL_MS;

      // seek 连续 2 次被忽略，或贴尾后等不到 ended → 改用 16× 加速，广告同样会迅速播完
      if (seekFails >= 2 || stuckAtEnd) {
        videoSkipTimes.set(v, now);
        lastVideoSkip = now;
        try {
          if (v.playbackRate < 8) {
            rateBoostPrev = v.playbackRate;   // 记住用户原本的速率，之后原样还回去
            v.playbackRate = 16;
          }
          rateBoostEl = v;
        } catch (_) { /* ignore */ }
        dlog(stuckAtEnd
          ? '⏩ 广告卡在结尾不放，改用 16× 加速播放（rate=' + v.playbackRate + '）'
          : '⏩ seek 无效，改用 16× 加速播放广告（rate=' + v.playbackRate + '）');
        epochActed = true;
        return true;
      }

      // 正常贴尾：交给播放器自己发 ended，不要反复 seek
      if (atEnd) continue;

      videoSkipTimes.set(v, now);
      lastVideoSkip = now;
      try {
        jumpTarget = Math.max(0, dur - 0.05);
        jumpEl = v;
        jumpDur = dur;
        v.currentTime = jumpTarget;
        dlog('⏩ 视频层强跳：duration=', Math.round(dur * 10) / 10,
          '→ currentTime=', Math.round(v.currentTime * 10) / 10);
        epochActed = true;
        return true;
      } catch (err) {
        dlog('⏩ 视频层强跳失败:', String(err && err.message));
      }
    }
    return false;
  }

  // ---------------- 跳过按钮查找 ----------------
  // 从候选节点解析出真正要点击的目标（内层 button 优先），倒计时未结束返回 null。
  function resolveTarget(node) {
    if (!node || node.matches(EXCLUDE_SELECTOR)) return null;
    return pickVisible(node);
  }

  // 是否位于迷你播放器内——迷你播放器常有隐藏/离屏的跳过按钮副本，
  // 盲点它等于没点，肉眼可见的按钮在另一个播放器实例里。
  function inMiniPlayer(el) {
    return !!(el.closest && el.closest('#mini-player, .ytp-miniplayer-ui'));
  }

  // 深度遍历（穿透 open Shadow DOM）收集 root 子树里的所有元素。
  // YouTube 新版 UI（yt-spec-button-shape-next 等组件）把可见的"跳过广告"
  // 按钮渲染在 shadow root 里，普通 querySelectorAll 看不到它。
  function walkDeep(root, out, depth) {
    if (depth > 6) return out;
    let els;
    try { els = root.querySelectorAll('*'); } catch (_) { return out; }
    for (const el of els) {
      out.push(el);
      if (el.shadowRoot) walkDeep(el.shadowRoot, out, depth + 1);
    }
    return out;
  }

  // 在广告相关容器内做"穿透 Shadow DOM"的跳过按钮扫描（v1.1.8 核心修复）。
  let lastDeepScan = 0;
  const deepRejectSeen = new WeakSet();
  function deepFindSkipButton() {
    // 节流：至少间隔 800ms，避免高频 MutationObserver 下全量遍历卡顿
    const now = Date.now();
    if (now - lastDeepScan < 800) return null;
    lastDeepScan = now;

    const containers = Array.from(document.querySelectorAll(
      '#movie_player, .html5-video-player, #player-ads, .ytp-ad-player-overlay, #player-mobile'
    )).filter((c) => !inMiniPlayer(c));
    if (!containers.length) return null;

    const els = [];
    for (const c of containers) walkDeep(c, els, 0);

    for (const el of els) {
      // 轻量预筛：跳过明显无关的标签
      const tag = el.tagName;
      if (!tag) continue;
      const isBtn = tag === 'BUTTON' || tag === 'TP-YT-PAPER-BUTTON' ||
        (el.getAttribute && el.getAttribute('role') === 'button') ||
        classOf(el).indexOf('ytp-button') >= 0;
      const label = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
      if (!isBtn && !label) continue;

      // 文本：aria-label/title 优先，其次自身直接子级可见文本（限短文本）
      let text = label;
      if (!text) {
        const t = el.textContent ? el.textContent.trim() : '';
        if (t && t.length <= 40) text = t;
      }
      if (!text || text.length > 40) continue;
      if (!SKIP_TEXT_RE.test(text)) continue;
      if (BAD_TEXT_RE.test(text)) continue;
      if (EXCLUDE_SELECTOR && el.matches && el.matches(EXCLUDE_SELECTOR)) continue;
      if (inMiniPlayer(el)) continue;

      const target = pickVisible(el);
      if (target) {
        dlog('🔬 深度扫描命中可见跳过按钮:', tag.toLowerCase(),
          '| text=', JSON.stringify(text.slice(0, 20)),
          '| cls=', el.className && String(el.className).slice(0, 60));
        return target;
      }
      if (debug && !deepRejectSeen.has(el)) {
        deepRejectSeen.add(el);
        dlog('🔬 深度扫描命中但不可见:', tag.toLowerCase(),
          '| vis=', isVisible(el),
          '| rect=', (() => { const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
          '| text=', JSON.stringify(text.slice(0, 20)),
          '| cls=', el.className && String(el.className).slice(0, 60));
      }
    }
    return null;
  }

  function findSkipButton() {
    // v1.2.3（安全）：非明确广告态时，绝不查找、更不点击任何元素。
    // 之前的"盲点不可见节点"和"点击外层容器升级"，会落到广告创意/推荐位上，
    // 触发广告主的落地页 —— 这就是用户看到的"弹出窗口"。全部移除。
    if (!adStateStrong()) return null;

    // 1) 按选择器查找"可见"目标
    const rejectNodes = [];
    for (const sel of SKIP_SELECTORS) {
      for (const node of queryAllSafe(sel)) {
        const target = resolveTarget(node);
        if (target) return target;
        rejectNodes.push(node);
        if (debug) {
          dlogReject(sel, '选择器命中但被拒:', sel,
            '| vis=', isVisible(node),
            '| disabled=', isDisabled(node),
            '| countdown=', inCountdown(node),
            '| mini=', inMiniPlayer(node),
            '| rect=', (() => { const r = node.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
            '| text=', JSON.stringify(visibleText(node).slice(0, 30)),
            '| cls=', node.className && String(node.className).slice(0, 60));
        }
      }
    }

    // 2) 穿透 Shadow DOM 的深度扫描（v1.1.8：新版 UI 的可见跳过按钮在 shadow root 里，
    //    常规 querySelectorAll 找不到——这正是一直"看得见按钮却点不到"的原因）
    const deep = deepFindSkipButton();
    if (deep) return deep;

    // 3) 文本/aria-label 兜底（DOM 树内）：必须处于明确广告态（v1.1.5），
    //    只按文本含义排除非广告按钮（v1.1.7：不再按 ytSpecButtonShape 组件类名排除，
    //    那是 YouTube 新版通用按钮组件，广告"跳过"按钮也由它渲染）。
    const adPlaying = isAdPlaying();
    if (adPlaying) {
      const roots = Array.from(document.querySelectorAll('#movie_player, .html5-video-player, #player-ads, .ytp-ad-player-overlay, #player-mobile'));
      if (!roots.length) roots.push(document);
      for (const r of roots) {
        let cands;
        try { cands = r.querySelectorAll('button, [role="button"], tp-yt-paper-button, .ytp-button'); } catch (_) { continue; }
        for (const el of cands) {
          if (el.matches(EXCLUDE_SELECTOR) || inMiniPlayer(el)) continue;
          const text = elementText(el);
          if (!text || text.length > 40) continue;
          if (!SKIP_TEXT_RE.test(text)) continue;
          if (BAD_TEXT_RE.test(text)) continue; // 文本是"下一个视频"等，不是广告跳过
          const target = pickVisible(el);
          if (target) return target;
          if (debug) {
            dlogReject('text:' + text.slice(0, 8), '文本命中候选被拒:',
              '| vis=', isVisible(el),
              '| disabled=', isDisabled(el),
              '| countdown=', inCountdown(el),
              '| overlay=', !!inAdOverlay(el),
              '| text=', JSON.stringify(text.slice(0, 30)),
              '| cls=', el.className && String(el.className).slice(0, 60));
          }
        }
      }
    }

    // 4) 到这里说明"没有任何可见的跳过按钮"——这正是不可跳过广告的常态
    //    （DOM 里只有一个 0×0 的空壳）。不再做任何盲点，交给 tick 里的视频层强跳。
    if (debug && rejectNodes.length) {
      dlogReject('novisible', '无可见跳过按钮（', rejectNodes.length, ' 个候选全部不可见），交给视频层强跳');
    }
    return null;
  }

  function findCloseButton() {
    for (const sel of CLOSE_SELECTORS) {
      for (const node of queryAllSafe(sel)) {
        // 关闭按钮在部分布局里嵌在广告链接内部，点它会打开广告主页面 → 跳过
        if (!isSafeClickTarget(node)) continue;
        if (isVisible(node) && !isCoolingDown(node)) return node;
      }
    }
    return null;
  }

  // ---------------- 主循环 ----------------
  let lastTickAt = 0;     // 上次真正执行 tick 的时间（节流基准）
  let lastDebugBeat = 0;
  let lastBeatSig = '';   // 上次心跳的状态签名，用于"状态变化立即输出"
  let adEpoch = 0;        // 每进入一次广告 +1（仅用于日志编号）
  let adStateSince = 0;   // 本次强广告态开始时间（0 = 当前不在广告）
  let epochActed = false; // 本次广告内是否真的执行过跳过动作（用于准确计数）
  let lastCoolLog = 0;    // "冷却中"提示的节流时间戳

  // 调试心跳：节奏按"真正的动作门控 strong(adStateStrong)"决定——
  // 广告结束/空闲态（strong=false）每 15s 一次，仅可动手的广告态才 3s 一次。
  // 之前用宽松的 adPlaying 决定节奏：广告结束后 .ad-interrupting / 残留覆盖层
  // 仍让 adPlaying=true，导致按 3s 持续刷屏（实际并不会动作，纯噪音）。
  function emitDebugBeat() {
    const adShowing = !!document.querySelector('.ad-showing');
    const adPlaying = isAdPlaying();
    const strong = adStateStrong();            // 是否真的会动播放器
    const hitCount = SKIP_SELECTORS.reduce((n, s) => n + queryAllSafe(s).length, 0);
    const sig = (strong ? 1 : 0) + '|' + (adPlaying ? 1 : 0) + '|' + (adShowing ? 1 : 0) + '|' + hitCount;
    const now = Date.now();
    const interval = strong ? 3000 : 15000;
    if (sig !== lastBeatSig || now - lastDebugBeat > interval) {
      lastBeatSig = sig;
      lastDebugBeat = now;
      const player = document.querySelector('#movie_player, .html5-video-player');
      dlog('🔎 调试心跳：strong=', strong, '| adPlaying=', adPlaying,
        '| .ad-showing=', adShowing,
        '| playerCls=', player && player.className && String(player.className).slice(0, 80),
        '| 选择器命中数=', hitCount);
    }
  }

  function tick() {
    if (destroyed || !enabled || document.hidden) return;
    if (!contextAlive()) { shutdown('扩展上下文已失效'); return; }

    // 清空"单次 tick 内"的 DOM 观察缓存。tick 内部不改 DOM，
    // 因此同一元素在一次扫描里算一次样式就够，不必重复询问。
    visCache.clear();
    textCache.clear();

    // 强广告态跟踪：进入时记时间 + epoch+1，退出时清零
    if (adStateStrong()) {
      if (!adStateSince) {
        adStateSince = Date.now();
        adEpoch += 1;
        epochActed = false;
        seekFails = 0;
        jumpTarget = 0;
        jumpEl = null;
        jumpDur = 0;
        endStallSince = 0;
        dlog('📺 检测到广告开始（第', adEpoch, '次）');
      }
    } else {
      if (adStateSince) {
        adStateSince = 0;
        adEndGuardUntil = Date.now() + 1500;   // 广告结束后的保护窗口
        seekFails = 0;
        jumpTarget = 0;
        jumpEl = null;
        jumpDur = 0;
        endStallSince = 0;
        releaseRateBoost();                     // 把播放速度还原，别加速正片
        dlog('📺 广告结束');
        // 只在"广告真的结束 + 期间我们动过手"时计数，避免点了无效也算一次
        if (epochActed) { epochActed = false; bumpCount(); }
      }
      recordMainDur();
    }

    // 【主力】广告播放满 0.8s 就直接把广告视频推到结尾。
    // 实测（用户日志）大量广告根本没有可见的"跳过"按钮，DOM 里只有一个
    // 0×0 的空壳 .ytp-skip-ad-button，点击路径对它们永远无效——只有这条能用。
    if (adStateSince && Date.now() - adStateSince >= 800) {
      forceSkipAdViaVideo();
    }

    // 【补充】如果确实存在"可见的"跳过按钮（可跳过广告），照旧点它。
    // v1.2.3：不再做"点完还在就升级点外层容器"——外层容器就是广告创意，
    // 点它等于帮广告主打开了落地页（用户看到的弹出窗口）。
    const skipBtn = findSkipButton();
    if (skipBtn) {
      const scheduled = scheduleClick(skipBtn, () => { epochActed = true; });
      if (!scheduled && debug && Date.now() - lastCoolLog > 6000) {
        lastCoolLog = Date.now();
        dlog('（跳过按钮已找到，处于冷却/排队中，暂不重复点击）');
      }
    } else if (debug) {
      emitDebugBeat();
    }

    const closeBtn = findCloseButton();
    if (closeBtn) {
      scheduleClick(closeBtn);
    }
  }

  // DOM 变化监听 + 定时兜底
  // 注意：回调里不能直接 tick()。YouTube 播放时 DOM 每秒抖动十几次，
  // 每次都同步跑一遍"全量查询 + 计算样式"会明显拖慢页面，这里统一走节流调度。
  observer = new MutationObserver(() => scheduleTick());

  // 事件合并：冷却窗口内的多次触发合并成一次；有过触发就一定会补跑一次（不丢事件）
  function scheduleTick() {
    if (destroyed || !enabled || tickTimer) return;
    const wait = Math.max(0, TICK_MIN_GAP - (Date.now() - lastTickAt));
    tickTimer = setTimeout(() => {
      tickTimer = null;
      if (destroyed || !enabled) return;
      lastTickAt = Date.now();
      tick();
    }, wait);
  }

  function start() {
    if (started || destroyed) return;
    started = true;
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'disabled', 'aria-disabled', 'aria-label', 'hidden'],
    });
    pollTimer = setInterval(scheduleTick, CHECK_INTERVAL_MS);
    // 快进/拖动进度条时重点扫描（插播广告多在 seek 结束后弹出）
    seekHandler = () => {
      if (destroyed) return;
      scheduleTick();
      setTimeout(scheduleTick, 300);
      setTimeout(scheduleTick, 800);
    };
    document.addEventListener('seeked', seekHandler, true);
    lastTickAt = Date.now();
    tick();
  }

  // ---------------- 开关状态 ----------------
  function applyState(value) {
    enabled = !!value;
    if (enabled) {
      tick();
    } else {
      // 关掉开关时若正处在加速态，必须立刻还原：tick 一停就再没人管这件事了
      releaseRateBoost();
      if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
    }
  }

  storageListener = (changes, area) => {
    if (destroyed) return;
    if (area === 'sync' && changes.enabled) {
      applyState(changes.newValue);
    }
    if (area === 'sync' && changes.debug) {
      debug = !!changes.debug.newValue;
      dlog('调试开关切换为', debug);
    }
  };

  safeStorage(() => {
    chrome.storage.sync.get({ enabled: true }, (data) => {
      if (destroyed) return;
      // 读不到配置时按"启用"兜底，别让扩展静默失效
      applyState(chrome.runtime.lastError ? true : !!data.enabled);
      start();
    });
    chrome.storage.onChanged.addListener(storageListener);
  });

  loadDebug();

  // storage 回调万一不回来（极少见），1.5s 后按默认启用启动，保证功能可用
  setTimeout(() => {
    if (!started && !destroyed) {
      enabled = true;
      start();
    }
  }, 1500);

  // 扩展刚被重载时，新旧脚本会短暂共存；旧脚本靠上面的
  // contextAlive 自检在运行中自行停机，不会继续报错。
})();
