# YouTube 自动跳过广告

一个极简的 Chrome 扩展（Manifest V3），在 YouTube 播放广告时自动跳过。

## 特性

- 检测到官方「跳过广告 / Skip Ad」按钮即自动点击（穿透 Shadow DOM，兼容新版播放器 UI）
- 对没有跳过按钮的插片广告，直接把播放进度推到片尾
- 自动关闭可关闭的贴片（overlay / banner）广告
- 只在明确的广告态下动作，非广告时绝不触碰播放器
- 可开关、可查看累计跳过次数、可开启调试日志

## 安装

1. 下载或克隆本仓库到本地
2. 打开 `chrome://extensions`
3. 右上角开启「开发者模式」
4. 点击「加载已解压的扩展程序」，选择本仓库目录

支持 `www.youtube.com`、`m.youtube.com`、`music.youtube.com`。

## 使用

点击工具栏图标可以：

- 开关「自动跳过」
- 开关「调试日志」（开启后到 YouTube 页面按 F12 看控制台输出）
- 查看累计跳过次数 / 清零

## 工作原理

YouTube 的广告和正片共用同一个 `<video>` 元素，广告期间播放器会挂上 `.ad-showing` 等标记。扩展在 `document_idle` 注入内容脚本，通过 `MutationObserver` + 定时轮询检测广告态：

1. **优先点击**：找到可见的官方跳过按钮并模拟真实指针事件序列（`pointerdown` → `mousedown` → `pointerup` → `mouseup` → `click`，均带 `composed: true` 以穿透 shadow root）
2. **兜底强跳**：对没有跳过按钮的广告，把 `currentTime` 推到片尾；若播放器忽略 seek 或卡在结尾，则临时改为 16× 播放
3. **防误伤**：非广告态持续记录正片时长，广告中若出现与正片等长的视频则绝不跳；广告结束后 1.5 秒内不动进度

所有点击目标都会先过一遍安全检查，拒绝 `a[href]`、`ytp-ad-clickable`、`ytp-ad-visit-advertiser` 等区域，避免误触广告主落地页。

## 目录结构

```
.
├── manifest.json      # MV3 清单
├── content.js         # 内容脚本（核心逻辑）
├── popup.html         # 工具栏弹窗
├── popup.js           # 弹窗逻辑
├── icons/             # 扩展图标
├── icon-src.png       # 图标源文件
└── test/
    └── harness.js     # jsdom 冒烟测试
```

## 测试

```bash
npm install
npm test
```

用 jsdom 真实加载 `content.js`，模拟 YouTube 广告页面的 DOM 结构，覆盖 6 条核心路径：点击跳过、视频强跳、正片保护、16× 加速、倍速还原、禁用不动作。

## 已知限制

- 后台标签页（页面不可见）不处理，属有意省资源
- 超过 5 分钟的超长广告不处理
- 跨标签页的累计计数存在理论竞态（`chrome.storage` 无原子自增）
- 第三方网站内嵌的 YouTube iframe 不在作用范围内（`all_frames: false`）

## 声明

本扩展不拦截任何网络请求、不屏蔽广告内容，仅操作播放器自身的播放状态与官方按钮。

## License

MIT
