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
 * v1.2.7：Review 修复（性能 + 安全）
 *  - [安全 S1] 点击延迟（300–900ms）期间元素可能被复用/挪进广告链接，点击前
 *    重新复检 isSafeClickTarget；跳过按钮还要求仍在强广告态（TOCTOU 复检）
 *  - [安全 S2] 视频层强跳（破坏性改 currentTime）改用更严格的 isRealVideoAd()
 *    （仅 .ad-showing），overlay 类信号只用于点击路径，避免误跳正片
 *  - [安全 S3] isSafeClickTarget 的祖先检查覆盖无 href 的 <a> 与 [role="link"]
 *  - [安全 S4] findCloseButton 增加 adStateStrong() 门控，与跳过按钮一致
 *  - [性能 P1] walkDeep 收集时预筛（只收按钮/广告相关节点），深扫节流 800→2000ms
 *  - [性能 P2] adStateStrong 增加"单 tick 内"缓存，同 tick 多次调用只算一次
 *  - [性能 P3] 文本兜底扫描（步骤 3）增加 2000ms 节流，避免每 tick 全量遍历
 *  - [性能 P4] visibleText 对不可见元素直接早退，省去 TreeWalker 全文遍历
 *
 * v1.2.8：修复 shadow root 内跳过按钮"能找到却点不到"
 *  - scheduleClick 的存活判定 document.contains(el) → isAttached(el)：前者对
 *    shadow root 内节点恒为 false，深度扫描（专为影子树按钮而写）命中后一律被丢弃
 *  - isVisible 的祖先链跨 shadow 边界：宿主 display:none 时不再误判为可见
 *  - 新增 closestDeep()：影子树内的节点也能正确判断是否在迷你播放器里
 *
 * v1.2.9：S1 复检不再读过期缓存
 *  - adStateStrong(force)：延迟点击回调发生在两次 tick 之间，缓存里是上一次
 *    扫描的结论（广告已结束仍判为 true），TOCTOU 复检会形同虚设；复检处强制重算
 *
 * v1.3.0："看得见按钮却不点/点得晚"
 *  - 放宽点击候选的可见性：YouTube 新版全屏布局里按钮 CSS 可见但
 *    getBoundingClientRect() 为 0×0（实测日志 rect=0x0、text="跳过"），
 *    原先严格按尺寸判定会一直等到布局稳定，表现就是点击滞后。
 *    现在对"跳过语义"元素只要求 CSS 未隐藏，点击走 el.click()（不派发坐标事件）；
 *    语义以文案/aria-label 为准，避免 0×0 空壳（无文本、点了没用）挤掉真按钮
 *  - pickBest 平局规则：同等语义下优先有尺寸的目标，避免点到 0×0 空壳
 *  - 点击前随机延迟 300–900ms → 150–400ms（仅为避开同帧竞态）
 *
 * v1.3.1：广告 pod（连播）里第二支"慢半拍"
 *  - 点击冷却（lastClickMap）与跳转间隔（videoSkipTimes）是按元素记的 WeakMap，
 *    pod 内 YouTube 复用同一批 DOM 节点 / 同一个 <video>，上一支的 3.5s 冷却会
 *    整个挡到下一支。现在每次新广告开始（adEpoch+1）都重置这三处状态
 *
 * v1.3.2：pod 的第二种形态 + 日志假读数
 *  - 现场日志里 15s → 36s 两支广告只记了"第 1 次"，说明 pod 内 .ad-showing
 *    并未切换，v1.3.1 靠 adEpoch 的重置根本不会触发。补一条判据：被强跳的
 *    视频时长变了就视为"换了一支"，同样重置按元素的状态
 *  - 拒绝日志里的 text 恒为空是假象：v1.2.7 起 visibleText 对不可见元素直接
 *    返回空，而 0×0 按钮恰恰不可见。日志改用 elementText（原始 textContent +
 *    aria-label），否则永远看不出这个按钮到底有没有"跳过"文案
 *
 * v1.3.3：把"看得见按钮、广告还在播"剩下的几处来源逐个掐掉
 *  - [日志] 每条 dlog 带相对时间戳（+1234ms）。之前只能按行序猜时序，
 *    分不清"200ms 内完成"和"卡了 6 秒"，体感延迟无法量化
 *  - [点击] 0×0 按钮的点击目标升级到"文案仍纯粹是跳过、且有真实布局盒"的祖先：
 *    无布局盒的元素上 el.click() 常是空操作（日志里点了但广告不结束）
 *  - [可见性] visibility 只认元素自身的 computed 值。它是可继承也可被后代覆盖的，
 *    祖先 visibility:hidden 被子元素改回 visible 时，旧实现会永久判成不可见
 *  - [冷却] 点击冷却改为"当前广告作用域内有效"：同支内不重复点，跨支立即解禁
 *    （日志里同一支广告出现了两次"准备点击"）
 *  - [节奏] 强跳不再统一等 800ms：能证明"时长相较正片明显不同"时就立刻动手，
 *    只有 mainDur 还没有参照值（打开链接先播广告）时才保留 800ms 确认窗口
 *  - 拒绝日志补 cssHidden 字段，把"0×0"和"被 CSS 判隐藏"区分开
 *
 * v1.3.4：带时间戳的现场日志（v1.3.3）暴露的两件事
 *  - [真 bug] 广告贴尾后若被暂停，`if (v.paused) continue` 会静默挡掉所有重试，
 *    广告长时间挂在最后一帧（现场：跳完 27.8s 那支后过了 9.2s 才切下一支）。
 *    现在贴尾 + 暂停时主动补一次 seek 并 play()，用 900ms 节流避免骚扰
 *  - [诊断] forceSkipAdViaVideo 里所有 continue 原本都是静默的，
 *    "广告开始 → 强跳"实测 1.9s 却看不出这一秒多花在哪。补一条节流日志，
 *    输出 readyState / duration / mainDur / 广告已持续时长
 *  - [修正] seek 校验里的 document.contains(jumpEl) 换成 isAttached()：
 *    前者对 shadow root 内节点恒为 false（v1.2.8 修过同类问题，这里漏了）
 *
 * v1.3.5：v1.3.4 的诊断日志把"1.9 秒之谜"结案了，也推翻了 v1.3.4 自己的假设
 *  - [结论] 那 1.9 秒不是我们的开销：日志里广告开始后 200ms 就尝试强跳，但
 *    readyState=0（广告媒体还没挂上），代码按设计只能等。真正花时间的是广告
 *    自己的媒体加载 —— 我们第一次能动手时距广告开始 1785ms，其中我们的
 *    反应只占 200ms
 *  - [结论] v1.3.4 的"贴尾暂停救援"在实际日志里一次都没执行过：readyState<1
 *    的判定排在它前面，而广告切流期间 video 全程 readyState=0。上一版修的
 *    "paused 挡住重试"是真实缺陷，但不是那 9.2 秒的原因
 *  - [诊断] 每条"未动进度"都带上 dur/ct/paused，并区分 readyState=0 的两种
 *    含义（媒体未加载 / 已贴尾在切流）；只在原因变化或满 5s 时打印，
 *    时间线一眼能读
 *  - [诊断] 新增 🎬 广告媒体就绪 与 📊 广告结束 汇总：直接给出"检测→媒体就绪"
 *    "检测→首次动手""媒体未就绪累计"三个数，下次不必再从行序里推
 *  - [实验] 推完一支广告后若 video 长期停在 readyState=0，补一次 play() 触发
 *    它的资源加载算法（上限 3 次、间隔 1.2s）。现场那 7~9 秒切流如果只是
 *    "取流没被拉起"，这一下能省掉；日志会打出"催流 play()（第 N 次）"以便验证
 *
 * v1.3.7：📊 汇总证明优化空间已经很小，只剩"我们自己设的门"值得动
 *  - [数据] 现场两支广告（15s + 37.5s）总共 3951ms 结束，其中媒体未就绪
 *    2022ms（51%，YouTube 侧）；首次动手 1114ms；强跳 2 次
 *  - [结论] 首次动手的 1114ms 里，媒体就绪只到 707ms，剩下 407ms 是我们自己
 *    的 800ms 确认窗口 + `ct<0.3` 等待
 *  - [结论] 第二支更糟：媒体 +2930ms 就绪时 ct=0，它起播卡住，3 个 tick 才
 *    爬过 0.3 —— `ct<0.3` 这条门白吃 800ms，而我们什么都做不了
 *  - [改动] 起播期（ct<0.3）也直接强跳：元素有元数据就能 seek，贴尾 seek
 *    不依赖"真的播起来了"。宽容 EARLY_SEEK_MAX=2 次，这次 seek 标记为
 *    provisional —— 被播放器在真正起播时重置不算"seek 无效"，不会把
 *    seekFails 顶到 2 误开 16× 加速；宽容用完回到原来的等待逻辑
 *  - [保留] 800ms 确认窗口不动。它不是"反应慢"，是"打开链接先播广告"时
 *    mainDur 未知、唯一能防"把正片推到大结局"的东西
 */
