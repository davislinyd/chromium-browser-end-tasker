const terminatedStorage = AutoEndRules.getTerminatedTabsStorage();
const protectedTabStorage = AutoEndRules.getProtectedTabsStorage();

const errorMessage = document.getElementById('error-message');
const emptyState = document.getElementById('empty-state');
const tabList = document.getElementById('tab-list');
const batchActions = document.getElementById('batch-actions');
const endTaskAllBtn = document.getElementById('end-task-all');
const restoreAllBtn = document.getElementById('restore-all');
const rulesToggleBtn = document.getElementById('rules-toggle');
const rulesContentEl = document.getElementById('rules-content');
const ruleMatchTypeEl = document.getElementById('rule-match-type');
const rulePatternEl = document.getElementById('rule-pattern');
const ruleModeEl = document.getElementById('rule-mode');
const ruleIdleGroupEl = document.getElementById('rule-idle-group');
const ruleIdleMinutesEl = document.getElementById('rule-idle-minutes');
const ruleAddBtn = document.getElementById('rule-add');
const ruleListEl = document.getElementById('rule-list');

/** Single favicon observer for the tab list (reused across re-renders). */
let faviconObserver = null;

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

const FAVICON_PLACEHOLDER =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect fill="%23ccc" width="16" height="16"/></svg>';

