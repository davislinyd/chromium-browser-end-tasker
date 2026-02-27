const errorMessage = document.getElementById('error-message');
const emptyState = document.getElementById('empty-state');
const tabList = document.getElementById('tab-list');
const batchActions = document.getElementById('batch-actions');
const endTaskAllBtn = document.getElementById('end-task-all');
const restoreAllBtn = document.getElementById('restore-all');

// chrome.storage.session 在 Chrome 102+ 才支援；不支援時改用 local 以在 popup 關閉後保留狀態
const STORAGE_KEY = 'terminatedTabs';
const sessionStorage = chrome?.storage?.session;
const localStorage = chrome?.storage?.local;
const storage = sessionStorage
  ? {
      async get() {
        return sessionStorage.get(null);
      },
      async set(data) {
        return sessionStorage.set(data);
      },
      async remove(key) {
        return sessionStorage.remove(key);
      },
    }
  : localStorage
    ? {
        async get() {
          const result = await localStorage.get(STORAGE_KEY);
          return result[STORAGE_KEY] || {};
        },
        async set(data) {
          const current = await this.get();
          await localStorage.set({ [STORAGE_KEY]: { ...current, ...data } });
        },
        async remove(key) {
          const current = await this.get();
          delete current[key];
          await localStorage.set({ [STORAGE_KEY]: current });
        },
      }
    : {
        _data: {},
        async get() {
          return { ...this._data };
        },
        async set(data) {
          Object.assign(this._data, data);
        },
        async remove(key) {
          delete this._data[key];
        },
      };

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.remove('hidden');
  emptyState.classList.add('hidden');
  tabList.classList.add('hidden');
  batchActions?.classList.add('hidden');
}

function showEmptyState() {
  errorMessage.classList.add('hidden');
  emptyState.classList.remove('hidden');
  tabList.classList.add('hidden');
  batchActions?.classList.add('hidden');
}

function showTabList() {
  errorMessage.classList.add('hidden');
  emptyState.classList.add('hidden');
  tabList.classList.remove('hidden');
  batchActions?.classList.remove('hidden');
}