(() => {
  'use strict';

  if (window.__ytAutoSkipLoaded) return;
  window.__ytAutoSkipLoaded = true;

  // 版本号：每次加载无条件打印一行，方便确认"页面里跑的到底是哪一版"
  // （排查时最常见的问题就是改了代码但没刷新扩展/页面）
  const VERSION = (() => {
    try { return chrome.runtime.getManifest().version; } catch (_) { return '1.3.7'; }
  })();
  try { console.log('[YT-AutoSkip] v' + VERSION + ' 已加载'); } catch (_) { /* ignore */ }

  // ---------------- 配置 ----------------
  const CHECK_INTERVAL_MS = 600;      // 兜底轮询间隔
  const CLICK_DELAY_MIN = 150;        // 点击前随机延迟（仅为避开同帧竞态，不再做长延迟）
  const CLICK_DELAY_MAX = 400;
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
  // 这两个是"按元素"的点击状态。广告 pod（连播两支）里 YouTube 会复用同一批
  // DOM 节点，所以它们在每支广告开始时要重置，否则上一支的冷却会挡住下一支。
  let lastClickMap = new WeakMap(); // el -> { t: 时间戳, seq: 广告作用域序号 }
  let pendingSet = new WeakSet();   // 已排队等待点击的元素
  let adScopedSeq = 0;              // 每进入一支新广告 +1，用于让点击冷却"跨支失效、同支有效"

  // 单次 tick 内的可见性 / 文本缓存：同一元素会在 pickBest、inCountdown、
  // deepFindSkipButton 里被反复询问，重复算样式极其浪费。
  // 每个 tick 开头清空（tick 内部不修改 DOM，缓存不会失真）。
  let visCache = new Map();
  let textCache = new Map();
  let targetVisCache = new Map();     // [v1.3.0] 点击候选可用性缓存（含 0×0 放宽）

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
  let adStateCache = undefined;       // [P2] 本 tick 内的 adStateStrong 缓存（跨 tick 自动失效）
  let lastTextScan = 0;               // [P3] 文本兜底扫描节流基准

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
  // v1.3.3：每条日志带"相对页面加载的毫秒数"。之前排查全靠 console 行序猜时序，
  // 分不清"200ms 内完成"和"卡了 6 秒"——加了时间戳才能把体感延迟量化。
  const LOG_T0 = Date.now();

  // v1.3.6：调试日志环形缓冲，供 popup「复制调试日志」一键导出。
  // 现场排查最大的时间浪费不是看日志，而是从几百行 YouTube 噪音（preload、
  // CSP、serviceworker）里把十几行扩展输出翻出来——长文本粘贴还会被截断，
  // 而截断点常常正好落在广告那一段。这里只留自己的行，导出即用。
  const LOG_BUF_MAX = 500;      // 约 3~5 次广告的量，超出丢最旧的
  const logBuf = [];
  function pushLog(line) {
    if (logBuf.length >= LOG_BUF_MAX) logBuf.shift();
    logBuf.push(line);
  }

  function dlog(...args) {
    if (!debug) return;
    const ts = '[YT-AutoSkip] +' + (Date.now() - LOG_T0) + 'ms';
    console.log(ts, ...args);
    pushLog(ts + ' ' + args.join(' '));
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

  // v1.3.5："未动进度"专用节流：原因变了立即打印，否则 5s 一条。
  // 现场日志里 readyState=0 持续了 16 秒，旧实现每 3s 打一条一模一样的，
  // 看不出中间有没有变化；按"原因变化"打印才是时间线。
  let lastVskipWhy = '';
  let lastVskipAt = 0;
  function logVskipWhy(why, now, extra) {
    if (!debug) return;
    if (why === lastVskipWhy && now - lastVskipAt < 5000) return;
    lastVskipWhy = why;
    lastVskipAt = now;
    dlog('⏩ 本 tick 未动进度：', why, extra);
  }

  // v1.3.6：供 popup 导出日志。只回传本扩展自己的行，不带页面噪音。
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== 'ytAutoSkip:dumpLog') return undefined;
      sendResponse({
        version: VERSION,
        debug: !!debug,
        count: logBuf.length,
        text: logBuf.join('\n'),
      });
      if (msg.clear) logBuf.length = 0;
      return true;
    });
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

  // 是否"跳过语义"的元素。判定以「文案/aria-label 是跳过」为准：
  // 仅凭 class 含 skip+button 会把 YouTube 为兼容保留的 0×0 空壳也算进来，
  // 那种空壳点了没用，还会在选择器顺序上挤掉真正的按钮（v1.2.3 的教训）。
  function hasSkipSemantics(el) {
    if (!el || !el.tagName) return false;
    const t = elementText(el);
    if (!t || t.length > 40) return false;
    return SKIP_TEXT_RE.test(t) && !BAD_TEXT_RE.test(t);
  }

  // 点击候选的"可用"判定。
  // v1.3.0：YouTube 新版全屏布局里存在「用户看得见、但按钮自身 getBoundingClientRect()
  // 返回 0×0」的跳过按钮（视觉由父级/网格绘制，实测日志里 rect=0x0、text="跳过"）。
  // 严格按尺寸判定会让点击一直等布局，体感就是"看到按钮却迟迟不点"。
  // 因此对跳过语义的元素放宽：CSS 没被隐藏就算可用，点击走 el.click()（不派发坐标事件）。
  function isTargetVisible(el) {
    const cached = targetVisCache.get(el);
    if (cached !== undefined) return cached;
    let result = isVisible(el);
    if (!result && hasSkipSemantics(el) && !isCssHidden(el)) result = true;
    targetVisCache.set(el, result);
    return result;
  }

  function computeVisible(el) {
    if (isCssHidden(el)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // 只看 CSS 是否隐藏（display/visibility/opacity，含祖先，跨 shadow 边界），不看尺寸。
  // v1.2.8：祖先链跨 shadow 边界继续（宿主的 display:none 会隐藏整棵影子树，
  // 而 parentElement 到 shadow root 就断了，会漏判成"可见"）。
  // v1.3.3：visibility 只认元素自身的 computed 值。visibility 可继承也可被后代覆盖，
  // 元素自身的 getComputedStyle 已经是最终结论；祖先的 visibility:hidden 若被后代
  // 改回 visible，祖先那一条不能再算隐藏（旧实现会把这种按钮永久判成不可见）。
  // display:none / opacity:0 仍是"祖先隐藏 = 整棵子树隐藏"，必须继续沿祖先链检查。
  function isCssHidden(el) {
    let node = el;
    let depth = 0;
    let isSelf = true;
    while (node && depth++ < 40) {
      let st = null;
      try { st = getComputedStyle(node); } catch (_) { st = null; }
      if (st) {
        if (st.display === 'none' || st.opacity === '0') return true;
        if (isSelf && st.visibility === 'hidden') return true;
      }
      isSelf = false;
      let p = node.parentElement;
      if (!p) {
        let root = null;
        try { root = node.getRootNode ? node.getRootNode() : null; } catch (_) { root = null; }
        p = root && root.host ? root.host : null;   // 跳出 shadow 边界
        if (!p) break;
      }
      node = p;
    }
    return false;
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
    // 沿 Shadow DOM 边界逐层向上检查（v1.2.6）。
    // closest() 不跨 shadow root：若跳过按钮藏在某个 <a> 宿主的 shadow tree 里，
    // 单次 closest 返回 null → 会误判为"安全"，而 composed:true 的点击会冒泡到
    // 宿主的 <a> 打开广告落地页（v1.2.3 弹窗根因的残留口子）。
    // 这里用 getRootNode().host 逐层跳出 shadow，对每一层都检查链接/广告创意祖先。
    let node = el;
    let depth = 0;
    while (node && depth++ < 20) {
      // 当前 root 内的 <a>（有无 href 都算，无 href 的 a 也常靠 JS 跳转）
      // 或 [role="link"] 祖先 → 点击会跳转/打开广告主页面
      if (node.closest && node.closest('a, [role="link"]')) return false;
      // 广告创意 / "访问广告主" 区域
      if (node.closest && node.closest('[class*="ytp-ad-clickable"], [class*="ytp-ad-visit-advertiser"]')) return false;
      // 当前节点自身类名命中危险类（含 shadow 宿主）
      if (UNSAFE_CLASS_RE.test(classOf(node))) return false;
      let root = null;
      try { root = node.getRootNode ? node.getRootNode() : null; } catch (_) { root = null; }
      if (root && root.host) { node = root.host; } else { break; }
    }
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
      if (!isTargetVisible(c)) continue;
      if (inCountdown(c)) continue;
      const r = c.getBoundingClientRect();
      const area = r.width * r.height;
      // 同分时：优先有尺寸的（0×0 只是放宽可点，有真实布局的目标更可能是真按钮），
      // 都有尺寸再取面积更小的（更精确，避免点到整块容器）
      let better = false;
      if (rank > bestRank) better = true;
      else if (rank === bestRank) {
        if (bestArea > 0 && area === 0) better = false;
        else if (bestArea === 0 && area > 0) better = true;
        else better = area < bestArea;
      }
      if (better) {
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
    const rec = lastClickMap.get(el);
    // 只认"当前这支广告里"的点击。pod 换支时 seq 变化 → 冷却自动失效；
    // 同一支里重复命中同一元素 → 冷却继续生效，不会几百毫秒连点好几次。
    return !!rec && rec.seq === adScopedSeq && Date.now() - rec.t < RECLICK_COOLDOWN;
  }

  // v1.3.3：0×0 的跳过按钮，点击目标要"升级"到真正有布局盒的外壳。
  // 现场日志：rect= 0x0、text= "跳过"，点击后广告没有立刻结束。没有布局盒的元素上
  // el.click() 常常是空操作——YouTube 的命中测试按几何盒子走。
  // 约束（很容易踩坑）：只接受"外壳类名含 skip 或 role=button"的祖先，且文案仍纯粹
  // 是跳过。否则会一路爬到 #movie_player 上——那等于点了播放器空白处，纯浪费一次点击
  // （实测测试 L 就是这样退化成 clicks=0 的）。
  function resolveClickableBox(el) {
    if (!el) return el;
    const r0 = el.getBoundingClientRect();
    if (r0.width > 0 && r0.height > 0) return el;
    let node = el.parentElement;
    let depth = 0;
    while (node && depth++ < 3) {
      const cn = classOf(node);
      const isShell = /skip/i.test(cn) ||
        (node.getAttribute && node.getAttribute('role') === 'button');
      if (!isShell) return el;
      if (node.matches && node.matches('#movie_player, .html5-video-player')) return el;
      const t = elementText(node);
      if (!t || t.length > 40 || !SKIP_TEXT_RE.test(t) || BAD_TEXT_RE.test(t)) return el;
      if (isCssHidden(node)) return el;
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        if (!isSafeClickTarget(node)) return el;
        return node;
      }
      node = node.parentElement;
    }
    return el;
  }

  function clickElement(el) {
    lastClickMap.set(el, { t: Date.now(), seq: adScopedSeq });
    const original = el;
    el = resolveClickableBox(el);
    const rect = el.getBoundingClientRect();
    dlog('🖱️ 实际点击:', (el.tagName || '').toLowerCase(),
      '| rect=', Math.round(rect.width) + 'x' + Math.round(rect.height),
      '| 升级到祖先=', el !== original,
      '| cls=', classOf(el).slice(0, 60));
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
    // 升级到外壳时，原 0×0 按钮上也可能挂着 YouTube 的处理函数，补一次原生点击
    if (el !== original) { try { original.click(); } catch (_) { /* ignore */ } }
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
    // [P4] 不可见元素直接返回空：否则下面会对每个文本节点的父节点
    // 调用 isVisible（遍历整条祖先链算 getComputedStyle），纯浪费。
    if (!isVisible(el)) { textCache.set(el, ''); return ''; }
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

  function scheduleClick(el, onDone, label, requireAd) {
    if (!el || isCoolingDown(el) || pendingSet.has(el)) return false;
    pendingSet.add(el);
    // 只有真正调度了点击才打日志，避免"找到按钮"日志在冷却期内刷屏
    dlog('✅ 准备点击:', label || classOf(el).slice(0, 60) || el.tagName);
    setTimeout(() => {
      pendingSet.delete(el);
      if (destroyed || !enabled || isCoolingDown(el) || !isAttached(el)) return;
      // [S1] TOCTOU 复检：点击延迟 300–900ms 期间，元素可能被复用、被挪进广告
      // 链接（<a>/[role=link]），或广告已结束。点击前重新确认它仍然安全；
      // 跳过按钮还要求仍在强广告态（requireAd），否则点一个已失效/被复用的节点
      // 可能误触广告主落地页——这正是 v1.2.3「弹窗」问题的复发路径。
      if (!isSafeClickTarget(el)) return;
      // 强制重算广告态：这里已经跨出 tick 了，读缓存可能拿到上一次扫描的旧结论
      if (requireAd && !adStateStrong(true)) return;
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

  function computeAdState() {
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

  // force=true：跳过缓存重新判定。用于"延迟点击回调"这类跨 tick 的复检——
  // 缓存只在 tick 开头失效，而调用可能发生在两次 tick 之间，读到的是上一次
  // 扫描的结论（广告已结束却仍判为 true，S1 的 TOCTOU 复检就形同虚设）。
  function adStateStrong(force) {
    // [P2] 单 tick 内缓存：tick 开头会清空 adStateCache，
    // 同一次 tick 里 findSkipButton / forceSkipAdViaVideo / emitDebugBeat
    // 多次调用只计算一次（含多次 querySelector + isVisible），省下重复开销。
    if (!force && adStateCache !== undefined) return adStateCache;
    const result = computeAdState();
    adStateCache = result;
    return result;
  }

  // [S2] 视频层强跳是"破坏性"操作（直接改 currentTime），一旦误判就是把正片
  // 推到结尾，后果比"没跳过"严重得多。因此只用最硬的 .ad-showing 信号判定——
  // overlay 类信号（.ytp-ad-overlay-container / .ytp-ad-progress-list 等）在正片
  // 播放时也可能为真，不能用于此破坏性路径；它们仍服务于点击路径（adStateStrong）。
  function isRealVideoAd() {
    const p = document.querySelector('#movie_player, .html5-video-player');
    if (p && p.classList && p.classList.contains('ad-showing')) return true;
    if (document.querySelector('.ad-showing')) return true;
    return false;
  }

  // ---------------- 视频层强跳（不依赖任何按钮 DOM） ----------------
  // 广告本质上是播放器在播另一段视频：把它的播放进度推到结尾，广告就立刻结束。
  // 这条路径绕开"按钮找不到 / 按钮是空壳 / shadow 点击无效"的所有问题，
  // 是保证"一定有跳过动作"的最后一道保险。
  const AD_MAX_DURATION = 300;   // 只处理 ≤5 分钟的片子（广告），先把长视频排除
  const AD_SKIP_MIN_WAIT = 200;    // 广告标记出现后至少等这么久再动手（等播放器把 video 挂上）
  const AD_SKIP_CONFIRM_MS = 800;  // 无法证明"不是正片"时（mainDur 未知）必须等满的确认窗口
  const VIDEO_SKIP_GAP = 900;    // 同一 video 元素最小间隔
  const END_STALL_MS = 3000;     // 贴到结尾却迟迟不结束时，多久后改用加速
  let lastVideoSkip = 0;
  let mainDur = 0;               // 最近一次"非广告态"观察到的正片时长
  let adEndGuardUntil = 0;       // 广告刚结束的一小段时间内禁止动进度
  let jumpTarget = 0;            // 上次 seek 的目标位置（0 = 无需校验）
  let jumpProvisional = false;   // 上次 seek 是在"广告还没真的起播"时下的（v1.3.7）
  let earlySeeks = 0;            // 本次广告里"起播期 seek"已用掉几次（v1.3.7）
  const EARLY_SEEK_MAX = 2;      // 起播期 seek 的宽容次数，用完后回到原来的 ct>=0.3 等待
  let jumpEl = null;             // 上次 seek 的那个 video 元素
  let jumpDur = 0;               // 上次 seek 时该视频的总时长（用于识别"已经换了一支广告"）
  let seekFails = 0;             // 连续 seek 无效次数
  let rateBoostEl = null;        // 被我们加速过的 video 元素
  let rateBoostPrev = 1;         // 加速前的原速率（用户本来可能就在 2×）
  let endStallSince = 0;         // 广告贴在尾部不动的起始时间戳（0 = 未卡住）
  let videoSkipTimes = new WeakMap();   // video -> 上次跳转时间（同样按广告重置）
  let lastJumpDur = 0;                  // 上一次强跳的视频时长，用于认出 pod 里的下一支

  // ---- v1.3.5：广告耗时归因 ----
  // 现场日志（v1.3.4）里"广告开始 → 广告结束"整整 18.2 秒，但里面只有 1.8 秒
  // 是真的在播广告，其余全是 readyState=0 的等待。这三个量把等待拆开，
  // 下次贴日志只要看 📊 那一行就知道时间到底花在我们身上还是播放器身上。
  let adFirstActionAt = 0;    // 本次广告内第一次真的动手（跳/加速/催流）的时间
  let adJumpCount = 0;        // 本次广告内成功强跳的次数（pod 会 >1）
  let adMediaWaitMs = 0;      // 本次广告内 video 处于 readyState<1 的累计时长（估算）
  let adMediaSampleAt = 0;    // 上面那个累计量的采样基准
  let adMediaReadyDur = 0;    // 已经播报过"媒体就绪"的那支广告的时长（用于去重）
  let nudgeTimes = new WeakMap();       // video -> { n, t } 催流记录（按广告重置）
  const MEDIA_NUDGE_MAX = 3;            // 同一支广告最多催几次
  const MEDIA_NUDGE_GAP = 1200;         // 两次催流的最小间隔

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

  // 广告边界：清掉"按元素"记录的点击/跳转状态。
  // pod 内 YouTube 复用同一批 DOM 节点和同一个 <video>，这些状态若不重置，
  // 上一支的 3.5s 点击冷却会整个盖到下一支头上。
  function resetAdScopedState() {
    adScopedSeq += 1;                 // 让上一支的点击冷却整体失效（不必重建 WeakMap）
    pendingSet = new WeakSet();
    videoSkipTimes = new WeakMap();
    nudgeTimes = new WeakMap();
    earlySeeks = 0;
    jumpProvisional = false;
  }

  // ---- v1.3.5：广告耗时归因 ----
  function resetAdStats(now) {
    adFirstActionAt = 0;
    adJumpCount = 0;
    adMediaWaitMs = 0;
    adMediaSampleAt = now;
    adMediaReadyDur = 0;
  }

  function markAdAction(now) {
    if (!adFirstActionAt) adFirstActionAt = now;
  }

  // 每 tick 采样一次：广告期间 video 处于 readyState<1 的时长累加进来。
  // 这一段是"我们什么都做不了"的时间（广告媒体没加载 / 播放器在切流），
  // 和被 200ms 最小等待、冷却窗口挡掉的时间完全不是一回事，必须分开计时。
  function sampleAdMedia(now) {
    const v = currentVideo();
    if (!v) { adMediaSampleAt = now; return; }
    if (adMediaSampleAt && v.readyState < 1) adMediaWaitMs += now - adMediaSampleAt;
    adMediaSampleAt = now;
    if (v.readyState < 1) return;
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0) return;
    const key = Math.round(dur * 10) / 10;
    if (key === adMediaReadyDur) return;      // 同一支只报一次（pod 里时长变了会再报）
    adMediaReadyDur = key;
    dlog('🎬 广告媒体就绪：检测到广告后 +', now - (adStateSince || now), 'ms',
      '| duration=', key, '| 累计等待媒体=', adMediaWaitMs, 'ms');
  }

  // 推完一支广告后 video 会长时间停在 readyState=0（现场 7~9 秒），此时 seek
  // 一定无效，能做的只有把 media element 的资源加载算法重新拉起来。
  // 对 readyState=0 的元素调 play() 正是触发它的方式，且不会改变播放位置。
  // 限制：只对"我们刚推过结尾的那个元素"做、每支最多 3 次、间隔 1.2s，
  // 免得在正常的缓冲抖动里反复打扰播放器。
  function nudgeDetachedMedia(v, now) {
    // 认元素而不是认时长：readyState=0 时 duration 往往已经是 NaN（媒体被摘），
    // 按"时长等于上次强跳的那支"来判会永远不成立，这个实验就永远不会执行。
    const ours = jumpEl === v;
    if (!ours) return false;
    const rec = nudgeTimes.get(v) || { n: 0, t: 0 };
    if (rec.n >= MEDIA_NUDGE_MAX) return false;
    if (now - rec.t < MEDIA_NUDGE_GAP) return false;
    rec.n += 1;
    rec.t = now;
    nudgeTimes.set(v, rec);
    // play() 在"没有可用媒体源"时会返回一个 rejected promise：
    // 这是预期内的情况，必须自己吞掉，否则控制台会多出 Uncaught (in promise)。
    try {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* 预期内，忽略 */ });
    } catch (_) { /* ignore */ }
    markAdAction(now);
    dlog('⏩ 媒体未就绪且已贴尾，催流 play()（第', rec.n, '次 / 上限', MEDIA_NUDGE_MAX, '）');
    return true;
  }

  function forceSkipAdViaVideo() {
    const now = Date.now();
    if (now - lastVideoSkip < 700) return false;
    if (now < adEndGuardUntil) return false;   // 广告刚结束，防误判保护窗口
    if (!isRealVideoAd()) return false;         // [S2] 破坏性操作，只用最硬的广告信号

    const player = document.querySelector('#movie_player, .html5-video-player');
    if (!player) return false;

    // 先校验上一次 seek 是否真的生效：有的广告播放器会忽略 currentTime 赋值。
    // 若被忽略（进度明显落后于目标），累计失败次数，转为加速播放。
    if (jumpTarget > 0) {
      // v1.3.4：用 isAttached 而不是 document.contains —— 后者对 shadow root 内的
      // 节点恒为 false，会把有效的 video 判成"已脱离"，白白丢掉 seek 校验。
      const pv = (jumpEl && isAttached(jumpEl)) ? jumpEl : currentVideo();
      const sameClip = pv && isFinite(pv.duration) && Math.abs(pv.duration - jumpDur) <= 1;
      if (pv && sameClip && isFinite(pv.currentTime) && pv.currentTime < jumpTarget - 2) {
        // v1.3.7：起播期下的 seek 本来就容易被播放器在"真正起播"时重置，
        // 这不能算"seek 无效"——否则会白白把 seekFails 顶到 2 并触发 16× 加速。
        // 宽容次数由 EARLY_SEEK_MAX 控制，用完之后一切照旧。
        if (jumpProvisional) {
          dlogReject('earlyseek', '⏩ 起播期 seek 被丢弃（不算无效）：currentTime=',
            Math.round(pv.currentTime * 10) / 10, '目标=', Math.round(jumpTarget * 10) / 10);
        } else {
          seekFails += 1;
          dlog('⏩ 上次 seek 未生效（currentTime=', Math.round(pv.currentTime * 10) / 10,
            '目标=', Math.round(jumpTarget * 10) / 10, '），连续第', seekFails, '次');
        }
      } else if (sameClip) {
        seekFails = 0;
      }
      // 时长变了 = 已经换了一支广告，上一次的结果无从判断，计数保持不变
      jumpTarget = 0;
      jumpProvisional = false;
    }

    // v1.3.4：诊断用。之前所有 continue 都是静默的，"广告开始 → 强跳"实测要 1.9s，
    // 完全看不出这一秒多花在 readyState、currentTime<0.3 还是 tick 没跑到。
    const vids = player.querySelectorAll('video');
    let acted = false;
    let why = '';
    let whyInfo = '';

    for (const v of vids) {
      if (!v) continue;
      const dur = v.duration;
      const ct = v.currentTime;
      if (!why) {
        whyInfo = ' | dur=' + (Math.round(dur * 10) / 10)
          + ' | ct=' + (Math.round(ct * 10) / 10)
          + ' | paused=' + v.paused;
      }
      if (v.readyState < 1) {
        // v1.3.5：readyState=0 有两种完全不同的含义，以前混成一条日志，
        // 于是把"播放器在切流"误判成"我们没动手"。
        //  - 媒体未加载：广告刚换上/刚被摘流，谁也动不了，只能等
        //  - 已贴尾在切流：我们上一 tick 已经把它推到结尾，播放器正在换下一支
        const torn = jumpDur > 0 && isFinite(dur) && Math.abs(dur - jumpDur) <= 1;
        nudgeDetachedMedia(v, now);
        why = why || (torn
          ? 'readyState=0（上一支已贴尾，播放器在切流）'
          : 'readyState=0（广告媒体未加载）');
        continue;
      }
      if (!isFinite(dur) || dur <= 0 || dur > AD_MAX_DURATION) { why = why || ('dur=' + dur); continue; }
      // 时长与正片一致 → 这是正片，绝不碰（避免"跳到大结局"）
      if (mainDur && Math.abs(dur - mainDur) <= 1) {
        why = why || '时长与正片一致';
        dlogReject('maindur', '⏩ 时长与正片一致（', Math.round(dur * 10) / 10, 's），判定为正片，不动进度');
        continue;
      }
      // v1.3.3：能证明"这个 video 不是正片"（时长与 mainDur 明显不同）时立刻动手，
      // 不再统一等 800ms——那 0.8 秒是用户"看得见按钮、广告还在播"的主要来源。
      // 证明不了（mainDur 还没记到，例如"打开链接先播广告"）时保留确认窗口，
      // 否则可能把正片当广告推到片尾，这个风险不值得省那 0.8 秒。
      if (!(mainDur > 0) && now - adStateSince < AD_SKIP_CONFIRM_MS) {
        why = why || '确认窗口未满';
        continue;
      }

      const atEnd = dur - ct < 1;

      // v1.3.4：广告已贴尾却被暂停 —— 播放器在等"广告结束/切下一支"的指令，
      // 网络或广告服务一慢就会长时间挂着（现场日志：跳完 27.8s 那支后，过了 9.2s
      // 才切到下一支，期间 tick 全被 "暂停中不动进度" 静默挡掉）。
      // 这里主动补一次 seek + play 把它推过去；用 videoSkipTimes 节流，别每 tick 骚扰。
      // v1.3.5：注意这条分支只在 readyState>=1 时才会走到——广告切流期间 video
      // 是 readyState=0，被上面那条挡掉了。所以现场那 9.2 秒从来不是它造成的，
      // 保留它只为"媒体已就绪但播放器暂停"这种真实情况。
      if (v.paused) {
        if (!atEnd) { why = why || 'paused'; continue; }
        const t2 = videoSkipTimes.get(v);
        if (t2 && now - t2 < VIDEO_SKIP_GAP) { why = why || '贴尾暂停（刚催过）'; continue; }
        videoSkipTimes.set(v, now);
        lastVideoSkip = now;
        try { v.currentTime = Math.max(0, dur - 0.05); } catch (_) { /* ignore */ }
        try { v.play(); } catch (_) { /* ignore */ }
        acted = true;
        markAdAction(now);
        dlog('⏩ 广告贴尾但被暂停（多半在等切流），主动续播：duration=', Math.round(dur * 10) / 10,
          '| currentTime=', Math.round(ct * 10) / 10);
        continue;
      }
      // v1.3.7：广告起播慢的时候，`ct < 0.3` 这条门比媒体加载还贵。
      // 现场日志（v1.3.6）第二支广告：媒体 +2930ms 就绪时 ct= 0，可它起播卡住，
      // 3 个 tick 后才爬过 0.3——这 800ms 我们什么都做不了，纯粹在等时钟。
      // 事实上贴尾 seek 在 ct≈0 时照样有效（元素有元数据就能 seek），所以改成：
      // 起播期也直接动手，但只宽容 EARLY_SEEK_MAX 次，并且这次 seek 记成 provisional
      // （被播放器重置不算"seek 无效"，见上面的校验）。宽容用完仍不动就回到旧的等待。
      // 注意：不要用 v.seekable.length 当门。广告元素刚换源时 seekable 经常是空的
      // （连 jsdom 里非媒体元素也恒为空），按它判会退回到"什么都不做"的老毛病。
      const early = ct < 0.3;   // 刚起播，进度还没走过 0.3 秒
      if (early && earlySeeks >= EARLY_SEEK_MAX) {
        why = why || 'currentTime<0.3（起播期已宽容' + EARLY_SEEK_MAX + '次）';
        continue;
      }

      const t = videoSkipTimes.get(v);
      if (t && now - t < VIDEO_SKIP_GAP) { why = why || '跳转间隔内'; continue; }

      // 贴尾判定：有的广告播放器接受 currentTime 赋值后并不触发 ended，
      // 广告就永远停在最后一帧。贴尾超过 END_STALL_MS 仍未结束 → 改用加速。
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
        // 认出"换了一支广告"的第二种形态：pod 里 YouTube 有时不切换 .ad-showing，
        // adEpoch 就不 +1（现场日志 15s → 36s 两支只记了"第 1 次"）。
        // 这时只能靠"被跳的视频时长变了"来判断，否则上一支的点击冷却会盖住下一支。
        if (dur !== lastJumpDur) {
          lastJumpDur = dur;
          resetAdScopedState();
        }
        jumpTarget = Math.max(0, dur - 0.05);
        jumpEl = v;
        jumpDur = dur;
        jumpProvisional = early;
        if (early) earlySeeks += 1;
        v.currentTime = jumpTarget;
        adJumpCount += 1;
        markAdAction(now);
        dlog('⏩ 视频层强跳：duration=', Math.round(dur * 10) / 10,
          '→ currentTime=', Math.round(v.currentTime * 10) / 10,
          early ? '（起播期 ct=' + (Math.round(ct * 10) / 10) + '，第 ' + earlySeeks + ' 次尝试）' : '');
        epochActed = true;
        return true;
      } catch (err) {
        dlog('⏩ 视频层强跳失败:', String(err && err.message));
      }
    }
    // v1.3.4：没动手就把原因记下来，否则"广告播了 1.9 秒才跳"永远说不清是
    // readyState、currentTime<0.3、确认窗口，还是 tick 根本没跑到。
    // v1.3.5：只在"原因变了"或满 5s 时打印。之前在 readyState=0 的那 16 秒里
    // 每 3s 重复同一条，时间线反而看不清；现在每换一个阶段恰好一行。
    if (!acted && why) {
      logVskipWhy(why, now, whyInfo
        + ' | 候选 video=' + vids.length
        + ' | 广告已持续=' + (now - adStateSince) + 'ms'
        + ' | mainDur=' + mainDur);
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
  // 跨 shadow 边界的 closest：closest() 到 shadow root 就停，
  // 影子树内的节点向上找容器（迷你播放器、广告创意区）会漏判。
  function closestDeep(el, sel, maxDepth) {
    const limit = maxDepth || 20;
    let node = el;
    let depth = 0;
    while (node && depth++ < limit) {
      if (node.closest) {
        let hit = null;
        try { hit = node.closest(sel); } catch (_) { hit = null; }
        if (hit) return hit;
      }
      let root = null;
      try { root = node.getRootNode ? node.getRootNode() : null; } catch (_) { root = null; }
      node = (root && root.host) ? root.host : null;
    }
    return null;
  }

  // 是否仍在文档中。v1.2.8：document.contains() 对 shadow root 内的节点恒为 false，
  // 会把影子树里的跳过按钮一律判为"已脱离 DOM"而放弃点击——深度扫描专门为
  // shadow 按钮存在，等于白跑。isConnected 是 shadow-including 判定，语义正确。
  function isAttached(el) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean') return el.isConnected;
    return document.contains(el);
  }

  function inMiniPlayer(el) {
    return !!(el && closestDeep(el, '#mini-player, .ytp-miniplayer-ui'));
  }

  // 深度遍历（穿透 open Shadow DOM）收集 root 子树里的所有元素。
  // YouTube 新版 UI（yt-spec-button-shape-next 等组件）把可见的"跳过广告"
  // 按钮渲染在 shadow root 里，普通 querySelectorAll 看不到它。
  function walkDeep(root, out, depth) {
    if (depth > 6) return out;
    let els;
    try { els = root.querySelectorAll('*'); } catch (_) { return out; }
    for (const el of els) {
      // [P1] 预筛：只收可能是按钮/跳过相关的节点，避免后续对每个 div/span
      // 都读 role/aria-label/title/class。实测 12k 节点时全量遍历占单次 tick 的
      // 绝大部分开销，而普通标签（DIV/SPAN/P/A/IMG...）根本不可能是跳过按钮。
      // tagName / className 是廉价属性读取；SVG 的 className 是对象，这里按 '' 处理。
      const tg = el.tagName;
      if (tg) {
        const cn = typeof el.className === 'string' ? el.className : '';
        if (tg === 'BUTTON' || tg === 'TP-YT-PAPER-BUTTON' || tg.indexOf('-') > 0 ||
            cn.indexOf('ytp-') >= 0 || cn.indexOf('button') >= 0 ||
            cn.indexOf('skip') >= 0 || cn.indexOf('ad-') >= 0) {
          out.push(el);
        }
      }
      if (el.shadowRoot) walkDeep(el.shadowRoot, out, depth + 1);
    }
    return out;
  }

  // 在广告相关容器内做"穿透 Shadow DOM"的跳过按钮扫描（v1.1.8 核心修复）。
  let lastDeepScan = 0;
  const deepRejectSeen = new WeakSet();
  function deepFindSkipButton() {
    // 节流：至少间隔 2000ms。可跳过广告的倒计时通常 ≥5s，2s 一次足够，
    // 且本函数会全量遍历播放器子树（即便有 P1 预筛仍不便宜），降低频率更稳。
    const now = Date.now();
    if (now - lastDeepScan < 2000) return null;
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
            '| cssHidden=', isCssHidden(node),
            '| disabled=', isDisabled(node),
            '| countdown=', inCountdown(node),
            '| mini=', inMiniPlayer(node),
            '| rect=', (() => { const r = node.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
            '| text=', JSON.stringify(elementText(node).slice(0, 30)),
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
      // [P3] 文本兜底全量遍历（querySelectorAll 所有按钮 + 逐个读文本/属性）
      // 相当昂贵，且只作"找不到标准按钮"时的最后一招。广告倒计时通常 ≥5s，
      // 2000ms 一次足够，避免每 tick 都跑；标准选择器查找（步骤 1）仍每 tick 执行。
      const nowT = Date.now();
      if (nowT - lastTextScan < 2000) return null;
      lastTextScan = nowT;
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
    // [S4] 关闭按钮只在明确广告态下查找（与跳过按钮一致）：否则非广告态的
    // 偶发"关闭"按钮（如页面内其他 X）可能被误点；点击前的 isSafeClickTarget
    // 复检（见 scheduleClick）仍会挡住被复用成广告链接的情况。
    if (!adStateStrong()) return null;
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
    // adStateCache 也在此重置：保证每次 tick 重新判定广告态，
    // 避免跨 tick 用过期的缓存（见 adStateStrong 注释）。
    visCache.clear();
    textCache.clear();
    targetVisCache.clear();
    adStateCache = undefined;

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
        // 广告 pod 里 YouTube 会复用同一批 DOM 节点和同一个 <video>：
        // 上一支的点击冷却（3.5s）、跳转间隔（0.9s）若跨到下一支，第二支就会被
        // 白白挡几秒，用户看到的仍是"点了但慢半拍"。每次新广告开始都重置。
        resetAdScopedState();
        lastJumpDur = 0;
        resetAdStats(adStateSince);
        lastVskipWhy = '';                    // 新一次广告，诊断从第一行重新打
        dlog('📺 检测到广告开始（第', adEpoch, '次）');
      }
    } else {
      if (adStateSince) {
        const adStartedAt = adStateSince;      // 汇总要用，先存下来
        adStateSince = 0;
        adEndGuardUntil = Date.now() + 1500;   // 广告结束后的保护窗口
        seekFails = 0;
        jumpTarget = 0;
        jumpEl = null;
        jumpDur = 0;
        endStallSince = 0;
        releaseRateBoost();                     // 把播放速度还原，别加速正片
        const total = Date.now() - adStartedAt;
        // v1.3.5：一行交代"这次广告的时间去哪了"。现场日志里 18.2 秒只有 1.8 秒
        // 在真的播广告，其余全是 readyState=0 的等待——但那是靠人工数出来的，
        // 现在直接打印，下次判断"该不该继续优化"不用再猜。
        dlog('📊 广告结束：总', total, 'ms',
          '| 首次动手', adFirstActionAt ? (adFirstActionAt - adStartedAt) + 'ms' : '（全程未动手）',
          '| 强跳', adJumpCount, '次',
          '| 媒体未就绪累计 ' + adMediaWaitMs + 'ms',
          adMediaWaitMs ? '（占 ' + Math.round(adMediaWaitMs / total * 100) + '%）' : '');
        lastVskipWhy = '';
        // 只在"广告真的结束 + 期间我们动过手"时计数，避免点了无效也算一次
        if (epochActed) { epochActed = false; bumpCount(); }
      }
      recordMainDur();
    }

    // v1.3.5：广告期间每 tick 采一次样，累计"媒体没就绪"的时长，
    // 并在媒体刚就绪时补一条 🎬，把"我们的反应"和"广告自己的加载"分开计时。
    if (adStateSince) sampleAdMedia(Date.now());

    // 【主力】广告一开始就把广告视频推到结尾。
    // v1.3.3：外层只挡"广告标记刚挂上的那一两帧"，细粒度确认窗口挪进
    // forceSkipAdViaVideo —— 只有拿到 video 的 duration 才能证明"它不是正片"。
    if (adStateSince && Date.now() - adStateSince >= AD_SKIP_MIN_WAIT) {
      forceSkipAdViaVideo();
    }

    // 【补充】如果确实存在"可见的"跳过按钮（可跳过广告），照旧点它。
    // v1.2.3：不再做"点完还在就升级点外层容器"——外层容器就是广告创意，
    // 点它等于帮广告主打开了落地页（用户看到的弹出窗口）。
    const skipBtn = findSkipButton();
    if (skipBtn) {
      // 跳过按钮是"强广告态下"找到的，延迟期间广告可能已结束/元素被复用，
      // 因此 requireAd=true：点击前要求仍在强广告态（见 scheduleClick 的 S1 复检）。
      const scheduled = scheduleClick(skipBtn, () => { epochActed = true; markAdAction(Date.now()); }, null, true);
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
