const toggle = document.getElementById('toggle');
const debugToggle = document.getElementById('debug');
const skippedEl = document.getElementById('skipped');
const resetBtn = document.getElementById('reset');

// 初始化
chrome.storage.sync.get({ enabled: true, debug: false }, (data) => {
  toggle.checked = data.enabled;
  debugToggle.checked = data.debug;
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

// 清零
resetBtn.addEventListener('click', () => {
  chrome.storage.local.set({ skipped: 0 }, () => {
    skippedEl.textContent = '0';
  });
});

// 实时刷新计数（弹窗打开期间）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.skipped) {
    skippedEl.textContent = changes.newValue;
  }
});
