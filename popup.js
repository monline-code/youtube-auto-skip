const toggle = document.getElementById('toggle');
const debugToggle = document.getElementById('debug');
const prerollInput = document.getElementById('preroll');
const skippedEl = document.getElementById('skipped');
const resetBtn = document.getElementById('reset');
const dumpBtn = document.getElementById('dump');
const dumpHint = document.getElementById('dumpHint');

// 首个前置广告的真实播放门槛（毫秒）：默认 1500，0 = 关闭
const PREROLL_DEFAULT_MS = 1500;
const PREROLL_MIN_MS = 0;
const PREROLL_MAX_MS = 15000;

// 初始化
chrome.storage.sync.get({ enabled: true, debug: false, prerollMs: PREROLL_DEFAULT_MS }, (data) => {
  toggle.checked = data.enabled;
  debugToggle.checked = data.debug;
  prerollInput.value = String(Math.round(Number(data.prerollMs) / 100) / 10);
});

chrome.storage.local.get({ skipped: 0 }, (data) => {
  skippedEl.textContent = data.skipped;
});

// 开关
toggle.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: toggle.checked });
});

// 调试日志开关
debugToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ debug: debugToggle.checked });
});

// 首支广告门槛：输入秒数，存毫秒。非法输入按默认值处理，不做静默丢弃。
function savePreroll() {
  const sec = parseFloat(prerollInput.value);
  const ms = isFinite(sec)
    ? Math.min(PREROLL_MAX_MS, Math.max(PREROLL_MIN_MS, Math.round(sec * 1000)))
    : PREROLL_DEFAULT_MS;
  prerollInput.value = String(Math.round(ms / 100) / 10);
  chrome.storage.sync.set({ prerollMs: ms });
}
prerollInput.addEventListener('change', savePreroll);
prerollInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') prerollInput.blur();   // 回车即生效
});

// 清零
resetBtn.addEventListener('click', () => {
  chrome.storage.local.set({ skipped: 0 }, () => {
    skippedEl.textContent = '0';
  });
});

// 导出调试日志：向当前标签页的内容脚本要它自己攒的日志（不含页面噪音）
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    ok ? resolve() : reject(new Error('copy failed'));
  });
}

dumpBtn.addEventListener('click', () => {
  dumpHint.textContent = '读取中…';
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) {
      dumpHint.textContent = '找不到当前标签页';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'ytAutoSkip:dumpLog' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        dumpHint.textContent = '当前页面没有扩展脚本（请在 YouTube 页面打开）';
        return;
      }
      if (!resp.count) {
        dumpHint.textContent = resp.debug
          ? '还没有日志：等广告出现后再点一次'
          : '请先打开上面的「调试日志」开关';
        return;
      }
      copyText(resp.text).then(() => {
        dumpHint.textContent = '已复制 ' + resp.count + ' 行（v' + resp.version + '）';
      }).catch(() => {
        dumpHint.textContent = '复制失败：请到控制台手动复制 [YT-AutoSkip] 行';
      });
    });
  });
});

// 实时刷新计数（弹窗打开期间）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.skipped) {
    skippedEl.textContent = changes.newValue;
  }
  if (area === 'sync' && changes.prerollMs && document.activeElement !== prerollInput) {
    prerollInput.value = String(Math.round(Number(changes.newValue.newValue) / 100) / 10);
  }
});