function getFaviconUrl(url) {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}/favicon.ico`;
  } catch {
    return '';
  }
}

function createTabItem(tab, options = {}) {
  const {
    isTerminated = false,
    storedInfo = null,
    isProtected = false,
  } = options;

  const item = document.createElement('div');
  item.className = 'tab-item';
  if (isProtected && !isTerminated) {
    item.classList.add('tab-item-protected');
  }
  item.dataset.tabId = String(tab.id);

  const displayUrl = storedInfo?.url ?? tab.url ?? '';
  const displayTitle = storedInfo?.title ?? tab.title ?? '(無標題)';

  const favicon = document.createElement('img');
  favicon.className = 'tab-favicon';
  favicon.loading = 'lazy';
  favicon.src = FAVICON_PLACEHOLDER;
  const faviconUrl = tab.favIconUrl || getFaviconUrl(displayUrl) || '';
  if (faviconUrl) favicon.dataset.faviconUrl = faviconUrl;
  favicon.alt = '';
  favicon.onerror = () => {
    favicon.src = FAVICON_PLACEHOLDER;
    delete favicon.dataset.faviconUrl;
  };

  const info = document.createElement('div');
  info.className = 'tab-info';

  const titleRow = document.createElement('div');
  titleRow.className = 'tab-title-row';

  const title = document.createElement('div');
  title.className = 'tab-title';
  title.textContent = displayTitle;
  titleRow.appendChild(title);

  if (isProtected && !isTerminated) {
    const badge = document.createElement('span');
    badge.className = 'tab-status-badge';
    badge.textContent = 'Never Close';
    titleRow.appendChild(badge);
  }

  const urlEl = document.createElement('div');
  urlEl.className = 'tab-url';
  urlEl.textContent = displayUrl;

  info.appendChild(titleRow);
  info.appendChild(urlEl);

  const actions = document.createElement('div');
  actions.className = 'tab-actions';

  if (!isTerminated) {
    const protectBtn = document.createElement('button');
    protectBtn.type = 'button';
    protectBtn.className = 'protect-toggle-btn';
    protectBtn.dataset.action = isProtected ? 'allow-auto-end' : 'never-close';
    protectBtn.textContent = isProtected ? 'Allow Auto End' : 'Never Close';
    actions.appendChild(protectBtn);
  }

  const primaryBtn = document.createElement('button');
  primaryBtn.type = 'button';
  primaryBtn.className = isTerminated ? 'restore-btn' : 'end-task-btn';
  primaryBtn.dataset.action = isTerminated ? 'restore' : 'end-task';
  primaryBtn.textContent = isTerminated ? 'Restore' : 'End Task';
  actions.appendChild(primaryBtn);

  item.appendChild(favicon);
  item.appendChild(info);
  item.appendChild(actions);

  return item;
}

function replaceTabItem(itemEl, tab, options) {
  const nextItem = createTabItem(tab, options);
  itemEl.replaceWith(nextItem);
  observeFavicons(tabList);
  return nextItem;
}

function markItemsTerminated(tabIds, storedEntries, protectedTabs) {
  const idSet = new Set((tabIds || []).map(String));
  for (const item of tabList.querySelectorAll('.tab-item')) {
    const tabId = item.dataset.tabId;
    if (!idSet.has(tabId)) continue;
    const storedInfo = storedEntries?.[tabId] || {
      url: item.querySelector('.tab-url')?.textContent,
      title: item.querySelector('.tab-title')?.textContent,
    };
    const tab = {
      id: Number(tabId),
      url: storedInfo.url,
      title: storedInfo.title,
    };
    replaceTabItem(item, tab, {
      isTerminated: true,
      storedInfo,
      isProtected: !!protectedTabs?.[tabId],
    });
  }
}

async function restoreTab(tabId, itemEl) {
  const btn = itemEl.querySelector('.restore-btn');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = '恢復中...';

  try {
    await chrome.tabs.reload(tabId);
    await terminatedStorage.removeEntry(tabId);
    const tab = await chrome.tabs.get(tabId);
    const protectedTabs = await protectedTabStorage.getAll();
    replaceTabItem(itemEl, tab, {
      isProtected: !!protectedTabs[String(tabId)],
    });
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

  const btn = itemEl.querySelector('.end-task-btn');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = '終止中...';

  try {
    const [protectedTabs, allTabs] = await Promise.all([
      protectedTabStorage.getAll(),
      chrome.tabs.query({}),
    ]);

    const result = await EndTaskCore.terminateTabProcess(tab, {
      prefixTitle: true,
      maybeHasActiveTabAccess: !!tab.active,
      allTabs,
      terminatedStorage,
    });

    markItemsTerminated(result.terminatedTabIds, result.storedEntries, protectedTabs);
  } catch (err) {
    if (EndTaskCore.isProcessNotFoundError(err)) {
      const protectedTabs = await protectedTabStorage.getAll();
      const storedInfo = EndTaskCore.storedInfoFromTab(tab);
      await terminatedStorage.setEntry(tabId, storedInfo);
      replaceTabItem(itemEl, tab, {
        isTerminated: true,
        storedInfo,
        isProtected: !!protectedTabs[String(tabId)],
      });
      return;
    }

    btn.disabled = false;
    btn.textContent = 'End Task';
    if (err?.code === 'TERMINATE_FAILED' || err?.code === 'BUILT_IN_PAGE') {
      alert('無法終止此 process，可能是內建頁面或受保護的分頁。');
    } else {
      alert(`終止失敗：${err.message}`);
    }
  }
}

async function setTabProtection(tabId, itemEl, shouldProtect) {
  const btn = itemEl.querySelector('.protect-toggle-btn');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = shouldProtect ? '設定中...' : '更新中...';

  try {
    if (shouldProtect) {
      await protectedTabStorage.setEntry(tabId, true);
    } else {
      await protectedTabStorage.removeEntry(tabId);
    }

    const tab = await chrome.tabs.get(tabId);
    replaceTabItem(itemEl, tab, { isProtected: shouldProtect });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = shouldProtect ? 'Never Close' : 'Allow Auto End';
    alert(`更新保護狀態失敗：${err.message}`);
  }
}

async function endTaskAll() {
  if (!chrome.processes) return;

  const items = [...tabList.querySelectorAll('.tab-item')].filter((item) =>
    item.querySelector('.end-task-btn')
  );
  if (items.length === 0) return;

  endTaskAllBtn.disabled = true;
  endTaskAllBtn.textContent = '終止中...';

  try {
    const tabIds = items.map((item) => parseInt(item.dataset.tabId, 10));
    const tabs = await EndTaskCore.runWithConcurrency(
      tabIds,
      EndTaskCore.DEFAULT_CONCURRENCY,
      async (tabId) => {
        try {
          return await chrome.tabs.get(tabId);
        } catch {
          return null;
        }
      }
    );
    const validTabs = tabs.filter(Boolean);
    if (validTabs.length === 0) return;

    const [protectedTabs, allTabs] = await Promise.all([
      protectedTabStorage.getAll(),
      chrome.tabs.query({}),
    ]);

    const result = await EndTaskCore.terminateTabsBatch(validTabs, {
      prefixTitle: true,
      concurrency: EndTaskCore.DEFAULT_CONCURRENCY,
      allTabs,
      terminatedStorage,
    });

    markItemsTerminated(result.terminatedTabIds, result.storedEntries, protectedTabs);
  } catch (err) {
    alert(`批次終止失敗：${err.message}`);
  } finally {
    endTaskAllBtn.disabled = false;
    endTaskAllBtn.textContent = 'End Task All';
  }
}

async function restoreAll() {
  const items = [...tabList.querySelectorAll('.tab-item')].filter((item) =>
    item.querySelector('.restore-btn')
  );
  if (items.length === 0) return;

  restoreAllBtn.disabled = true;
  restoreAllBtn.textContent = '恢復中...';

  try {
    const protectedTabs = await protectedTabStorage.getAll();
    const succeededIds = [];

    await EndTaskCore.runWithConcurrency(
      items,
      EndTaskCore.DEFAULT_CONCURRENCY,
      async (item) => {
        const tabId = parseInt(item.dataset.tabId, 10);
        const btn = item.querySelector('.restore-btn');
        if (btn) {
          btn.disabled = true;
          btn.textContent = '恢復中...';
        }
        try {
          await chrome.tabs.reload(tabId);
          succeededIds.push(tabId);
          const tab = await chrome.tabs.get(tabId);
          replaceTabItem(item, tab, {
            isProtected: !!protectedTabs[String(tabId)],
          });
        } catch (err) {
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Restore';
          }
          console.error('Restore failed:', tabId, err);
        }
      }
    );

    if (succeededIds.length > 0) {
      await terminatedStorage.removeEntries(succeededIds);
    }
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
    const [tabs, terminatedDataRaw, protectedDataRaw, { autoEndTask }] =
      await Promise.all([
        chrome.tabs.query({ currentWindow: true }),
        terminatedStorage.getAll(),
        protectedTabStorage.getAll(),
        chrome.storage.local.get('autoEndTask'),
      ]);

    const terminatedTabs =
      terminatedDataRaw && typeof terminatedDataRaw === 'object'
        ? terminatedDataRaw
        : {};
    const protectedTabs =
      protectedDataRaw && typeof protectedDataRaw === 'object'
        ? protectedDataRaw
        : {};
    const tabIds = new Set(tabs.map((tab) => String(tab.id)));
    let validTerminated = Object.fromEntries(
      Object.entries(terminatedTabs).filter(([id]) => tabIds.has(id))
    );

    // Drop stale terminated entries for closed tabs (session store hygiene).
    const staleIds = Object.keys(terminatedTabs).filter((id) => !tabIds.has(id));
    if (staleIds.length > 0) {
      terminatedStorage.removeEntries(staleIds).catch(() => {});
    }

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

    // Reconcile tabs whose process is already gone but not marked terminated.
    validTerminated = await EndTaskCore.reconcileDeadTabs(
      filteredTabs,
      validTerminated,
      terminatedStorage
    );

    filteredTabs.sort((a, b) => (a.active ? 0 : 1) - (b.active ? 0 : 1));

    const fragment = document.createDocumentFragment();
    for (const tab of filteredTabs) {
      const storedInfo = validTerminated[String(tab.id)];
      fragment.appendChild(
        createTabItem(tab, {
          isTerminated: !!storedInfo,
          storedInfo,
          isProtected: !!protectedTabs[String(tab.id)],
        })
      );
    }
    tabList.innerHTML = '';
    tabList.appendChild(fragment);
    showTabList();

    resetFaviconObserver(tabList);
    observeFavicons(tabList);
    scheduleDeferredInit(autoEndTask);
  } catch (err) {
    showError(`載入分頁失敗：${err.message}`);
  }
}

function resetFaviconObserver(container) {
  if (faviconObserver) {
    faviconObserver.disconnect();
    faviconObserver = null;
  }
  faviconObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        const url = img.dataset.faviconUrl;
        if (url) {
          img.src = url;
          delete img.dataset.faviconUrl;
          faviconObserver.unobserve(img);
        }
      }
    },
    { root: container, rootMargin: '50px', threshold: 0 }
  );
  return faviconObserver;
}

function observeFavicons(container) {
  if (!faviconObserver) {
    resetFaviconObserver(container);
  }
  for (const el of container.querySelectorAll('.tab-favicon')) {
    if (el.dataset.faviconUrl) {
      faviconObserver.observe(el);
    }
  }
}

async function loadAutoEndRules() {
  const rules = await AutoEndRules.ensureAutoEndRulesMigrated();
  renderRuleList(rules);
}

function renderRuleList(rules) {
  if (!ruleListEl) return;

  const normalizedRules = AutoEndRules.normalizeRules(rules);
  ruleListEl.innerHTML = '';

  if (normalizedRules.length === 0) {
    const emptyItem = document.createElement('li');
    emptyItem.className = 'rule-empty';
    emptyItem.textContent = '尚未設定站點規則';
    ruleListEl.appendChild(emptyItem);
    return;
  }

  for (const rule of normalizedRules) {
    const item = document.createElement('li');
    item.className = 'rule-item';

    const main = document.createElement('div');
    main.className = 'rule-item-main';

    const title = document.createElement('span');
    title.className = 'rule-item-title';
    title.textContent = `${AutoEndRules.getRuleMatchLabel(rule.matchType)} · ${rule.pattern}`;

    const detail = document.createElement('span');
    detail.className = 'rule-item-detail';
    detail.textContent = AutoEndRules.getRuleModeLabel(rule);

    main.appendChild(title);
    main.appendChild(detail);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'rule-remove-btn';
    removeBtn.dataset.ruleId = rule.id;
    removeBtn.textContent = '刪除';

    item.appendChild(main);
    item.appendChild(removeBtn);
    ruleListEl.appendChild(item);
  }
}

function syncRuleModeUi() {
  if (!ruleModeEl || !ruleIdleGroupEl) return;
  ruleIdleGroupEl.classList.toggle(
    'hidden',
    ruleModeEl.value !== AutoEndRules.RULE_MODE_IDLE
  );
}

function getRuleValidationMessage(matchType, pattern, mode, idleMinutes) {
  if (!pattern.trim()) return '請輸入規則內容。';

  if (!AutoEndRules.normalizePattern(matchType, pattern)) {
    if (matchType === AutoEndRules.MATCH_TYPE_URL) {
      return 'URL 規則需輸入完整的 http/https URL。';
    }
    return 'Domain / FQDN 規則只接受 host 名稱，請不要包含協定、路徑或查詢字串。';
  }

  if (mode === AutoEndRules.RULE_MODE_IDLE) {
    const parsed = Number.parseInt(idleMinutes, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 120) {
      return '自動關閉分鐘數需介於 1 到 120。';
    }
  }

  return '';
}

async function upsertAutoEndRule() {
  if (!ruleMatchTypeEl || !rulePatternEl || !ruleModeEl || !ruleIdleMinutesEl) return;

  const matchType = ruleMatchTypeEl.value;
  const pattern = rulePatternEl.value;
  const mode = ruleModeEl.value;
  const idleMinutes = ruleIdleMinutesEl.value;
  const validationMessage = getRuleValidationMessage(
    matchType,
    pattern,
    mode,
    idleMinutes
  );

  if (validationMessage) {
    alert(validationMessage);
    return;
  }

  const nextRule = AutoEndRules.createRule({
    matchType,
    pattern,
    mode,
    idleMinutes,
  });

  if (!nextRule) {
    alert('規則格式不正確，請重新確認。');
    return;
  }

  const currentRules = await AutoEndRules.ensureAutoEndRulesMigrated();
  const nextRules = currentRules.filter((rule) => rule.id !== nextRule.id);
  nextRules.push(nextRule);
  const normalizedRules = AutoEndRules.normalizeRules(nextRules);

  await chrome.storage.local.set({
    [AutoEndRules.AUTO_END_RULES_KEY]: normalizedRules,
  });

  renderRuleList(normalizedRules);
  rulePatternEl.value = '';
  if (nextRule.mode === AutoEndRules.RULE_MODE_IDLE) {
    ruleIdleMinutesEl.value = String(nextRule.idleMinutes);
  }
}

async function removeAutoEndRule(ruleId) {
  const currentRules = await AutoEndRules.ensureAutoEndRulesMigrated();
  const nextRules = currentRules.filter((rule) => rule.id !== ruleId);
  await chrome.storage.local.set({
    [AutoEndRules.AUTO_END_RULES_KEY]: nextRules,
  });
  renderRuleList(nextRules);
}

function setupRulesUI() {
  if (rulesToggleBtn && rulesContentEl) {
    rulesToggleBtn.addEventListener('click', () => {
      const isHidden = rulesContentEl.classList.toggle('hidden');
      rulesToggleBtn.textContent = isHidden ? '展開' : '收合';
      rulesToggleBtn.setAttribute('aria-expanded', String(!isHidden));
    });
  }

  ruleModeEl?.addEventListener('change', syncRuleModeUi);
  ruleAddBtn?.addEventListener('click', upsertAutoEndRule);
}

function scheduleDeferredInit(autoEndTask) {
  const run = () => {
    loadShortcutInfo();
    applyAutoEndSettings(autoEndTask);
    syncRuleModeUi();
  };
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(run, { timeout: 100 });
  } else {
    setTimeout(run, 0);
  }
}

function applyAutoEndSettings(autoEndTask) {
  const enabledEl = document.getElementById('auto-end-enabled');
  const minutesEl = document.getElementById('auto-end-minutes');
  if (!enabledEl || !minutesEl) return;
  const { enabled = false, idleMinutes = AutoEndRules.DEFAULT_IDLE_MINUTES } =
    autoEndTask || {};
  enabledEl.checked = enabled;
  minutesEl.value = AutoEndRules.clampIdleMinutes(idleMinutes);
}

function saveAutoEndSettings() {
  const enabledEl = document.getElementById('auto-end-enabled');
  const minutesEl = document.getElementById('auto-end-minutes');
  if (!enabledEl || !minutesEl) return;

  const idleMinutes = AutoEndRules.clampIdleMinutes(minutesEl.value);
  chrome.storage.local.set({
    autoEndTask: {
      enabled: enabledEl.checked,
      idleMinutes,
    },
  });

  if (enabledEl.checked && idleMinutes < 5) {
    alert('閒置分鐘數低於 5 分鐘可能導致分頁頻繁被終止，請謹慎使用。');
  }
}

async function loadShortcutInfo() {
  const shortcutDisplay = document.getElementById('shortcut-display');
  if (!shortcutDisplay) return;
  try {
    const commands = await chrome.commands.getAll();
    const endTaskCmd = commands.find((command) => command.name === 'end-current-tab');
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

function handleTabListClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;

  const item = e.target.closest('.tab-item');
  if (!item) return;

  const tabId = parseInt(item.dataset.tabId, 10);
  switch (btn.dataset.action) {
    case 'restore':
      restoreTab(tabId, item);
      break;
    case 'end-task':
      chrome.tabs
        .get(tabId)
        .then((tab) => endTask(tabId, item, tab))
        .catch(() => {});
      break;
    case 'never-close':
      setTabProtection(tabId, item, true);
      break;
    case 'allow-auto-end':
      setTabProtection(tabId, item, false);
      break;
    default:
      break;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  AutoEndRules.ensureAutoEndRulesMigrated()
    .then(() => Promise.all([loadTabs(), loadAutoEndRules()]))
    .catch((err) => {
      showError(`初始化設定失敗：${err.message}`);
    });

  setupRulesUI();
  tabList.addEventListener('click', handleTabListClick);
  ruleListEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('.rule-remove-btn');
    if (!btn?.dataset.ruleId) return;
    removeAutoEndRule(btn.dataset.ruleId);
  });
  document
    .getElementById('open-shortcut-settings')
    ?.addEventListener('click', openShortcutSettings);
  document.getElementById('auto-end-enabled')?.addEventListener('change', saveAutoEndSettings);
  document.getElementById('auto-end-minutes')?.addEventListener('change', saveAutoEndSettings);
  endTaskAllBtn?.addEventListener('click', endTaskAll);
  restoreAllBtn?.addEventListener('click', restoreAll);
});
