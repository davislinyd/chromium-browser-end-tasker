importScripts('auto-end-rules.js', 'prefix-tab-title.js');

const terminatedStorage = AutoEndRules.getTerminatedTabsStorage();
const protectedTabStorage = AutoEndRules.getProtectedTabsStorage();

function isBuiltInPage(url) {
  return (
    url?.startsWith('chrome://') ||
    url?.startsWith('brave://') ||
    url?.startsWith('edge://')
  );
}

function canAutoTerminateTab(tab) {
  return tab.id && !tab.active && tab.lastAccessed != null && !isBuiltInPage(tab.url);
}

async function cleanupStaleProtectedTabs(tabs) {
  const protectedTabs = await protectedTabStorage.getAll();
  const validTabIds = new Set((tabs || []).map((tab) => String(tab.id)));
  let changed = false;

  for (const tabId of Object.keys(protectedTabs)) {
    if (!validTabIds.has(tabId)) {
      delete protectedTabs[tabId];
      changed = true;
    }
  }

  if (changed) {
    await protectedTabStorage.setAll(protectedTabs);
  }

  return protectedTabs;
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get('auto-end-task');
  if (!alarm) {
    await chrome.alarms.create('auto-end-task', { periodInMinutes: 1 });
  }
}

async function runAutoEndTask() {
  if (!chrome.processes) return;

  const rules = await AutoEndRules.ensureAutoEndRulesMigrated();
  const { autoEndTask } = await chrome.storage.local.get('autoEndTask');
  const { enabled = false, idleMinutes = AutoEndRules.DEFAULT_IDLE_MINUTES } =
    autoEndTask || {};
  if (!enabled) return;

  const now = Date.now();
  const terminatedTabs = await terminatedStorage.getAll();
  const tabs = await chrome.tabs.query({});
  const protectedTabs = await cleanupStaleProtectedTabs(tabs);
  const toTerminate = [];

  for (const tab of tabs) {
    if (!canAutoTerminateTab(tab)) continue;
    if (terminatedTabs[String(tab.id)]) continue;

    const policy = AutoEndRules.resolveAutoEndPolicy(
      tab,
      rules,
      idleMinutes,
      protectedTabs
    );

    if (!policy || policy.mode === AutoEndRules.RULE_MODE_NEVER) continue;
    if (now - tab.lastAccessed <= policy.idleMinutes * 60 * 1000) continue;

    toTerminate.push(tab);
  }

  for (const tab of toTerminate) {
    try {
      await prefixTabTitleWithMarker(tab.id, tab.url);
      const processId = await chrome.processes.getProcessIdForTab(tab.id);
      await chrome.processes.terminate(processId);
      await terminatedStorage.setEntry(tab.id, {
        url: tab.url,
        title: tab.title,
      });
    } catch (err) {
      const isProcessNotFound = err?.message?.includes('Process not found');
      if (isProcessNotFound) {
        await terminatedStorage.setEntry(tab.id, {
          url: tab.url,
          title: tab.title,
        });
      } else {
        console.error('Auto end task failed:', err);
      }
    }
  }
}

if (!AutoEndRules.hasSessionStorageSupport()) {
  chrome.runtime.onStartup.addListener(() => {
    chrome.storage.local.remove(AutoEndRules.PROTECTED_TABS_KEY);
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  protectedTabStorage.removeEntry(tabId).catch(() => {});
});

AutoEndRules.ensureAutoEndRulesMigrated().catch((err) => {
  console.error('Failed to initialize auto end rules:', err);
});

ensureAlarm().catch((err) => {
  console.error('Failed to ensure auto end alarm:', err);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'auto-end-task') {
    runAutoEndTask().catch((err) => {
      console.error('Auto end task run failed:', err);
    });
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

      if (isBuiltInPage(tab.url)) {
        console.warn('Cannot terminate built-in pages');
        return;
      }

      await prefixTabTitleWithMarker(tab.id, tab.url);
      const processId = await chrome.processes.getProcessIdForTab(tab.id);
      await chrome.processes.terminate(processId);
    } catch (err) {
      console.error('Failed to terminate process:', err);
    }
  }
});
