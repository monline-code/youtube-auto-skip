const toggle = document.getElementById('toggle');
const debugToggle = document.getElementById('debug');
const skippedEl = document.getElementById('skipped');
const resetBtn = document.getElementById('reset');
const dumpBtn = document.getElementById('dump');
const dumpHint = document.getElementById('dumpHint');

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
});