function getFaviconUrl(url) {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}/favicon.ico`;
  } catch {
    return '';
  }
}

function createTabItem(tab, isTerminated = false, storedInfo = null) {
  const item = document.createElement('div');
  item.className = 'tab-item';
  item.dataset.tabId = tab.id;

  const displayUrl = storedInfo?.url ?? tab.url ?? '';
  const displayTitle = storedInfo?.title ?? tab.title ?? '(無標題)';

  const favicon = document.createElement('img');
  favicon.className = 'tab-favicon';
  favicon.loading = 'lazy';
  favicon.src = tab.favIconUrl || getFaviconUrl(displayUrl);
  favicon.alt = '';
  favicon.onerror = () => {
    favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect fill="%23ccc" width="16" height="16"/></svg>';
  };

  const info = document.createElement('div');
  info.className = 'tab-info';

  const title = document.createElement('div');
  title.className = 'tab-title';
  title.textContent = displayTitle;

  const urlEl = document.createElement('div');
  urlEl.className = 'tab-url';
  urlEl.textContent = displayUrl;

  info.appendChild(title);
  info.appendChild(urlEl);

  const btn = document.createElement('button');
  btn.className = isTerminated ? 'restore-btn' : 'end-task-btn';
  btn.textContent = isTerminated ? 'Restore' : 'End Task';
  btn.onclick = isTerminated
    ? () => restoreTab(tab.id, item)
    : () => endTask(tab.id, item, tab);

  item.appendChild(favicon);
  item.appendChild(info);
  item.appendChild(btn);

  return item;
}

async function restoreTab(tabId, itemEl) {
  const btn = itemEl.querySelector('.end-task-btn, .restore-btn');
  btn.disabled = true;
  btn.textContent = '恢復中...';

  try {
    await chrome.tabs.reload(tabId);
    await storage.remove(String(tabId));
    const tab = await chrome.tabs.get(tabId);
    btn.className = 'end-task-btn';
    btn.textContent = 'End Task';
    btn.disabled = false;
    btn.onclick = () => endTask(tabId, itemEl, tab);
    const titleEl = itemEl.querySelector('.tab-title');
    const urlEl = itemEl.querySelector('.tab-url');
    const faviconEl = itemEl.querySelector('.tab-favicon');
    if (titleEl) titleEl.textContent = tab.title || '(無標題)';
    if (urlEl) urlEl.textContent = tab.url || '';
    if (faviconEl) faviconEl.src = tab.favIconUrl || getFaviconUrl(tab.url);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Restore';
    alert(`恢復失敗：${err.message}`);
  }
}

async function endTask(tabId, itemEl, tab) {
  if (!chrome.processes) {
    showError('chrome.processes API 不支援。請使用 Chrome Dev channel。');
    return;
  }

  const btn = itemEl.querySelector('.end-task-btn, .restore-btn');
  btn.disabled = true;
  btn.textContent = '終止中...';

  try {
    const processId = await chrome.processes.getProcessIdForTab(tabId);
    const success = await chrome.processes.terminate(processId);

    if (success) {
      await storage.set({
        [String(tabId)]: { url: tab.url, title: tab.title },
      });
      btn.className = 'restore-btn';
      btn.textContent = 'Restore';
      btn.disabled = false;
      btn.onclick = () => restoreTab(tabId, itemEl);
    } else {
      btn.disabled = false;
      btn.textContent = 'End Task';
      alert('無法終止此 process，可能是內建頁面或受保護的分頁。');
    }
  } catch (err) {
    const isProcessNotFound = err?.message?.includes('Process not found');
    if (isProcessNotFound) {
      await storage.set({
        [String(tabId)]: { url: tab.url, title: tab.title },
      });
      btn.className = 'restore-btn';
      btn.textContent = 'Restore';
      btn.disabled = false;
      btn.onclick = () => restoreTab(tabId, itemEl);
    } else {
      btn.disabled = false;
      btn.textContent = 'End Task';
      alert(`終止失敗：${err.message}`);
    }
  }
}

async function endTaskAll() {
  if (!chrome.processes) return;
  const items = tabList.querySelectorAll('.tab-item');
  const endTaskItems = [];
  for (const item of items) {
    if (item.querySelector('.end-task-btn')) endTaskItems.push(item);
  }
  if (endTaskItems.length === 0) return;
  endTaskAllBtn.disabled = true;
  endTaskAllBtn.textContent = '終止中...';
  try {
    for (const item of endTaskItems) {
      const tabId = parseInt(item.dataset.tabId, 10);
      try {
        const tab = await chrome.tabs.get(tabId);
        await endTask(tabId, item, tab);
      } catch {
        // Tab may have been closed or process already gone
      }
    }
  } finally {
    endTaskAllBtn.disabled = false;
    endTaskAllBtn.textContent = 'End Task All';
  }
}

async function restoreAll() {
  const items = tabList.querySelectorAll('.tab-item');
  const restoreItems = [];
  for (const item of items) {
    if (item.querySelector('.restore-btn')) restoreItems.push(item);
  }
  if (restoreItems.length === 0) return;
  restoreAllBtn.disabled = true;
  restoreAllBtn.textContent = '恢復中...';
  try {
    await Promise.all(
      restoreItems.map((item) => restoreTab(parseInt(item.dataset.tabId, 10), item))
    );
  } finally {
    restoreAllBtn.disabled = false;
    restoreAllBtn.textContent = 'Restore All';
  }
}

async function loadTabs() {
  if (!chrome.processes) {
    showError('chrome.processes API 不支援。請使用 Chrome Dev channel。');
    return;
  }

  tabList.innerHTML = '<div class="loading-state">載入中...</div>';
  tabList.classList.remove('hidden');
  errorMessage.classList.add('hidden');
  emptyState.classList.add('hidden');

  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });

    const isCrashed = (tab) =>
      tab.url?.startsWith('chrome://crash') ||
      tab.url?.startsWith('chrome-error://');
    const isNormal = (tab) =>
      tab.id &&
      !tab.url?.startsWith('chrome://') &&
      !tab.url?.startsWith('brave://') &&
      !tab.url?.startsWith('edge://');

    const filteredTabs = tabs.filter((tab) => tab.id && (isCrashed(tab) || isNormal(tab)));

    if (filteredTabs.length === 0) {
      showEmptyState();
      return;
    }

    filteredTabs.sort((a, b) => (a.active ? 0 : 1) - (b.active ? 0 : 1));

    const fragment = document.createDocumentFragment();
    for (const tab of filteredTabs) {
      fragment.appendChild(createTabItem(tab, false, null));
    }
    tabList.innerHTML = '';
    tabList.appendChild(fragment);
    showTabList();

    storage.get().then((terminatedData) => {
      const terminatedTabs = terminatedData && typeof terminatedData === 'object' ? terminatedData : {};
      const tabIds = new Set(tabs.map((t) => String(t.id)));
      const validTerminated = Object.fromEntries(
        Object.entries(terminatedTabs).filter(([id]) => tabIds.has(id))
      );
      for (const item of tabList.querySelectorAll('.tab-item')) {
        const tabId = item.dataset.tabId;
        const storedInfo = validTerminated[tabId];
        if (storedInfo) {
          const btn = item.querySelector('.end-task-btn, .restore-btn');
          const tab = filteredTabs.find((t) => String(t.id) === tabId);
          if (btn && tab) {
            btn.className = 'restore-btn';
            btn.textContent = 'Restore';
            btn.onclick = () => restoreTab(tab.id, item);
          }
          const titleEl = item.querySelector('.tab-title');
          const urlEl = item.querySelector('.tab-url');
          if (titleEl) titleEl.textContent = storedInfo.title || '(無標題)';
          if (urlEl) urlEl.textContent = storedInfo.url || '';
        }
      }
    });
  } catch (err) {
    showError(`載入分頁失敗：${err.message}`);
  }
}

async function loadAutoEndSettings() {
  const enabledEl = document.getElementById('auto-end-enabled');
  const minutesEl = document.getElementById('auto-end-minutes');
  if (!enabledEl || !minutesEl) return;
  try {
    const { autoEndTask } = await chrome.storage.local.get('autoEndTask');
    const { enabled = false, idleMinutes = 15 } = autoEndTask || {};
    enabledEl.checked = enabled;
    minutesEl.value = Math.min(120, Math.max(1, idleMinutes));
  } catch {
    enabledEl.checked = false;
    minutesEl.value = 15;
  }
}

function saveAutoEndSettings() {
  const enabledEl = document.getElementById('auto-end-enabled');
  const minutesEl = document.getElementById('auto-end-minutes');
  if (!enabledEl || !minutesEl) return;
  const idleMinutes = Math.min(120, Math.max(1, parseInt(minutesEl.value, 10) || 15));
  chrome.storage.local.set({
    autoEndTask: {
      enabled: enabledEl.checked,
      idleMinutes,
    },
  });
  if (idleMinutes < 5) {
    alert('閒置分鐘數低於 5 分鐘可能導致分頁頻繁被終止，請謹慎使用。');
  }
}

async function loadShortcutInfo() {
  const shortcutDisplay = document.getElementById('shortcut-display');
  if (!shortcutDisplay) return;
  try {
    const commands = await chrome.commands.getAll();
    const endTaskCmd = commands.find((c) => c.name === 'end-current-tab');
    shortcutDisplay.textContent = endTaskCmd?.shortcut
      ? `快捷鍵：${endTaskCmd.shortcut}`
      : '快捷鍵：未設定';
  } catch {
    shortcutDisplay.textContent = '快捷鍵：Ctrl+E (Cmd+E)';
  }
}

function openShortcutSettings() {
  const isEdge = navigator.userAgent.includes('Edg');
  const url = isEdge ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';
  chrome.tabs.create({ url });
}

document.addEventListener('DOMContentLoaded', () => {
  requestAnimationFrame(() => {
    loadTabs();
    loadShortcutInfo();
    loadAutoEndSettings();
  });
  document.getElementById('open-shortcut-settings')?.addEventListener('click', openShortcutSettings);
  document.getElementById('auto-end-enabled')?.addEventListener('change', saveAutoEndSettings);
  document.getElementById('auto-end-minutes')?.addEventListener('change', saveAutoEndSettings);
  endTaskAllBtn?.addEventListener('click', endTaskAll);
  restoreAllBtn?.addEventListener('click', restoreAll);
});
