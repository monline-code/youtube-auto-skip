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
 *
 * v1.3.8：起播期 seek 上线有效，但暴露了"广告态卡住时疯狂重试"的问题
 *  - [数据] 第一支广告 5303ms 结束、首次动手 1492ms、起播期 ct=0 也跳掉了 ——
 *    v1.3.7 的改动在现场是有效的
 *  - [事故] 第二支之后 `.ad-showing` 一直没摘：一支 581.7 秒的"广告"播了 589 秒，
 *    期间我们每 4.2 秒点一次那个"看得见但点了没用"的跳过按钮，一共 140 次，
 *    全都没生效；同一句 `dur=581.681` 每 5 秒一行，把 500 行日志缓冲刷满，
 *    连"广告开始""媒体就绪"都被挤掉了 —— 贴过来的日志只剩一片重复
 *  - [改动] 点击预算 CLICK_BUDGET=4：同一支广告最多点 4 次，之后打一条
 *    "停止重试"就收手（按钮点了没用，继续点只有 CPU 和日志两种成本）
 *  - [改动] 时长超过 AD_MAX_DURATION 时只解释一次，并带上"广告覆盖层在不在"：
 *    有 → 真长广告；没有 → ad-showing 残留，我们其实在盯正片
 *  - [改动] 心跳不再被"DOM 里有按钮"完全压掉（有按钮时 15s 一次）。事故里
 *    十分钟没有一条状态行，只能从点击日志反推
 *  - [改动] "未动进度"同一原因改指数退避（5→10→20→40→60s）
 *  - [修正] 计数虚高：以前"期间动过手"就 +1，于是那支播到底的广告也被记成
 *    "自动跳过 1 次"。现在要求动作发生在广告结束前 5s 内
 *
 * v1.3.9：识别 ad-showing 残留（不再把正片当广告干等）
 *  - [改动] computeAdState 分层：有 .ad-showing 且时长属正片量级时要求"可见跳过目标"
 *  - [改动] 强跳窗口改由 isRealVideoAd()（仅 .ad-showing）驱动，统计按 lastUiAt 截止
 *
 * v1.4.0：修 v1.3.9 把窗口收得太窄带来的"看得见广告却不动手"+"残留态永不收尾"
 *  - [事故] 现场日志（v1.3.9，30 分钟）：adPlaying= true / strong= true 连续 970 秒，
 *    可这段时间一行强跳日志都没有 —— 因为窗口只看 .ad-showing，而当时 .ad-showing= false、
 *    只有广告覆盖层可见。用户看到的正是"广告在播，扩展一次都没动手"
 *  - [事故] 广告结束后 .ad-showing 残留且媒体变成 3225s（正片量级），跳过按钮仍是
 *    86x36 的可见壳：旧判定"有可见跳过目标就是真广告"，于是点满 4 次熔断，
 *    然后每分钟刷"冷却/排队中"，📊 广告结束永不触发（挂 700 秒）
 *  - [改动] 强跳窗口 = .ad-showing **或**（可见广告覆盖层 **且** 媒体时长是广告量级）。
 *    覆盖层广告（新版 UI 不挂类名）重新能跳；覆盖层残留 + 正片时长不开窗，不刷日志
 *  - [改动] 残留看门狗 AD_RESIDUAL_EXIT_MS：窗口开着但媒体时长属正片量级并持续 8s
 *    → 判残留、打一条 🧹（带 dur/点击次数/最后看到 UI 的时间）、退出等待并静默 60s。
 *    静默只在"媒体时长变回广告量级"或"广告 UI 消失"时解除 —— 真广告来了照样跳
 *  - [改动] 心跳 3s 档只在"可能真的会动手"时用（有按钮，或媒体是广告量级），
 *    其余一律 15s。残留态不再每 3s 刷一行
 *
 * v1.4.1：修正 v1.4.0 的根因误判 —— "时长 > 300s" 不是正片，可能真是长广告
 *  - [事故] 用户指出：那 16 分钟是**真实在播广告**，不是残留。回看日志：
 *    `📺 检测到广告开始（第 2 次）` 之后 dur 从 60.1 变成 3225，`ct` 一路
 *    0 → 3.4 → 33.8 → … → 676 正常推进；`mainDur= 5536.081` 早就在那里了。
 *    3225 与 5536 明显不同 = 这不是正片，可旧规则只看"3225 > 300"就判正片，
 *    一句 🚫 之后 700 秒不再动手，还把结论写成"多半是 ad-showing 残留"。
 *    —— 播放器报给这支广告的时长是 3225s，用户实打实看了 16 分钟仍没被跳过。
 *  - [根因] 用绝对时长猜"是不是正片"从一开始就错。可靠判据是**和记录下来的
 *    正片时长比**：|dur - mainDur| > 容差 → 已经证明这不是正片，多长都能跳。
 *  - [改动] 新增 mainClipLike() / notMainClip()，强跳、广告态判定、窗口信号、
 *    残留看门狗全部改用它们；AD_MAX_DURATION 降级为"mainDur 未知时的保守兜底"
 *  - [改动] 残留看门狗改判"媒体时长≈正片"，不再拿 300s 当分界线 ——
 *    否则长广告一进来就被当成残留退出，反而更跳不掉
 *  - [日志] 🚫 不再断言"多半是残留"，改成说清"没有正片时长作参照，不敢推"
 *
 * v1.4.2：补上"广告在播但没挂 .ad-showing"这条通道
 *  - [事故] 同一份日志的前 970 秒（≈16 分钟）：`adPlaying= true | .ad-showing= false |`
 *    `命中数= 0`，心跳一直 `strong= true`（说明有广告覆盖层可见），可强跳窗口既不看
 *    adPlaying 也不看这个覆盖层 —— 整段没开窗，一次都没动手
 *  - [改动] 新增 adPlayingOtherMedia()：**YouTube 说广告在播**（.ad-interrupting /
 *    可见广告覆盖层）+ **媒体时长已证明 ≠ 正片** → 认定为广告，开窗并允许强跳。
 *    单看前者会误伤（#player-ads 在正片里也常驻可见），单看后者不够，两个一起才硬
 *  - [改动] 强跳成功 / `yt-navigate-finish` 后作废 mainDur：新上场的正片时长若与
 *    上一支不同，旧参照会把新正片判成"不是正片"。作废后退回保守一侧（宁漏跳）
 *
 * v1.4.3：修 v1.4.2 自己挖的坑 —— "跳成功就作废参照"让后面每支广告都瞎
 *  - [事故] 现场日志：+363689 跳掉 15s 那支广告时把 mainDur 清零（v1.4.2 加的行），
 *    5 秒后 `mainDur= 0`；等到 +755520 换上一支 dur=3225 的媒体，已经没有参照，
 *    只能 🚫 放弃 —— 用户继续硬看。**跳一支广告并不改变正片时长**，作废等于
 *    "跳一次就瞎一次"，pod 里第二支长广告必然漏跳。
 *  - [改动] 删掉"强跳成功即 mainDur = 0"：参照只由 `yt-navigate-finish`（换视频）
 *    作废，那里才是唯一真正会让 mainDur 失效的时机
 *  - [改动] findSkipButton 增加窗口前置条件：窗口没开（只是 #player-ads 常驻横幅）
 *    就不点按钮，免得白烧点击预算；但**不**按"🧹 判过残留"一刀切 —— 没有正片参照
 *    时点跳过按钮是唯一剩下的手段
 *  - [改动] 点击改为多点候选：内层 <button> 一起点 + `elementFromPoint` 命中测试留痕
 *    （现场点了 4 次那个 86x36 的按钮，广告毫不动静，日志却说不出为什么）
 *  - [改动] "冷却/排队中"从 6s 节流改为每支广告只提示一次（现场刷了 180 秒）
 *  - [日志] 心跳补 dur / ct / mainDur / 窗口 四个事实字段 —— 现场那 321 秒
 *    `strong=true | .ad-showing=false | 命中数=0` 光看旧字段判不出是广告还是横幅
 *
 * v1.4.4：给"参照真空"补第二来源，并停止把真广告判成残留
 *  - [事故] 现场日志（54 行）：+383128 新视频的**预播广告**开始 —— 那一瞬间
 *    `yt-navigate-finish` 已把 mainDur 归零（换视频，清得没错），可新正片的
 *    metadata 还没进 `<video>`（`dur` 那时只会报广告时长），于是 +389163 拿到
 *    `dur=1086.5` 时"没有参照" → 🚫 → 用户硬看 18 分钟
 *  - [事故 2] +396809 只过了 13.7 秒就 `🧹 判定为广告态残留`，而同一支广告的
 *    `ct` 还在 5.4 → 20.4 正常推进：**看门狗把真广告杀了**
 *  - [事故 3] `🖱️ 实际点击: 候选= 1 | 命中点= button.ytp-skip-ad-button` ——
 *    事件确实落在按钮上、位置也对，广告照样不动。点击这条路对
 *    `.ytp-skip-ad-button` 是死的（YouTube 不认合成事件），强跳才是主力
 *  - [改动] 新增 mainDurFromPage()：预播广告进广告那一刻，用
 *    `<meta itemprop="duration">` 里的**正片**时长补一次参照（按 video id 校验归属）
 *  - [改动] 残留看门狗只在 `mainClipLike(d)`（能证明是正片）时 8 秒退出；
 *    "没有参照的长媒体"改用 AD_UNKNOWN_EXIT_MS（120s）这个安全阀
 *  - [改动] `yt-navigate-finish` 只在 video id 真的变了才作废 mainDur
 *  - [改动] 删掉"冷却/排队中"那条日志（预算用完已有 🛑，冷却期写出来只是噪音）
 *
 * v1.4.5：让"正片时长参照"真的能拿到（v1.4.4 的兜底实际没生效）
 *  - [事实] 现场日志（v1.4.4，68 行）里 `🎯 正片时长参照取自页面元数据` 一次都没出现，
 *    而进广告那一 tick `mainDur= 未知` —— 说明 `<meta itemprop="duration">` 在那一刻
 *    根本不在页面里。兜底只在测试里成立，现场等于没写。好消息是那两段 pod 的广告
 *    都是 15~60s，走"起播期直接贴尾 seek"，没有参照也照样跳掉了（8.3s / 7.0s 全清）
 *  - [改动] 参照加来源 2：页面内联脚本里的 ytInitialPlayerResponse.videoDetails
 *    （`lengthSeconds` + `videoId` 校验归属，首屏 HTML 就带着）
 *  - [改动] 读不到**不再记成永久答案**：一次 miss 曾让这支视频的所有广告都拿不到
 *    参照（预播广告时页面 metadata 常没渲染），改成 3s 退避重试
 *  - [改动] 无参照的超长媒体不再一句 🚫 就永久放弃：边播边等，参照一到位立刻重判
 *  - [改动] 先读调试开关再启动主循环：页面刚加载的那次 tick 早于 debug 读回来，
 *    "打开链接先播广告"最关键的前几行（📺 / 🎯）以前全被丢掉
 *  - [日志] 心跳补 `覆盖层=`（是哪几个元素把 `strong` 撑成 true 的）。
 *    v1.4.4 日志里连续 322 秒 `strong=true | adPlaying=true | .ad-showing=false`，
 *    当时只能猜是 `#player-ads` 常驻横幅 —— 猜的东西不该留在脑子里
 *
 * v1.4.6：正片时长参照改从页面世界读（三个来源全在隔离世界里猜，现场三次都空）
 *  - [事实] 现场日志（v1.4.5，53 行）：`dur= 未知` 持续 372 秒（页面加载了，但播放器
 *    还没初始化就进了预播广告），整段 `mainDur= 未知`，`🎯` 又是一行都没打。
 *    同时 `strong=true | 覆盖层= 无 | 玩家类=` 截断在 80 字符 —— 连"靠什么判成广告"
 *    都看不出来。三次失败同一个根因：**在隔离世界里猜页面**
 *    （`meta` 不在、内联脚本正则啃不动几 MB 文本、ytInitialPlayerResponse 不在隔离世界）
 *  - [改动] 新增 inj.js（manifest web_accessible_resources）在页面世界读
 *    `movie_player.getPlayerResponse()` / `ytInitialPlayerResponse`，
 *    把**候选值 + 它的 videoId** 一起 postMessage 回来；content 侧只采用
 *    id 与 URL 一致的那个（防"拿广告时长当正片参照"）
 *  - [改动] 桥一上报指向当前视频的时长就立刻采用（不等 3s 退避）：预播广告就在
 *    播放器刚起来那一两秒，等一轮退避用户已经看掉半支
 *  - [日志] 三个来源全读不到时打一行 `❓ 拿不到正片时长参照`，逐项写清
 *    桥/meta/内联各自的状态（每个视频只一条）；心跳的 `playerCls` 换成
 *    `玩家类= ad-showing,ad-interrupting(共N)`，不再被截断吃掉关键类名
 *
 * v1.4.7：桥通了，剩下的是"信不信它的现场证据"
 *  - [事实] 现场日志（v1.4.6，两份 49/45 行）第一次打出了
 *    `🎯 正片时长参照取自页面桥（来源= player.getPlayerResponse）：mainDur= 303 s`，
 *    而且同一 tick 内 3 支广告全走掉 —— 参照这条命脉终于通了
 *  - [事实] 但同一 tick 里先打了一句 `❓ 拿不到正片时长参照 … 桥= 空值/1s前`，
 *    7 毫秒后参照就到位了。桥是异步的，进广告那一刻问它本来就还没答；
 *    这句"每个视频只说一次"的故障报告说的是件并不存在的事，比没有日志更糟
 *  - [事实] 正片播放期间 `strong= true | adPlaying= true | .ad-showing= false
 *    | 覆盖层= #player-ads | 玩家类= 无广告类 | dur == mainDur` 连续 30 秒 ——
 *    `#player-ads` 是页面侧常驻伴生横幅，把整段正片判成了广告态
 *  - [事实] 一支卡在结尾的广告把同一句 `改用 16× 加速播放` 打了 4 次
 *  - [改动] `#player-ads` 移出 AD_OVERLAY_SELECTORS（弱信号不如没有信号）；
 *    "没有 .ad-showing 的广告"改由 `.ad-interrupting` + 时长 ≠ 正片 判定
 *  - [改动] `❓` 加 2.5s 宽限期（REF_DIAG_GRACE_MS），桥还没来得及答时不许宣布失败
 *  - [改动] `桥=` 状态区分 `空值(getPlayerResponse没返回视频信息)` / `空值(无播放器API)`
 *    / `id不符(adVideoId=27s)` —— 两种空值的修法完全不同
 *  - [改动] 16× 加速只在首次真正加速时打一行，之后静默维持
 *
 * v1.4.8：v1.4.7 达标了，但贴尾后的 8 秒里做的事全是空的
 *  - [事实] 现场日志（v1.4.7，109 行）两个目标都达成：正片播放期 25 次心跳
 *    全部 `strong= false | 覆盖层= 无`（`#player-ads` 移除生效），
 *    3 支广告（60 / 29.2 / 25.7+35.4）全部跳掉，`mainDur=1056` 从第一帧就有
 *  - [事实] 但每支强跳之后都在原地空转 8~10 秒，期间做的事全是无效的：
 *    `candidate= 1 | 命中点= button.ytp-skip-ad-button` 点了 2 次
 *    （此时 video 是 readyState=0 / dur=NaN，媒体已被摘掉，按钮连的是上一支的旧 UI）、
 *    催流 play() 3 次（全部在 `paused= false` 下发出一一元素本就在取流，play() 是空操作）
 *  - [事实] 4 次点击全落在这个窗口里，第二支广告还没开始 CLICK_BUDGET 就用完了
 *  - [改动] `tailedWaiting()`：认三件事实（还是我们推的那个元素、时长仍是它、
 *    没流或仍停在结尾），成立时不再点跳过按钮，每支只留一行 `⏭️ 已贴尾…`
 *  - [改动] 催流只在 `v.paused` 为真时做（唯一 play() 能拉起来的情形）
 *  - [改动] 📊 把"媒体未就绪"拆成 `等首支` / `贴尾后等切流`：v1.4.7 那个 86%
 *    里 15.5 秒是等切流（跟 pod 支数成正比），只有 1.2 秒是真在等第一支挂载。
 *    混成一个数，这指标就没法用来判断"还值不值得优化"
 *
 * v1.4.9：强跳是成功的 —— 用户还是看了 30 秒，问题在"贴尾之后"
 *  - [事实] 现场日志（v1.4.8，97 行）里 `⏭️ 媒体已被摘…不点` 生效、预算没再被烧，
 *    `📊 总 30444ms | 强跳 2 次 | 等首支 2436ms / 贴尾后等切流 16617ms（63%）`
 *  - [事实] 但两支广告的 ct 都精确贴到 dur（26/26、400.3/400.4），用户仍然看了 30 秒。
 *    拆开看：tag 到片尾之后元素**停在最后一帧不发 ended**，播放器自己 pause，
 *    我们只能等 ad module 的计时器超时（每支 5~7 秒）
 *  - [事实] 那两次 16× 都是在 `ct == dur` 之后开的 —— 已经在最后一帧，加速不改变任何
 *    时间，只把 playbackRate 改成一个更奇怪的值；而且它写 `videoSkipTimes` 之后，
 *    紧接着把"贴尾暂停 → 续播"挡成了「刚催过」（+5501826）
 *  - [改动] 贴尾落点 `dur - 0.05` → `dur - 0.6`（TAIL_LEAD）：留一点媒体让它真的
 *    走完并发出**原生 ended**，而不是停在"结尾前一瞬"永远等不到
 *  - [改动] 贴尾后若元素是暂停的，立刻 play()（不节流）—— 停在尾部的暂停元素
 *    永远不会播到结束
 *  - [改动] 16× 只在"离结尾还有媒体可走"（tailLeft > 0.25）时开；`stuckAtEnd` 不再
 *    在 `ct == dur` 时触发
 *  - [改动] 收到过 ended 就不再续播（对 ended 的元素 play() 会从头重放，等于把广告
 *    再看一遍）
 *  - [日志] 新增 `✅ 广告收到原生 ended（贴尾后 Xms）` 和 `🕓 贴尾等待换流 … ended 收到=`
 *    —— 下次一眼能分清"元素没播完（seek 落点问题）"和"播完了但 YouTube 不换流"
 */
