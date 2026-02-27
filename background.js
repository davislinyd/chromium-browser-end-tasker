const STORAGE_KEY = 'terminatedTabs';
const sessionStorage = chrome?.storage?.session;
const terminatedStorage = sessionStorage
  ? {
      async get() {
        return sessionStorage.get(null);
      },
      async setTab(tabId, data) {
        await sessionStorage.set({ [String(tabId)]: data });
      },
    }
  : {
      async get() {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        return result[STORAGE_KEY] || {};
      },
      async setTab(tabId, data) {
        const current = await this.get();
        current[String(tabId)] = data;
        await chrome.storage.local.set({ [STORAGE_KEY]: current });
      },
    };

async function ensureAlarm() {
  const alarm = await chrome.alarms.get('auto-end-task');
  if (!alarm) {
    await chrome.alarms.create('auto-end-task', { periodInMinutes: 1 });
  }
}

async function runAutoEndTask() {
  if (!chrome.processes) return;

  const { autoEndTask } = await chrome.storage.local.get('autoEndTask');
  const { enabled = false, idleMinutes = 15 } = autoEndTask || {};
  if (!enabled) return;

  const idleMs = idleMinutes * 60 * 1000;
  const now = Date.now();
  const terminated = await terminatedStorage.get();

  const tabs = await chrome.tabs.query({});
  const canTerminate = (tab) =>
    tab.id &&
    !tab.active &&
    tab.lastAccessed != null &&
    now - tab.lastAccessed > idleMs &&
    !tab.url?.startsWith('chrome://') &&
    !tab.url?.startsWith('brave://') &&
    !tab.url?.startsWith('edge://');

  const toTerminate = tabs.filter(
    (tab) => canTerminate(tab) && !terminated[String(tab.id)]
  );

  for (const tab of toTerminate) {
    try {
      const processId = await chrome.processes.getProcessIdForTab(tab.id);
      await chrome.processes.terminate(processId);
      await terminatedStorage.setTab(tab.id, {
        url: tab.url,
        title: tab.title,
      });
    } catch (err) {
      const isProcessNotFound = err?.message?.includes('Process not found');
      if (isProcessNotFound) {
        await terminatedStorage.setTab(tab.id, {
          url: tab.url,
          title: tab.title,
        });
      } else {
        console.error('Auto end task failed:', err);
      }
    }
  }
}

ensureAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'auto-end-task') {
    runAutoEndTask();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'end-current-tab') {
    if (!chrome.processes) {
      console.error('chrome.processes API is not available');
      return;
    }

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('brave://') || tab.url?.startsWith('edge://')) {
        console.warn('Cannot terminate built-in pages');
        return;
      }

      const processId = await chrome.processes.getProcessIdForTab(tab.id);
      await chrome.processes.terminate(processId);
    } catch (err) {
      console.error('Failed to terminate process:', err);
    }
  }
});