(() => {
  'use strict';

  if (window.__ytAutoSkipLoaded) return;
  window.__ytAutoSkipLoaded = true;

  // 版本号：每次加载无条件打印一行，方便确认"页面里跑的到底是哪一版"
  // （排查时最常见的问题就是改了代码但没刷新扩展/页面）
  const VERSION = (() => {
    try { return chrome.runtime.getManifest().version; } catch (_) { return '1.4.9'; }
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

  // 广告覆盖层信号：这些容器只在**广告播放时**存在，
  // 出现在其中的"跳过"按钮一定是广告跳过按钮（快进插播广告常用）
  //
  // v1.4.7：**移除 `#player-ads`**。它是页面侧的常驻广告位（伴生横幅），
  // 正片播放时也一直可见。现场（v1.4.6 第一份日志）坐实了危害：
  //   `strong= true | adPlaying= true | .ad-showing= false | 覆盖层= #player-ads
  //    | 玩家类= 无广告类(共23) | dur= 15591.5 | mainDur= 15591.5`
  // 时长与正片一模一样、播放器一个广告类名都没挂，却因为一个横幅被判成广告态。
  // "正片播放期间一直 strong=true" 会让心跳、findCloseButton 全程以为在广告里，
  // 排查时也分不清真广告和横幅。宁可少一个弱信号，也不要一个恒真的信号。
  const AD_OVERLAY_SELECTORS = [
    '.ytp-ad-player-overlay',
    '.ytp-ad-player-overlay-skip-or-preview',
    '.ytp-ad-player-overlay-flyout-cta',
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
  let navHandler = null;              // YouTube SPA 导航（换视频）监听，用于作废 mainDur
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
    try { if (navHandler) document.removeEventListener('yt-navigate-finish', navHandler); } catch (_) { /* ignore */ }
    if (storageListener) {
      try { chrome.storage.onChanged.removeListener(storageListener); } catch (_) { /* ignore */ }
      storageListener = null;
    }
    observer = null;
    pollTimer = null;
    tickTimer = null;
    seekHandler = null;
    navHandler = null;
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
  // v1.3.8：同一条原因用指数退避（5s → 10s → 20s → 40s → 60s 封顶）。
  // 现场那支 589 秒的广告让同一句 dur=581.681 打了上百行，把 500 行缓冲刷满，
  // 连"广告开始""媒体就绪"都被挤掉了——卡住不动的场景里，重复日志毫无信息量。
  let lastVskipWhy = '';
  let lastVskipAt = 0;
  let vskipRepeat = 0;
  function logVskipWhy(why, now, extra) {
    if (!debug) return;
    if (why === lastVskipWhy) {
      const gap = Math.min(5000 * Math.pow(2, vskipRepeat), 60000);
      if (now - lastVskipAt < gap) return;
      vskipRepeat += 1;
    } else {
      vskipRepeat = 0;
    }
    lastVskipWhy = why;
    lastVskipAt = now;
    dlog('⏩ 本 tick 未动进度：', why, extra);
  }

  // v1.3.6：供 popup 导出日志。只回传本扩展自己的行，不带页面噪音。
  // v1.3.7：首行补一条头信息（版本/时间/页内广告次数）。之前导出的文本里
  // 没有版本号——"加载 vX 已加载"那行发生在读到调试开关之前，进不了缓冲，
  // 于是每次贴日志都要靠猜是哪一版。
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== 'ytAutoSkip:dumpLog') return undefined;
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const head = '[YT-AutoSkip] v' + VERSION
        + ' | debug=' + (debug ? 'on' : 'off')
        + ' | ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
        + ' | 行数=' + logBuf.length;
      sendResponse({
        version: VERSION,
        debug: !!debug,
        count: logBuf.length,
        text: logBuf.length ? head + '\n' + logBuf.join('\n') : '',
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

  // v1.4.3：click() 只在一个元素上派发事件是不够的。现场（v1.4.2 日志）对那个
  // 86x36 的 ytp-skip-ad-button 点了 4 次，广告一点动静都没有；下一份日志必须能
  // 分清是"内层 button 才是监听者""这一像素被别的层挡住"，还是事件本身被忽略。
  // 所以这里补两件事：内层真按钮一起点 + elementFromPoint 命中测试留痕。
  function dispatchClickSeq(el, x, y) {
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

  function clickElement(el) {
    lastClickMap.set(el, { t: Date.now(), seq: adScopedSeq });
    const original = el;
    el = resolveClickableBox(el);
    const rect = el.getBoundingClientRect();
    // 0 尺寸节点（如 YouTube 为兼容保留的隐藏 .ytp-skip-ad-button 壳）：
    // 不能用 (0,0) 坐标派发鼠标事件（可能命中无关位置），只发原生 click()。
    if (rect.width <= 0 || rect.height <= 0) {
      dlog('🖱️ 实际点击:', (el.tagName || '').toLowerCase(),
        '| rect= 0x0 | 升级到祖先=', el !== original,
        '| cls=', classOf(el).slice(0, 60), '| 只发原生 click（无布局盒）');
      try { el.click(); } catch (_) { /* ignore */ }
      return;
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    let hit = null;
    try {
      if (typeof document.elementFromPoint === 'function') hit = document.elementFromPoint(x, y);
    } catch (_) { hit = null; }

    const targets = [el];
    // a) 内层真按钮：外壳 + shadow 里的 <button> 是常见结构，监听往往挂在内层
    try {
      const inner = el.querySelectorAll ? el.querySelectorAll('button, [role="button"]') : [];
      for (const b of inner) {
        if (targets.length >= 3) break;
        if (b === el || !isSafeClickTarget(b) || isDisabled(b) || inCountdown(b)) continue;
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) targets.push(b);
      }
    } catch (_) { /* ignore */ }
    // b) 命中测试结果只在"确实属于这个跳过组件"时才采用 —— 否则可能点到
    //    广告创意/落地页，那正是 v1.2.3 里用户看到的弹窗。
    if (hit && hit !== el && targets.indexOf(hit) < 0 && isSafeClickTarget(hit) &&
        (el.contains(hit) || (hit.contains && hit.contains(el)) ||
          closestDeep(hit, '.ytp-ad-skip-button-container, .ytp-skip-ad-button, .ytp-ad-player-overlay-skip-or-preview'))) {
      targets.push(hit);
    }
    dlog('🖱️ 实际点击:', (el.tagName || '').toLowerCase(),
      '| rect=', Math.round(rect.width) + 'x' + Math.round(rect.height),
      '| 升级到祖先=', el !== original,
      '| 候选=', targets.length,
      '| 命中点=', hit ? ((hit.tagName || '').toLowerCase() + '.' + classOf(hit).slice(0, 28)) : '无',
      '| cls=', classOf(el).slice(0, 60));
    for (const t of targets) dispatchClickSeq(t, x, y);
    // 升级到外壳时，原 0×0 按钮上也可能挂着 YouTube 的处理函数，补一次原生点击
    if (el !== original && targets.indexOf(original) < 0) { try { original.click(); } catch (_) { /* ignore */ } }
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
    // v1.3.8：点击预算熔断。现场那支 589 秒的广告里，我们点了 140 次同一个
    // 按钮，一次都没生效——既费 CPU，又把 500 行日志缓冲刷满、把"广告开始"
    // 那几行挤掉了。按钮点了没用就承认没用，停手等它自己结束或换支。
    if (clickBudget <= 0) {
      if (!clickBudgetWarned) {
        clickBudgetWarned = true;
        dlog('🛑 跳过按钮已点击', CLICK_BUDGET, '次仍无效，本支广告停止重试（等它自己结束/换支）');
      }
      return false;
    }
    clickBudget -= 1;
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

  // 广告"创意层"：这些容器是广告画面/素材的载体，只在广告播放时渲染。
  // 与 STRONG_AD_SELECTORS 的区别：不含跳过按钮壳、进度条这类"广告结束后仍留壳"的节点。
  // v1.4.0 用它给"没有 .ad-showing 的覆盖层广告"开一条受限的强跳准入（见 overlayOnlyAd）。
  const AD_FRAME_SELECTORS = [
    '.ytp-ad-player-overlay',
    '.ytp-ad-player-overlay-layout',
    '.ytp-ad-player-overlay-skip-or-preview',
    '.ytp-ad-overlay-container',
    '.ima3-ad-container',
  ];

  // v1.3.9：广告态判定加入"残留识别"。
  // 背景：广告结束后 .ad-showing 可能残留，此时正片在播。v1.3.8 现场一支 341.8s
  // 正片被当成广告，干等近 10 分钟、统计虚报 360s。
  // 规则（分层，尽量不误伤既有能力）：
  //   1) 有可见广告覆盖层 → 明确是广告（正片不会有广告覆盖层）
  //   2) 没有 .ad-showing → 只认覆盖层（新版 UI 可能不挂类名）
  //   3) 有 .ad-showing 但视频时长 > AD_MAX_DURATION（正片量级）→ 必须是真广告：
  //      还要存在"可见跳过目标"，否则判残留（退出等待/统计）
  //   4) 其余（短广告 / dur 还没读出）→ 信任 .ad-showing（保留 shadow、0×0 按钮等能力）
  // 注意：视频层强跳不看这里，它由 isRealVideoAd()（仅 .ad-showing）单独驱动。
  function computeAdState() {
    const p = document.querySelector('#movie_player, .html5-video-player');
    const hasAdClass = (p && p.classList && p.classList.contains('ad-showing'))
      || !!document.querySelector('.ad-showing');

    // 1) 可见广告覆盖层
    for (const sel of AD_OVERLAY_SELECTORS) {
      let el = null;
      try { el = document.querySelector(sel); } catch (_) { el = null; }
      if (el && isVisible(el)) return true;
    }

    // 2) 无 ad-showing：只认覆盖层
    if (!hasAdClass) return false;

    // 3) 有 ad-showing，但时长超出广告量级、又证明不了它不是正片（mainDur 未知）：
    //    要求存在可见跳过目标，否则判残留。
    //    v1.4.1：**已证明不是正片**的超长广告（notMainClip）直接信任。现场那支
    //    3225s 的广告就是在这里被"时长 > 300s = 正片量级"误判成残留的。
    const video = currentVideo();
    const dur = video && video.duration;
    if (isFinite(dur) && dur > AD_MAX_DURATION && !notMainClip(dur)) {
      for (const sel of SKIP_SELECTORS) {
        for (const el of queryAllSafe(sel)) {
          if (isTargetVisible(el)) return true;
        }
      }
      return false;
    }

    // 4) 短广告 / 时长未知：信任 ad-showing
    return true;
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

  // v1.4.0：强跳窗口信号。
  // 事故（v1.3.9 现场，30 分钟日志）：`adPlaying= true`+`strong= true` 连续持续 970 秒，
  // 期间一行强跳日志都没有 —— 因为窗口被收成"只看 .ad-showing"，而当时
  // `.ad-showing= false`、广告覆盖层却明明可见。用户看到的就是"广告在播，扩展不动手"。
  // 现在的口径：
  //   a) `.ad-showing` → 开窗（最硬的信号；此时媒体可能还没换源，dur 仍是正片，不能挡）
  //   b) 可见广告覆盖层 **且** 时长不是正片（短广告，或已证明 ≠ mainDur 的长广告）→ 开窗
  // 覆盖层残留 + 正片在播不开窗：那里本来也没有可跳的东西，开窗只会换来
  // 每 40 秒一行"未动进度"和永不结束的广告态。
  function adWindowSignal() {
    if (isRealVideoAd()) return true;
    // v1.4.2：广告覆盖层可见（strong 为真）+ 时长已证明不是正片 → 开窗。
    // 现场那 16 分钟全程没有 .ad-showing，只有这条能把它认出来。
    if (adPlayingOtherMedia()) return true;
    const dur = mediaDur();
    // v1.4.1：长广告（已证明不是正片）同样开窗 —— 否则覆盖层广告只要超过 5 分钟，
    // 窗口就永远不开，用户看到的就是"广告在播、扩展一次都没动手"。
    if (!isFinite(dur) || (dur > AD_MAX_DURATION && !notMainClip(dur))) return false;
    for (const sel of AD_FRAME_SELECTORS) {
      let el = null;
      try { el = document.querySelector(sel); } catch (_) { el = null; }
      if (el && isVisible(el)) return true;
    }
    return false;
  }

  // v1.4.0：没有 .ad-showing 时的"覆盖层广告"准入（给破坏性的强跳用）。
  // 为什么不能直接放开 [S2]：覆盖层信号在正片里也可能可见（#player-ads 常驻、
  // 跳过按钮会留 86x36 的空壳）。所以这里多加两个约束：
  //   a) 只认"广告创意层"选择器（AD_FRAME_SELECTORS），不含 #player-ads / 跳过按钮壳
  //   b) 时长不能是正片：短广告（≤ AD_MAX_DURATION）直接放行；长广告必须已证明
  //      ≠ mainDur（notMainClip）——v1.4.1 现场那支广告自己就有 3225 秒
  // 于是"覆盖层可见但正片在播"依然动不了进度——S2 的本意完整保留。
  function overlayOnlyAd() {
    const dur = mediaDur();
    if (!isFinite(dur) || (dur > AD_MAX_DURATION && !notMainClip(dur))) return false;
    for (const sel of AD_FRAME_SELECTORS) {
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
  // v1.4.1：AD_MAX_DURATION 从"是不是正片"的判据降级为 **mainDur 未知时的保守兜底**。
  // 现场那支广告自己就有 3225 秒（用户看了 16 分钟），拿 300 秒当界线必然误杀。
  // 现在能不能跳由 mainClipLike / notMainClip（对比正片时长）决定。
  const AD_MAX_DURATION = 300;   // mainDur 未知时"敢推"的最大时长（没有参照就别冒险）
  const AD_SKIP_MIN_WAIT = 200;    // 广告标记出现后至少等这么久再动手（等播放器把 video 挂上）
  const AD_SKIP_CONFIRM_MS = 800;  // 无法证明"不是正片"时（mainDur 未知）必须等满的确认窗口
  const VIDEO_SKIP_GAP = 900;    // 同一 video 元素最小间隔
  const END_STALL_MS = 3000;     // 贴到结尾却迟迟不结束时，多久后改用加速
  // v1.4.9：贴尾不再推到 `dur - 0.05`，而是留 TAIL_LEAD 秒。
  // 现场（v1.4.8 日志）强跳本身是成功的（ct 精确到 dur），但元素停在"结尾前一瞬"
  // 从不触发原生 ended，播放器只能自己 pause，然后靠 ad module 的计时器慢慢换流 ——
  // 两支广告因此白占 30 秒。留一点媒体让它真的走完，ended 才有机会发出来。
  const TAIL_LEAD = 0.6;         // 贴尾时预留的播放余量（秒）
  const TAIL_END_EPS = 0.25;     // 距片尾小于这个值就认为"已经到结尾，再加速没有意义"
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
  // v1.4.9：贴尾后到底有没有发出原生 ended —— 这一条决定"等这么久"该怪谁。
  // 装了监听不代表会打日志：只有贴尾后真的收到 ended 才记一行，广告期间限一次。
  const endedHooked = new WeakSet();    // 已经挂过 ended 监听的 video 元素
  let endedSeenAt = 0;                  // 本次广告内收到 ended 的时间戳（0 = 没收到）
  let endedLogged = 0;                  // 上面那条日志每支只打一次

  // v1.4.9：给 video 挂一次 ended 监听，只为记录事实（不驱动任何动作）。
  // 现场最需要分清的两件事：元素到底有没有"播到结尾"，以及 YouTube 收到之后
  // 花了多久才换流。前者只能靠 ended 证明，靠 ct 猜是猜不出来的。
  function hookEnded(v) {
    if (!v || endedHooked.has(v)) return;
    endedHooked.add(v);
    try {
      v.addEventListener('ended', () => {
        if (!adStateStrong()) return;      // 正片播完也会 ended，与广告无关
        const at = Date.now();
        endedSeenAt = at;
        if (endedLogged !== adScopedSeq) {
          endedLogged = adScopedSeq;
          dlog('✅ 广告收到原生 ended（贴尾后',
            lastVideoSkip ? (at - lastVideoSkip) + 'ms' : '—', '）');
        }
      });
    } catch (_) { /* ignore */ }
  }

  // v1.4.9：贴到尾之后我们已经无事可做，等的是 YouTube 换流。把这层等待连同它的
  // 成因写进日志（每支一条）：ended 收到=是 → 元素确实播完了，慢在 ad module；
  // ended 收到=否 → 元素没播到结尾，问题在 seek 落点（TAIL_LEAD 要调）。
  function noteTailWait(now) {
    if (tailWaitLogged === adScopedSeq) return;
    if (!lastVideoSkip || now - lastVideoSkip < 2000) return;
    const v = currentVideo();
    const ct = v && isFinite(v.currentTime) ? v.currentTime : NaN;
    const dur = v && isFinite(v.duration) ? v.duration : NaN;
    tailWaitLogged = adScopedSeq;
    dlog('🕓 贴尾等待换流：ct=', Math.round(ct * 10) / 10, '/ dur=', Math.round(dur * 10) / 10,
      '| 已等', now - lastVideoSkip, 'ms | ended 收到=', endedSeenAt > 0);
  }

  // ---- v1.3.5：广告耗时归因 ----
  // 现场日志（v1.3.4）里"广告开始 → 广告结束"整整 18.2 秒，但里面只有 1.8 秒
  // 是真的在播广告，其余全是 readyState=0 的等待。这三个量把等待拆开，
  // 下次贴日志只要看 📊 那一行就知道时间到底花在我们身上还是播放器身上。
  let adFirstActionAt = 0;    // 本次广告内第一次真的动手（跳/加速/催流）的时间
  let adJumpCount = 0;        // 本次广告内成功强跳的次数（pod 会 >1）
  let adMediaWaitMs = 0;      // 本次广告内 video 处于 readyState<1 的累计时长（估算）
  // v1.4.8：上面那个数把两件完全不同的事算在了一起 ——
  //   ① 广告刚换上、媒体还没挂上（我们只能等）
  //   ② 我们已经把这一支推到结尾、播放器在换下一支的流（同样只能等，但成因不同）
  // 混在一起时现场只能看到"媒体未就绪占 86%"，既不像 bug 也不像成本。
  // 现在单独记 ②，📊 那一行直接拆成"等首支"和"等切流"两个数。
  let adCutoverWaitMs = 0;    // 其中"已贴尾、在等播放器换流"的那部分
  let adMediaSampleAt = 0;    // 上面两个累计量的采样基准
  let adMediaReadyDur = 0;    // 已经播报过"媒体就绪"的那支广告的时长（用于去重）
  let nudgeTimes = new WeakMap();       // video -> { n, t } 催流记录（按广告重置）
  const MEDIA_NUDGE_MAX = 3;            // 同一支广告最多催几次
  const MEDIA_NUDGE_GAP = 1200;         // 两次催流的最小间隔
  // 贴尾后多久内仍认为"这支还是我们推完的那支"。现场切流实测 8~10 秒，
  // 留 12 秒够用；再久就说明已经进了别的状态，别拿旧结论当真。
  const TAIL_HOLD_MS = 12000;

  // ---- v1.3.8：点击熔断与计数窗口 ----
  // 现场事故（v1.3.7）：广告态持续了 589 秒，期间我们每 4.2 秒点一次那个
  // "看得见但点了没用"的跳过按钮，一共点了 140 次，还把 500 行日志缓冲整个刷满，
  // 连"广告开始"那几行都被挤掉了。按钮无效时继续点没有任何收益，必须熔断。
  const CLICK_BUDGET = 4;               // 同一支广告最多点几次（用完后停手，等广告自己结束/换支）
  const AD_END_COUNT_WINDOW = 5000;     // 结束前多久内动过手才算"我们跳掉的"（防计数虚高）
  let clickBudget = CLICK_BUDGET;       // 剩余可点击次数（每次广告/换支重置）
  let clickBudgetWarned = false;        // "熔断"那条日志只打一次
  let tailSkipLogged = 0;               // "已贴尾，不点按钮"那条日志每支只打一次（v1.4.8）
  let tailWaitLogged = 0;               // "贴尾等待换流"那条日志每支只打一次（v1.4.9）
  let adLastActionAt = 0;               // 本次广告内最后一次真的动手的时间
  let durTooLongLogged = 0;             // 已经解释过"时长超过 AD_MAX_DURATION"的那个时长

  // ---- v1.4.0：残留看门狗 ----
  // 现场（v1.3.9）：广告结束后 .ad-showing 残留、媒体变成 3225s 的正片，跳过按钮还是
  // 86x36 的可见空壳。旧判定把它当真广告，点满 4 次熔断后每 4 秒刷一行"冷却/排队中"，
  // 📊 广告结束永不触发，一挂就是 700 秒。这里给"窗口开着但媒体是正片量级"设个上限。
  const AD_RESIDUAL_EXIT_MS = 8000;     // 连续这么久都只有正片量级时长 → 判残留
  // v1.4.4：没有正片参照时的安全阀。8 秒就退出会把真广告判成残留（现场 1086.5s 那支
  // 13.7 秒就被退出），所以这里只防止"跨支无限挂着"，时间给足。
  const AD_UNKNOWN_EXIT_MS = 120000;
  const AD_RESIDUAL_QUIET_MS = 60000;   // 判残留后的静默期（真广告来了会提前解除，见 tick）
  let residualSince = 0;                // 本轮"疑似残留"的起始时间（0 = 当前不怀疑）
  let residualQuietUntil = 0;           // 静默到这个时间为止（期间不再因同一个残留 UI 进广告态）

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

  // 当前媒体的时长（拿不到 NaN）。"是不是广告量级"是 v1.4.0 的核心判据，
  // 单独包一层免得各处重复读 currentVideo + 判 isFinite。
  function mediaDur() {
    const v = currentVideo();
    return v && isFinite(v.duration) && v.duration > 0 ? v.duration : NaN;
  }

  // ---- v1.4.1：靠"和正片时长比"判断这个 media 到底是不是正片 ----
  // 教训（现场）：那支广告自己是 3225 秒，用户看了 16 分钟。用"300 秒"这种绝对
  // 分界线去猜，必然把长广告全判成正片，而且判错了还自我说服"多半是残留"。
  // 真正可靠的参照是 mainDur（非广告态观察到的正片时长）：
  //   mainClipLike(d) → 这就是正片，绝不能碰（把正片推到结尾是不可逆的）
  //   notMainClip(d)  → 已证明不是正片（时长差得很远），多长都可以跳
  // mainDur 还是 0（打开链接就先播广告）时两者都 false —— 没有参照就别动进度。
  const MAIN_DUR_TOLERANCE = 2;   // 秒。正片时长有小数/取整差异，留 2s 余量
  const MAIN_DUR_RETRY_MS = 3000; // v1.4.5：读不到正片参照时的重试间隔（miss 不缓存）
  // v1.4.7：允许说"拿不到参照"之前的宽限期。桥（inj.js）是异步的，问出去到答复
  // 回来要一两百毫秒，而进广告那一 tick 紧接着就问了一次 —— 不设宽限期就会在
  // "答复正在路上"的时候宣布失败（现场真发生过，7ms 后参照就到了）。
  const REF_DIAG_GRACE_MS = 2500;
  function mainClipLike(d) {
    return mainDur > 0 && isFinite(d) && Math.abs(d - mainDur) <= MAIN_DUR_TOLERANCE;
  }
  function notMainClip(d) {
    return mainDur > 0 && isFinite(d) && Math.abs(d - mainDur) > MAIN_DUR_TOLERANCE;
  }

  // ---- v1.4.4：正片时长参照的第二来源（页面元数据）----
  // 现场（v1.4.3 日志，54 行）：
  //   +383128 新视频的预播广告开始（`yt-navigate-finish` 已把 mainDur 归零，这一步没错——
  //           确实换视频了），+386286 `mainDur= 未知`；
  //   +389163 广告媒体报 `dur= 1086.5`，没有参照 → 🚫 → 用户硬看 18 分钟。
  // 问题不在"清得对不对"，而在**清完没处再取**：预播广告跑在正片 metadata 之前，
  // `<video>.duration` 那时报的是广告时长，永远等不到正片参照。
  // watch 页的 <head> 里有 `<meta itemprop="duration" content="PT16M14.6S">`，
  // 它描述的是**正片**，广告在播时也读得到 —— 拿它当兜底，比"什么都不敢做"有用得多。
  function pageVideoId() {
    try {
      const u = new URL(location.href);
      const v = u.searchParams.get('v');
      if (v) return v;
      const m = /\/shorts\/([\w-]+)/.exec(u.pathname);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  function parseIsoDuration(s) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(s || '');
    if (!m) return NaN;
    const sec = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
    return sec > 0 ? sec : NaN;
  }

  let mainDurId = '';       // mainDur 是在哪个视频上测到的（换视频才作废）
  let metaDurId = null;     // 下面这份页面时长是在哪个视频上读的
  let metaDur = 0;
  let metaDurSrc = '';      // 读成功时用的哪个来源（写进日志，别让人再猜）
  let metaDurTryAt = 0;     // 上次尝试读取的时间（读不到也不许记成永久答案）

  // ---- v1.4.6：正片时长的第三个来源（页面世界中转，inj.js）----
  // 现场（v1.4.5 日志，53 行）：`dur= 未知` 持续 372 秒（页面加载了，但播放器还没
  // 初始化就进了预播广告），整段广告 `mainDur= 未知`，`🎯` 又是一行都没打出来。
  // 三版都栽在同一处：**在隔离世界里猜页面**。隔离世界看不到页面的 JS 全局
  // （ytInitialPlayerResponse）和元素上挂的方法（getPlayerResponse），
  // 内联脚本正则也啃不动那份几 MB 的文本。改成让 inj.js 在页面世界读、postMessage 回来。
  //
  // 关键设计：桥报的是**候选值 + 它的 videoId**，采用前必须与当前 URL 的 id 对上。
  // 播放器在播广告时可能报广告自己的 playerResponse（lengthSeconds 是广告时长），
  // 拿它当正片参照，结论正好反过来 —— 把广告当正片，一律不跳。
  const BRIDGE_TAG = 'ytas-bridge';
  const bridge = {
    ever: false, at: 0, urlId: '', playing: '', cands: [], api: false, injectErr: '',
  };
  let refAskedAt = 0;       // 最后一次"向桥要正片时长"的时间（决定 ❓ 能不能说出口）

  function installBridge() {
    try { window.addEventListener('message', onBridgeMsg, false); } catch (_) { /* ignore */ }
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('inj.js');
      s.async = false;
      s.addEventListener('load', () => { try { s.remove(); } catch (_) { /* ignore */ } });
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      bridge.injectErr = '注入失败(' + ((e && e.message) || e) + ')';
    }
  }

  function onBridgeMsg(e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__ytas !== BRIDGE_TAG || d.op !== 'push') return;
    bridge.ever = true;
    bridge.at = Date.now();
    bridge.urlId = d.urlId || '';
    bridge.playing = d.playing || '';
    bridge.cands = Array.isArray(d.cands) ? d.cands : [];
    bridge.api = !!d.playerApi;
    // 拿到指向当前视频的时长就立刻采用，不等 3s 退避：
    // 预播广告基本都在"播放器刚起来"那一两秒里，等一轮退避用户已经看掉半支广告。
    adoptBridgeDur('桥推送');
  }

  function askBridge() {
    refAskedAt = Date.now();
    try { window.postMessage({ __ytas: BRIDGE_TAG, op: 'get' }, '*'); } catch (_) { /* ignore */ }
  }

  // 只认 id 与当前 URL 一致的候选
  function bridgePick() {
    if (!bridge.ever) return null;
    const id = pageVideoId();
    if (!id) return null;
    for (let i = 0; i < bridge.cands.length; i++) {
      const c = bridge.cands[i];
      if (c && c.dur > 0 && c.id === id) return c;
    }
    return null;
  }

  // 桥的事实状态（写进日志，只陈述事实，不下结论）
  // v1.4.7：把"没有候选"和"候选不是这支视频"分开写。现场（v1.4.6 第一份日志）
  // 只有一句 `桥= 空值/0s前`，看不出是播放器没给数据，还是给了但 id 对不上 ——
  // 这两件事的修法完全不同。
  function bridgeState() {
    if (bridge.injectErr) return bridge.injectErr;
    if (!bridge.ever) return '无响应';
    const age = Math.round((Date.now() - bridge.at) / 1000) + 's前';
    if (!bridge.cands.length) {
      return (bridge.api ? '空值(getPlayerResponse没返回视频信息)' : '空值(无播放器API)') + '/' + age;
    }
    const list = bridge.cands.map((c) => c.id + '=' + Math.round(c.dur * 10) / 10 + 's').join(',');
    return (bridgePick() ? '' : 'id不符(') + list + (bridgePick() ? '' : ')') + '/' + age;
  }

  // 用桥上报的值补 mainDur（只在 mainDur 还空着时；跳一支广告不改变正片时长，
  // 所以这里不做"跳成功就作废"，作废只由换视频负责）
  function adoptBridgeDur(reason) {
    if (mainDur > 0) return false;
    const c = bridgePick();
    if (!c) return false;
    mainDur = c.dur;
    mainDurId = pageVideoId();
    metaDur = c.dur;
    metaDurSrc = '桥:' + c.src;
    metaDurId = mainDurId;
    dlog('🎯 正片时长参照取自页面桥（来源=', c.src, '｜', reason, '）：mainDur=',
      Math.round(c.dur * 10) / 10, 's（广告在播时也读得到）');
    return true;
  }

  // 来源 1：`<meta itemprop="duration" content="PT16M14.6S">`（ISO 8601）
  function durFromMeta() {
    try {
      const el = document.querySelector('meta[itemprop="duration"]');
      return el ? parseIsoDuration(el.getAttribute('content')) : NaN;
    } catch (_) { return NaN; }
  }

  // 来源 2：页面内联脚本里的 ytInitialPlayerResponse.videoDetails。
  // 现场（v1.4.4 日志，68 行）证明来源 1 靠不住：预播广告进广告那一刻页面里根本没有
  // 那行 meta，`🎯` 一次都没打出来 —— 兜底等于没写。
  // playerResponse 首屏 HTML 就带着，但它描述的是**首屏那支视频**（SPA 换视频后还留着
  // 旧的），所以必须用 videoId 校验归属，不符就当没读到。
  // v1.4.6：改成返回 {dur, state}，读不到时把**原因**带回去写进日志 ——
  // "没有这行脚本"和"脚本在但 id 不符"是两件完全不同的事，以前一律 NaN，只能靠猜。
  function inlineRes() {
    const id = pageVideoId();
    if (!id || !/^[\w-]+$/.test(id)) return { dur: NaN, state: '无页面id' };
    let seen = 0;
    let mismatch = '';
    try {
      const scripts = document.scripts || [];
      const re = new RegExp('"videoDetails":\\{"videoId":"([\\w-]+)"[^{}]{0,400}?"lengthSeconds":"(\\d+)"');
      for (let i = 0; i < scripts.length; i++) {
        const s = scripts[i];
        if (s.src) continue;
        const text = s.textContent;
        if (!text || text.indexOf('"lengthSeconds"') < 0) continue;
        seen++;
        const m = re.exec(text);
        if (!m) continue;
        if (m[1] === id) return { dur: +m[2], state: '有' };
        mismatch = mismatch || m[1];
      }
    } catch (_) { /* ignore */ }
    if (mismatch) return { dur: NaN, state: 'id不符(' + mismatch + ')' };
    return { dur: NaN, state: seen ? '有脚本但没匹配到' : '无脚本' };
  }

  function durFromPlayerResponse() { return inlineRes().dur; }

  // "拿不到参照"这类事实每个视频只打一条 —— 现场最怕的就是一行废话刷满 500 行缓冲。
  // v1.4.7：但**不能进广告那一刻就打**。桥是异步的，现场（v1.4.6 第二份日志）就是这样：
  //   +190951 ❓ 拿不到正片时长参照：… | 桥= 空值/1s前 | meta= 无 | 内联= 无脚本
  //   +190958 🎯 正片时长参照取自页面桥（来源= player.getPlayerResponse）：mainDur= 303 s
  // 7 毫秒后参照就到位了。这条"每个视频只说一次"的故障报告，说的是一件并不存在的事，
  // 比没有日志更糟 —— 它会让人去修一个已经好了的东西。所以给它一个宽限期：
  // 桥问出去 REF_DIAG_GRACE_MS 之后仍然全空，才允许说"拿不到"。
  let refDiagId = '';
  function logRefMissing() {
    const id = pageVideoId();
    if (refDiagId === id) return;
    if (refAskedAt && Date.now() - refAskedAt < REF_DIAG_GRACE_MS) return;
    refDiagId = id;
    let inl = { state: '?' };
    try { inl = inlineRes(); } catch (_) { /* ignore */ }
    dlog('❓ 拿不到正片时长参照：页面id=', id || '无',
      '| 桥=', bridgeState(),
      '| meta=', durFromMeta() > 0 ? '有' : '无',
      '| 内联=', inl.state,
      '| 这条每个视频只说一次');
  }

  // 拿页面上的正片时长（读不到 NaN）。只在"视频 id 与当前 URL 一致"时采用，
  // 否则换视频的瞬间可能读到上一支的时长，反过来把新正片判成广告。
  // v1.4.5：读不到**不能**记成这个 id 的永久答案 —— 预播广告时页面 metadata 常常
  // 还没渲染，一次 miss 被记住，后面这支视频的所有广告就都拿不到参照了。
  // 改成 miss 只按 MAIN_DUR_RETRY_MS 退避重试（成功才固定下来）。
  // v1.4.6：来源顺序改为 桥 → meta → 内联。桥是唯一"读到的是页面世界里活对象"的
  // 来源，也是唯一在 SPA 换视频后仍然最新的来源。
  function mainDurFromPage(force) {
    const id = pageVideoId();
    if (!id) return NaN;
    if (metaDurId === id && metaDur > 0) return metaDur;
    const now = Date.now();
    if (!force && metaDurId === id && now - metaDurTryAt < MAIN_DUR_RETRY_MS) return NaN;
    metaDurTryAt = now;
    metaDurId = id;
    const bc = bridgePick();
    let d = bc ? bc.dur : NaN;
    let src = bc ? ('桥:' + bc.src) : '';
    if (!(d > 0)) { d = durFromMeta(); src = 'meta'; }
    if (!(d > 0)) { d = durFromPlayerResponse(); src = '内联playerResponse'; }
    if (d > 0) { metaDur = d; metaDurSrc = src; return d; }
    metaDur = 0;
    metaDurSrc = '';
    logRefMissing();
    return NaN;
  }

  // 参照缺失时补一次。进广告那一刻调一次，之后"无参照的长媒体"每个 tick 再调（内部节流）。
  // 拿到就以它为准：与 <video> 报的时长一致 → 判正片（不动），不一致 → 才敢跳。
  function adoptMainDurFromPage(reason) {
    if (mainDur > 0) return false;
    const md = mainDurFromPage();
    if (!(md > 0)) return false;
    mainDur = md;
    mainDurId = pageVideoId();
    dlog('🎯 正片时长参照取自页面（来源=', metaDurSrc, '｜', reason, '）：mainDur=',
      Math.round(md * 10) / 10, 's（<video> 此刻报的是广告时长）');
    return true;
  }

  // ---- v1.4.2：没有 .ad-showing 的广告（现场就是这种）----
  // v1.3.9 日志里那 970 秒（16 分钟）：`adPlaying= true | .ad-showing= false | 命中数= 0`，
  // 心跳一直 strong= true —— 说明**有广告覆盖层可见**，可我们的强跳窗口只认
  // .ad-showing / 广告创意层，于是整段没开窗，用户看到的就是"广告在播、扩展不动手"。
  // 现在补一条：**YouTube 自己说广告在播**（isAdPlaying() 含 .ad-interrupting /
  // 可见广告覆盖层）+ **这个 media 已证明不是正片**（notMainClip）→ 就是广告。
  // 只加后半条不够、只加前半条更危险：单看 isAdPlaying 时 #player-ads 在正片里
  // 也常驻可见，必须用"时长不是正片"把正片挡在外面。
  function adPlayingOtherMedia() {
    return isAdPlaying() && notMainClip(mediaDur());
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
    if (isFinite(d) && d > 1 && !v.paused) { mainDur = d; mainDurId = pageVideoId(); }
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
    // 换支了：新的一支重新给足点击预算（pod 里上一支点完 8 次不代表下一支不用点）
    clickBudget = CLICK_BUDGET;
    clickBudgetWarned = false;
    tailSkipLogged = 0;
    tailWaitLogged = 0;
    endedSeenAt = 0;
    endedLogged = 0;
    durTooLongLogged = 0;
  }

  // ---- v1.4.8：识别"我们已经把这一支推到结尾，正在等播放器换流" ----
  // 现场（v1.4.7 日志）每支广告强跳后都会再点两次跳过按钮、催三次 play()，
  // 但那一刻 video 是 readyState=0 / duration=NaN —— 媒体已被摘掉，
  // 按钮连着的是上一支的旧 UI，点了不会发生任何事，还会吃掉 CLICK_BUDGET。
  // 返回值分三档，因为"有流停在结尾"和"流已经被摘掉"的处理不该一样：
  //   2 = 流已被摘（readyState=0 / duration 无效）：DOM 里那个按钮是旧 UI，绝不点
  //   1 = 有流但停在结尾：点它也只是"跳到结尾"，我们已经在那儿了，无收益
  //   0 = 与我们上一支无关，或早已过了切流窗口
  // 判据不认"猜"，只认三件事实：还是我们推的那个元素、时长仍是它、当前停在哪。
  function tailState(v, now) {
    if (!v || v !== jumpEl || !(jumpDur > 0)) return 0;
    if (!lastVideoSkip || now - lastVideoSkip > TAIL_HOLD_MS) return 0;
    if (v.readyState < 1) return 2;
    const dur = v.duration;
    const ct = v.currentTime;
    if (!isFinite(dur) || dur <= 0) return 2;
    return (isFinite(ct) && ct >= dur - 1.5) ? 1 : 0;
  }

  // ---- v1.3.5：广告耗时归因 ----
  function resetAdStats(now) {
    adFirstActionAt = 0;
    adJumpCount = 0;
    adMediaWaitMs = 0;
    adCutoverWaitMs = 0;
    adMediaSampleAt = now;
    adMediaReadyDur = 0;
  }

  function markAdAction(now) {
    if (!adFirstActionAt) adFirstActionAt = now;
    adLastActionAt = now;   // v1.3.8：广告结束时用它判断"到底是不是我们跳掉的"
  }

  // 每 tick 采样一次：广告期间 video 处于 readyState<1 的时长累加进来。
  // 这一段是"我们什么都做不了"的时间（广告媒体没加载 / 播放器在切流），
  // 和被 200ms 最小等待、冷却窗口挡掉的时间完全不是一回事，必须分开计时。
  function sampleAdMedia(now) {
    const v = currentVideo();
    if (!v) { adMediaSampleAt = now; return; }
    if (adMediaSampleAt && v.readyState < 1) {
      const dt = now - adMediaSampleAt;
      adMediaWaitMs += dt;
      // v1.4.8：其中"我们已经贴尾，在等播放器换下一支流"的部分单独记一笔，
      // 让 📊 那一行能区分"等首支"和"等切流"——两者都是等待，但只有后者
      // 反复出现才说明 pod 里支数多，跟我们的实现无关。
      if (tailState(v, now) > 0) adCutoverWaitMs += dt;
    }
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
    // v1.4.8：只有元素真的处于"暂停"才催。现场（v1.4.7 日志）三次催流全都在
    // paused=false 的情况下发出 —— 元素已经在"potentially playing, waiting for data"，
    // 浏览器本来就在取流，play() 是空操作；三次之后媒体照样 readyState=0 持续 8.5 秒。
    // 唯一有意义的情形是"贴尾后播放器把自己暂停了且没有流"，那才是 play() 能拉起来的。
    if (!v.paused) return false;
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
    // [S2] 破坏性操作：默认只认最硬的 .ad-showing；"只有覆盖层"的广告（新版 UI 不挂类名）
    // 走受限准入 overlayOnlyAd()——广告创意层可见 + 时长不是正片，两条同时满足才动手。
    // v1.4.2：再加一条 adPlayingOtherMedia()（广告覆盖层可见 + 时长已证明 ≠ 正片），
    // 现场那 16 分钟就是没有 .ad-showing，前两条都进不去。
    if (!isRealVideoAd() && !overlayOnlyAd() && !adPlayingOtherMedia()) return false;

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
      if (!isFinite(dur) || dur <= 0) {
        why = why || ('dur=' + dur);
        continue;
      }
      // 时长与正片一致 → 这是正片，绝不碰（避免"跳到大结局"）
      if (mainClipLike(dur)) {
        why = why || '时长与正片一致';
        dlogReject('maindur', '⏩ 时长与正片一致（', Math.round(dur * 10) / 10, 's），判定为正片，不动进度');
        continue;
      }
      // v1.4.1：长度不再是硬门槛。**已证明不是正片**（时长 ≠ mainDur）就照跳 ——
      // 现场那支广告本身就是 3225 秒，旧规则一句"这个量级更像正片"把它拒了，
      // 结果用户看了 16 分钟广告，日志还把结论写成"多半是 ad-showing 残留"。
      // 只有 mainDur 未知（打开链接先播广告）时才保守放弃：那时没有任何参照，
      // 推错的代价是把正片推到大结局，不可逆——宁可漏跳这一支。
      // v1.4.5：无参照 + 媒体明显超广告量级 → 不要一句 🚫 就永久放弃。
      // 页面参照（meta / playerResponse）可能晚一点才可用，边播边等；拿到就以它为准。
      // 这份日志（v1.4.4）里 ads 都是 15~60s，走的是起播期 seek，所以无所谓；
      // 但上一份日志那支 1086.5s 的广告就卡在这里 —— 参照一晚到，用户就得多看 18 分钟。
      if (!(mainDur > 0) && dur > AD_MAX_DURATION) adoptMainDurFromPage('无参照，边播边等');
      if (dur > AD_MAX_DURATION && !notMainClip(dur)) {
        why = why || ('dur=' + dur);
        if (durTooLongLogged !== dur) {
          durTooLongLogged = dur;
          // 顺手记一下"到底有没有广告覆盖层"：现场排查时这两个信号要分开看
          const hasOverlay = AD_OVERLAY_SELECTORS.some((sel) => {
            const el = document.querySelector(sel);
            return el && isVisible(el);
          });
          dlog('🚫 广告态但媒体时长', Math.round(dur * 10) / 10, 's，且没有正片时长作参照'
            , '（mainDur=', Math.round(mainDur * 10) / 10, '），不参与强跳：推错就是把正片推到大结局，不可逆',
            '| 广告覆盖层=', hasOverlay, hasOverlay ? '（覆盖层在，更像真广告，但仍无参照）' : '（也没有覆盖层）',
            '| 参照来源=', metaDurSrc || '无（meta / playerResponse 都读不到）');
        }
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
        // v1.4.9：已经收到过原生 ended 就**别再续播**。按规范，对 ended 的元素调
        // play() 会从头重新播放 —— 那等于让用户把广告再看一遍。此刻唯一该做的是
        // 等 YouTube 换流（🕓 那行会记下等了多久）。
        if (endedSeenAt) { why = why || '贴尾且已 ended，等换流'; noteTailWait(now); continue; }
        const t2 = videoSkipTimes.get(v);
        if (t2 && now - t2 < VIDEO_SKIP_GAP) { why = why || '贴尾暂停（刚催过）'; continue; }
        videoSkipTimes.set(v, now);
        lastVideoSkip = now;
        try { v.currentTime = Math.max(0, dur - TAIL_LEAD); } catch (_) { /* ignore */ }
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
      // v1.4.9：只剩"到结尾还有媒体可走"这一种情况才值得加速。
      // 现场（v1.4.8 日志）两次 16× 都是在 ct == dur 之后开的 —— 元素已经在最后一帧，
      // 加速不改变任何时间，只把 playbackRate 改成一个更奇怪的值。
      const tailLeft = isFinite(dur) ? dur - ct : 0;
      const stuckAtEnd = atEnd && now - endStallSince >= END_STALL_MS && tailLeft > TAIL_END_EPS;

      // seek 连续 2 次被忽略，或贴尾后等不到 ended → 改用 16× 加速，广告同样会迅速播完
      if (seekFails >= 2 || stuckAtEnd) {
        // v1.4.7：已经加速过就**不要再喊一遍**。现场（v1.4.6 第一份日志）那支卡在结尾的
        // 广告把同一句 `⏩ 广告卡在结尾不放，改用 16× 加速播放（rate=16）` 打了 4 次
        // （+50340 / +51390 / +52450 / +53514）—— 它每次都被重新调用以维持跳转间隔，
        // 但速率早就是 16 了，重复的话只是占日志缓冲。
        const alreadyBoosted = v.playbackRate >= 8;
        // v1.4.9：不再写 videoSkipTimes —— 加速并没有改变播放位置，把它记成"刚跳过"
        // 会紧接着挡住下一条"贴尾暂停 → 续播"（现场 +5501826 的「刚催过」就是这么来的）。
        lastVideoSkip = now;
        try {
          if (!alreadyBoosted) {
            rateBoostPrev = v.playbackRate;   // 记住用户原本的速率，之后原样还回去
            v.playbackRate = 16;
          }
          rateBoostEl = v;
        } catch (_) { /* ignore */ }
        if (!alreadyBoosted) {
          dlog(stuckAtEnd
            ? '⏩ 广告卡在结尾不放，改用 16× 加速播放（rate=' + v.playbackRate + '）'
            : '⏩ seek 无效，改用 16× 加速播放广告（rate=' + v.playbackRate + '）');
        }
        epochActed = true;
        return true;
      }

      // 正常贴尾：交给播放器自己发 ended，不要反复 seek
      if (atEnd) {
        noteTailWait(now);
        continue;
      }

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
        jumpTarget = Math.max(0, dur - TAIL_LEAD);
        jumpEl = v;
        jumpDur = dur;
        jumpProvisional = early;
        if (early) earlySeeks += 1;
        hookEnded(v);                 // v1.4.9：记录"元素到底有没有播到结尾"
        v.currentTime = jumpTarget;
        // v1.4.9：贴尾后**必须确保它在放**。停在 `dur - TAIL_LEAD` 的暂停元素永远不会
        // 走到结尾、永远不会发 ended；现场那 5 秒空等就是这么来的（paused=true 一直
        // 挂到 ad module 自己超时）。这里不节流，因为我们刚刚亲手移动了它。
        if (v.paused) {
          try {
            const p = v.play();
            if (p && typeof p.catch === 'function') p.catch(() => { /* 预期内 */ });
          } catch (_) { /* ignore */ }
        }
        adJumpCount += 1;
        markAdAction(now);
        // v1.4.1：长广告动手了就留痕。这一行是"300s 判正片"被推翻的直接证据，
        // 下次再看日志，一眼能分清"跳了长广告"和"没敢跳"。
        if (dur > AD_MAX_DURATION) {
          dlog('⏩ 长广告强跳：duration=', Math.round(dur * 10) / 10, 's ≠ 正片',
            Math.round(mainDur * 10) / 10, 's，判定为广告（长度不再是拒绝理由）');
        }
        // v1.4.3（回退 v1.4.2 的这一行）：跳完一支广告**不能**把 mainDur 作废。
        // 现场（v1.4.2 日志）：+363689 跳掉 15s 那支 → mainDur 被清零 → 5 秒后
        // ad 3 换上一支 dur=3225 的媒体时已经没有参照，只能 🚫 放弃、硬看广告。
        // 跳一支广告并不会改变正片时长；作废等于"跳一次就瞎一次"，pod 里第二支
        // 长广告必然漏跳。真正会让参照失效的只有"换视频"，那由 yt-navigate-finish
        // 处理（见 navHandler），不该由"跳成功"兼职。
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
    // v1.4.3：窗口没开就说明"没有可跳的广告"。adStateStrong 会被常驻覆盖层
    // （#player-ads 在正片里也可见）撑成 true，此时盲目点按钮只会白烧点击预算。
    // 注意这里**不**按"🧹 判过残留"一刀切：没有正片参照时，点跳过按钮是唯一
    // 还剩下的手段（不依赖 mainDur），而重复点击已经由 CLICK_BUDGET 兜住。
    if (!adWindowSignal()) return null;

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
  let lastUiAt = 0;       // v1.3.9：最后一次看到"可见广告 UI"的时间（统计剔除残留段用）
  let epochActed = false; // 本次广告内是否真的执行过跳过动作（用于准确计数）

  // 调试心跳：节奏按"真正的动作门控 strong(adStateStrong)"决定——
  // 广告结束/空闲态（strong=false）每 15s 一次，仅可动手的广告态才 3s 一次。
  // 之前用宽松的 adPlaying 决定节奏：广告结束后 .ad-interrupting / 残留覆盖层
  // 仍让 adPlaying=true，导致按 3s 持续刷屏（实际并不会动作，纯噪音）。
  // v1.3.8：minGap 用于"有跳过按钮时也要打心跳"的场景——那个分支以前完全不打，
  // 于是现场那 10 分钟的卡死期里连一条状态行都没有，只能从点击日志反推。
  // v1.4.5：`strong= true` 到底是哪个元素撑起来的？
  // 现场（v1.4.4 日志）有连续 322 秒 `strong= true | adPlaying= true | .ad-showing= false`，
  // 猜是 `#player-ads` 常驻横幅，但日志里没有证据 —— 那就把它写成事实字段。
  function overlaySel() {
    const hits = [];
    for (const sel of AD_OVERLAY_SELECTORS) {
      let el = null;
      try { el = document.querySelector(sel); } catch (_) { el = null; }
      if (el && isVisible(el)) {
        hits.push(sel);
        if (hits.length >= 3) break;
      }
    }
    return hits.length ? hits.join(',') : '无';
  }

  // v1.4.6：现场日志里 `playerCls` 被截断在 80 字符，`ad-interrupting` 正好被切掉，
  // 于是 "strong=true | .ad-showing=false | 覆盖层=无 到底靠什么撑起来" 又变成猜。
  // 只打和广告有关的那几个类名：长度可控，事实不丢。
  function playerClassFacts(player) {
    if (!player || !player.classList) return '无';
    const all = player.classList;
    const hits = [];
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      if (c === 'ad-showing' || c === 'ad-interrupting' || c.indexOf('ytp-ad') === 0) hits.push(c);
    }
    return (hits.length ? hits.join(',') : '无广告类') + '(共' + all.length + ')';
  }

  function emitDebugBeat(minGap) {
    const adShowing = !!document.querySelector('.ad-showing');
    const adPlaying = isAdPlaying();
    const strong = adStateStrong();            // 是否真的会动播放器
    const hitCount = SKIP_SELECTORS.reduce((n, s) => n + queryAllSafe(s).length, 0);
    const sig = (strong ? 1 : 0) + '|' + (adPlaying ? 1 : 0) + '|' + (adShowing ? 1 : 0) + '|' + hitCount;
    const now = Date.now();
    // v1.4.0：3 秒档只留给"可能真的会动手"的状态（有按钮，或媒体是广告量级）。
    // 残留态 strong 也可能是 true（覆盖层 / 空壳按钮可见），按 3s 打就是纯噪音 ——
    // 上一版现场 286 行日志里绝大多数都是这种重复心跳。
    const dNow = mediaDur();
    // v1.4.3：心跳只报"我们是这么判的"不够，必须把判据本身写出来。现场那份日志里
    // 有整整 321 秒 `strong=true | .ad-showing=false | 命中数=0`，光看这几项根本
    // 判不出"是广告在播"还是"正片 + #player-ads 常驻横幅"。补上 dur / ct /
    // mainDur / 窗口 四个事实，下次不用再猜（也避免日志替人下结论，见 v1.3.9 教训）。
    const vNow = currentVideo();
    const ctNow = vNow && isFinite(vNow.currentTime) ? Math.round(vNow.currentTime * 10) / 10 : NaN;
    const winNow = adWindowSignal();
    // v1.4.1：长广告也算"会动手"（现在长度不再是拒绝理由），否则 16 分钟里
    // 全是 15s 一行的稀疏心跳，反而看不出它还在盯。
    const canAct = strong && (hitCount > 0 || !mainClipLike(dNow));
    const interval = Math.max(minGap || 0, canAct ? 3000 : 15000);
    if (sig !== lastBeatSig || now - lastDebugBeat > interval) {
      lastBeatSig = sig;
      lastDebugBeat = now;
      const player = document.querySelector('#movie_player, .html5-video-player');
      dlog('🔎 调试心跳：strong=', strong, '| adPlaying=', adPlaying,
        '| .ad-showing=', adShowing,
        '| 窗口=', winNow,
        '| 覆盖层=', overlaySel(),
        '| 玩家类=', playerClassFacts(player),
        '| dur=', isFinite(dNow) ? Math.round(dNow * 10) / 10 : '未知',
        '| ct=', isFinite(ctNow) ? ctNow : '未知',
        '| mainDur=', mainDur > 0 ? Math.round(mainDur * 10) / 10 : '未知',
        '| 选择器命中数=', hitCount);
    }
  }

  // v1.4.0：判定"广告态残留"并退出等待。
  // 和正常结束的区别：不打 📊（那会把一段正片时长记成广告时长）、不计数，
  // 并且静默一段时间——否则同一个残留 UI 每 tick 都会把我们重新拉进广告态。
  function exitResidual(reason) {
    const startedAt = adStateSince;
    const uiAt = (lastUiAt && lastUiAt > startedAt) ? lastUiAt - startedAt : 0;
    adStateSince = 0;
    residualSince = 0;
    residualQuietUntil = Date.now() + AD_RESIDUAL_QUIET_MS;
    adEndGuardUntil = Date.now() + 1500;
    seekFails = 0;
    jumpTarget = 0;
    jumpEl = null;
    jumpDur = 0;
    endStallSince = 0;
    releaseRateBoost();                     // 万一刚开过 16× 加速，这里要还回去
    lastVskipWhy = '';
    epochActed = false;
    const d = mediaDur();
    dlog('🧹 判定为广告态残留（' + reason + '）：退出等待，本段不计数',
      '| 广告态持续', Date.now() - startedAt, 'ms',
      '| 最后看到广告 UI 于', uiAt ? '+' + uiAt + 'ms' : '（全程没看到）',
      '| dur=', Math.round(d * 10) / 10,
      '| mainDur=', Math.round(mainDur * 10) / 10,
      '| 已点击', CLICK_BUDGET - clickBudget, '次');
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
    // v1.4.0：窗口信号放宽为「.ad-showing 或 可见广告覆盖层（且媒体是广告量级）」。
    // v1.3.9 把它收成只看 .ad-showing 之后，覆盖层可见却没挂类名的广告整段不动手。
    const winSig = adWindowSignal();
    if (residualQuietUntil) {
      // 静默解除：广告 UI 消失（残留没了），或 现在这段 media 看起来确实是广告
      // （短广告，或已证明 ≠ 正片的长广告）。
      // v1.4.1：不能用"不等于正片"当条件——mainDur 未知时它恒为真，静默会被
      // 立刻解除，于是每 8 秒重进一次广告态、点击预算被反复重置（测试 AB 现场：
      // 20 秒点了 7 次、熔断日志都没了）。
      const d = mediaDur();
      const adLike = !isFinite(d) || d <= AD_MAX_DURATION || notMainClip(d);
      if (!winSig || adLike) residualQuietUntil = 0;
    }
    if (winSig && !residualQuietUntil) {
      if (!adStateSince) {
        adStateSince = Date.now();
        residualSince = 0;
        adEpoch += 1;
        epochActed = false;
        lastUiAt = 0;          // v1.3.9：新广告，UI 时间重新记
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
        // v1.4.4：预播广告跑在正片 metadata 之前，<video> 那时只会报广告时长。
        // 进广告这一刻先拿页面元数据补一次参照（拿不到就算了，别编）。
        // v1.4.5：拿不到也不再"就算了"——后面每个 tick 会重试（见 forceSkipAdViaVideo）。
        // v1.4.6：先向桥要一次最新的（页面世界里的 playerResponse 才是 SPA 之后那份），
        // 再走本地来源。桥是异步的，答复到了会在 onBridgeMsg 里立刻采用。
        askBridge();
        if (!(mainDur > 0)) adoptMainDurFromPage('进广告时');
        dlog('📺 检测到广告开始（第', adEpoch, '次）');
      } else {
        // v1.4.0 残留看门狗：窗口开着，可媒体一直是正片 —— forceSkip 反正也不会动
        // （mainClipLike / 无参照 两条会拒），多半是 .ad-showing / 覆盖层的残留。
        // v1.4.1：判据从"时长 > 300s"改成"这就是正片"。
        //   a) mainDur 已知且 |d - mainDur| ≤ 容差 → 正片无疑，判残留
        //   b) mainDur 未知但时长超广告量级 → 没有参照、反正也不会动手，别一直挂着
        // v1.4.4：**b 的 8 秒太急，已改成安全阀**。现场（v1.4.3 日志）那支 1086.5s 的
        // 真广告就在 13.7 秒被 🧹 判成残留退出（`ct` 5.4 → 20.4 明明还在正常推进），
        // 广告还在播、我们却已经放弃。没有参照时只留 AD_UNKNOWN_EXIT_MS 这个长阀。
        // 长广告（已证明 ≠ mainDur）不在此列：旧规则会把它当残留退出，于是
        // "广告在播、我们却已经放弃"，比不退出更糟（现场 16 分钟就是这么来的）。
        const d = mediaDur();
        if (mainClipLike(d)) {
          if (!residualSince) residualSince = Date.now();
          else if (Date.now() - residualSince >= AD_RESIDUAL_EXIT_MS) {
            exitResidual('媒体时长与正片一致');
          }
        } else if (!(mainDur > 0) && isFinite(d) && d > AD_MAX_DURATION) {
          if (!residualSince) residualSince = Date.now();
          else if (Date.now() - residualSince >= AD_UNKNOWN_EXIT_MS) {
            exitResidual('时长超广告量级且始终没有正片时长作参照（安全阀）');
          }
        } else {
          residualSince = 0;
        }
      }
    } else {
      if (adStateSince) {
        const adStartedAt = adStateSince;      // 汇总要用，先存下来
        adStateSince = 0;
        residualSince = 0;
        adEndGuardUntil = Date.now() + 1500;   // 广告结束后的保护窗口
        seekFails = 0;
        jumpTarget = 0;
        jumpEl = null;
        jumpDur = 0;
        endStallSince = 0;
        releaseRateBoost();                     // 把播放速度还原，别加速正片
        // v1.3.9：用"最后一次看到可见广告 UI 的时间"截止，剔除 .ad-showing 残留的正片段
        const uiEnd = (lastUiAt && lastUiAt > adStartedAt) ? lastUiAt : Date.now();
        const total = Math.max(1, uiEnd - adStartedAt);
        // v1.3.5：一行交代"这次广告的时间去哪了"。现场日志里 18.2 秒只有 1.8 秒
        // 在真的播广告，其余全是 readyState=0 的等待——但那是靠人工数出来的，
        // 现在直接打印，下次判断"该不该继续优化"不用再猜。
        // v1.4.8：媒体等待拆成两段。现场 v1.4.7 的"占 86%"里，1.2 秒是真在等第一支
        // 挂载，其余全是强跳后播放器换下一支流的 8~10 秒 —— 后者跟支数成正比，
        // 不是实现问题。混在一起看，这个指标就没法用来判断"还该不该优化"。
        const firstWait = Math.max(0, adMediaWaitMs - adCutoverWaitMs);
        dlog('📊 广告结束：总', total, 'ms',
          '| 首次动手', adFirstActionAt ? (adFirstActionAt - adStartedAt) + 'ms' : '（全程未动手）',
          '| 强跳', adJumpCount, '次',
          '| 媒体未就绪累计 ' + adMediaWaitMs + 'ms',
          adMediaWaitMs
            ? '（等首支 ' + firstWait + 'ms / 贴尾后等切流 ' + adCutoverWaitMs + 'ms，占 '
              + Math.round(adMediaWaitMs / total * 100) + '%）'
            : '');
        lastVskipWhy = '';
        // v1.3.8：只在"广告真的结束 + 结束前不久我们动过手"时计数。
        // 以前只判"期间动过手"，于是那支 589 秒的广告（点了 140 次全无效、
        // 一路播到底）也被记成"自动跳过 1 次"，计数纯属虚高。
        if (epochActed && adLastActionAt && Date.now() - adLastActionAt <= AD_END_COUNT_WINDOW) {
          epochActed = false;
          bumpCount();
        } else {
          epochActed = false;
        }
      }
      recordMainDur();
    }

    // v1.3.9：记录"最后一次看到可见广告 UI"的时间。广告结束后 .ad-showing 可能残留，
    // 但广告 UI 会先消失；统计用这个时间截止，避免把残留正片的时长算进广告总时长。
    if (adStateSince && adStateStrong()) lastUiAt = Date.now();

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
    // v1.4.8：已经把它推到结尾、而且媒体已经被摘掉了，DOM 里那个按钮连的是**上一支**
    // 的旧 UI，点下去既无效又白吃 CLICK_BUDGET。现场 v1.4.7 日志里 4 次点击全部
    // 落在这个窗口（dur=NaN / readyState=0），第二支广告还没开始预算就用完了。
    const tailNow = skipBtn ? tailState(currentVideo(), Date.now()) : 0;
    if (skipBtn && tailNow === 2) {
      if (tailSkipLogged !== adScopedSeq) {
        tailSkipLogged = adScopedSeq;
        dlog('⏭️ 媒体已被摘（贴尾切流中），跳过按钮不点 | 剩余点击预算=', clickBudget);
      }
    } else if (skipBtn) {
      // 跳过按钮是"强广告态下"找到的，延迟期间广告可能已结束/元素被复用，
      // 因此 requireAd=true：点击前要求仍在强广告态（见 scheduleClick 的 S1 复检）。
      const scheduled = scheduleClick(skipBtn, () => { epochActed = true; markAdAction(Date.now()); }, null, true);
      // v1.4.4：这里不再补"冷却/排队中"那条日志 —— 它是 v1.1.x 的产物（当时没有熔断，
      // 冷却期完全不可见）。现在预算用完有 🛑 那一行说清楚，冷却/排队是 1~3 秒的
      // 瞬时状态，写出来只是噪音（v1.4.3 现场：点完第一次就紧跟一行"已点 1 次 / 冷却中"）。
      void scheduled;
    }
    // v1.3.8：以前这里是 else if——只要有按钮在 DOM 里（哪怕是残留的空壳），
    // 心跳就再也不打了。现在无论有没有按钮都打，只是有按钮时放慢到 15s。
    if (debug) emitDebugBeat(skipBtn ? 15000 : 0);

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
    // v1.4.2：换视频（SPA 导航）时正片时长参照作废。上一支视频的 mainDur 拿去
    // 判新视频，结论必然是"时长与正片不一致" → 会把新正片推到大结局。
    // 这是"用 mainDur 当判据"必须配套的清理动作（播放列表连播、点推荐最容易踩）。
    // v1.4.4：**只在视频 id 真的变了才作废**。现场（v1.4.3 日志）+386286 那次清空
    // 就是导航事件打过来的；同一个视频里 YouTube 也会发这个事件，顺手清掉参照
    // 等于自废武功——那之后 dur=1086.5 的广告立刻变成"没有参照"。
    navHandler = () => {
      const id = pageVideoId();
      if (id && id !== mainDurId) mainDur = 0;
    };
    try { document.addEventListener('yt-navigate-finish', navHandler); } catch (_) { /* ignore */ }
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

  // v1.4.5：**先读调试开关，再启动主循环**。
  // 现场（v1.4.4 日志第一段）的第一支广告往往在页面刚加载时就开始，而
  // applyState() 里会立刻 tick() 一次 —— 那一 tick 早于 debug 开关读回来，
  // 于是"广告开始 / 🎯 参照来源"这些最关键的几行被全部丢掉（打开链接先播广告
  // 的现场，本来就指望这几行）。两个 storage 回调都是异步的，按注册顺序先读 debug 即可。
  // v1.4.6：桥也要尽早起 —— 它第一次上报就可能把 mainDur 填上，而这一步理应
  // 发生在任何广告开始之前。
  installBridge();
  loadDebug();

  safeStorage(() => {
    chrome.storage.sync.get({ enabled: true }, (data) => {
      if (destroyed) return;
      // 读不到配置时按"启用"兜底，别让扩展静默失效
      applyState(chrome.runtime.lastError ? true : !!data.enabled);
      start();
    });
    chrome.storage.onChanged.addListener(storageListener);
  });

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
