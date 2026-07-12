/**
 * Shared End Task helpers for popup and service worker.
 * Depends on: AutoEndRules, prefixTabTitleWithMarker (optional for prefix).
 */
(function () {
  const DEFAULT_CONCURRENCY = 4;

  function isBuiltInPage(url) {
    return (
      url?.startsWith('chrome://') ||
      url?.startsWith('brave://') ||
      url?.startsWith('edge://')
    );
  }

  function isProcessNotFoundError(err) {
    return String(err?.message || '').includes('Process not found');
  }

  function storedInfoFromTab(tab) {
    return {
      url: tab?.url,
      title: tab?.title,
    };
  }

  /**
   * Run async work over items with a concurrency limit.
   * @template T, R
   * @param {T[]} items
   * @param {number} limit
   * @param {(item: T, index: number) => Promise<R>} worker
   * @returns {Promise<R[]>}
   */
  async function runWithConcurrency(items, limit, worker) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return [];

    const concurrency = Math.max(1, Math.min(limit || DEFAULT_CONCURRENCY, list.length));
    const results = new Array(list.length);
    let nextIndex = 0;

    async function workerLoop() {
      while (nextIndex < list.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(list[index], index);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));
    return results;
  }

  async function getTabIdsForProcess(processId) {
    if (processId == null || !chrome.processes?.getProcessInfo) {
      return null;
    }

    try {
      const info = await chrome.processes.getProcessInfo(processId, false);
      const processInfo = info?.[processId] ?? info?.[String(processId)];
      if (processInfo && Array.isArray(processInfo.tabs)) {
        return processInfo.tabs.map((id) => Number(id)).filter((id) => Number.isFinite(id));
      }
    } catch {
      // Fall through to tab-by-tab scan.
    }
    return null;
  }

  async function resolveAffectedTabs(primaryTab, processId, allTabs) {
    const tabsById = new Map();
    for (const tab of allTabs || []) {
      if (tab?.id != null) tabsById.set(tab.id, tab);
    }
    if (primaryTab?.id != null) tabsById.set(primaryTab.id, primaryTab);

    const fromProcessInfo = await getTabIdsForProcess(processId);
    if (fromProcessInfo && fromProcessInfo.length > 0) {
      const affected = [];
      for (const tabId of fromProcessInfo) {
        const tab = tabsById.get(tabId);
        if (tab) {
          affected.push(tab);
        } else {
          try {
            affected.push(await chrome.tabs.get(tabId));
          } catch {
            affected.push({ id: tabId, url: undefined, title: undefined });
          }
        }
      }
      if (!affected.some((tab) => tab.id === primaryTab.id)) {
        affected.push(primaryTab);
      }
      return affected;
    }

    // Fallback: scan known tabs for the same process id.
    const affected = [primaryTab];
    const seen = new Set([primaryTab.id]);
    await runWithConcurrency(allTabs || [], DEFAULT_CONCURRENCY, async (tab) => {
      if (!tab?.id || seen.has(tab.id) || isBuiltInPage(tab.url)) return;
      try {
        const pid = await chrome.processes.getProcessIdForTab(tab.id);
        if (pid === processId) {
          seen.add(tab.id);
          affected.push(tab);
        }
      } catch {
        // Ignore tabs that cannot be inspected.
      }
    });
    return affected;
  }

  function buildStoredEntries(tabs) {
    const entries = {};
    for (const tab of tabs || []) {
      if (tab?.id == null) continue;
      entries[String(tab.id)] = storedInfoFromTab(tab);
    }
    return entries;
  }

  /**
   * Terminate a tab's renderer process and mark all tabs sharing that process.
   * @param {chrome.tabs.Tab} tab
   * @param {{
   *   prefixTitle?: boolean,
   *   maybeHasActiveTabAccess?: boolean,
   *   allTabs?: chrome.tabs.Tab[],
   *   terminatedStorage?: ReturnType<typeof AutoEndRules.getTerminatedTabsStorage>,
   * }} [options]
   */
  async function terminateTabProcess(tab, options = {}) {
    const {
      prefixTitle = true,
      maybeHasActiveTabAccess = false,
      allTabs = null,
      terminatedStorage = AutoEndRules.getTerminatedTabsStorage(),
    } = options;

    if (!chrome.processes) {
      const err = new Error('chrome.processes API is not available');
      err.code = 'PROCESSES_UNAVAILABLE';
      throw err;
    }
    if (!tab?.id) {
      throw new Error('Invalid tab');
    }
    if (isBuiltInPage(tab.url)) {
      const err = new Error('Cannot terminate built-in pages');
      err.code = 'BUILT_IN_PAGE';
      throw err;
    }

    if (prefixTitle && typeof prefixTabTitleWithMarker === 'function') {
      await prefixTabTitleWithMarker(tab.id, tab.url, { maybeHasActiveTabAccess });
    }

    const tabsSnapshot = allTabs || (await chrome.tabs.query({}));
    let processId = null;
    let processAlreadyGone = false;

    try {
      processId = await chrome.processes.getProcessIdForTab(tab.id);
    } catch (err) {
      if (isProcessNotFoundError(err)) {
        processAlreadyGone = true;
      } else {
        throw err;
      }
    }

    let affectedTabs;
    if (processAlreadyGone) {
      affectedTabs = [tab];
    } else {
      affectedTabs = await resolveAffectedTabs(tab, processId, tabsSnapshot);
      const success = await chrome.processes.terminate(processId);
      if (!success) {
        // false may mean protected process, or process already exiting.
        try {
          await chrome.processes.getProcessIdForTab(tab.id);
          const err = new Error('Unable to terminate process');
          err.code = 'TERMINATE_FAILED';
          throw err;
        } catch (probeErr) {
          if (probeErr?.code === 'TERMINATE_FAILED') throw probeErr;
          if (!isProcessNotFoundError(probeErr)) throw probeErr;
          // Process gone after false — treat as terminated.
        }
      }
    }

    const storedEntries = buildStoredEntries(affectedTabs);
    await terminatedStorage.setEntries(storedEntries);

    return {
      ok: true,
      processId,
      processAlreadyGone,
      terminatedTabIds: affectedTabs.map((t) => t.id),
      affectedTabs,
      storedEntries,
    };
  }

  /**
   * Detect tabs whose process is already gone and batch-mark them terminated.
   * @param {chrome.tabs.Tab[]} tabs
   * @param {Record<string, unknown>} alreadyTerminated
   * @param {ReturnType<typeof AutoEndRules.getTerminatedTabsStorage>} [terminatedStorage]
   */
  async function reconcileDeadTabs(tabs, alreadyTerminated = {}, terminatedStorage) {
    const storage = terminatedStorage || AutoEndRules.getTerminatedTabsStorage();
    if (!chrome.processes) {
      return { ...alreadyTerminated };
    }

    const liveCandidates = (tabs || []).filter(
      (tab) =>
        tab?.id &&
        !alreadyTerminated[String(tab.id)] &&
        !isBuiltInPage(tab.url)
    );

    const newlyDead = {};
    await runWithConcurrency(liveCandidates, DEFAULT_CONCURRENCY, async (tab) => {
      try {
        await chrome.processes.getProcessIdForTab(tab.id);
      } catch (err) {
        if (isProcessNotFoundError(err)) {
          newlyDead[String(tab.id)] = storedInfoFromTab(tab);
        }
      }
    });

    if (Object.keys(newlyDead).length > 0) {
      await storage.setEntries(newlyDead);
    }

    return { ...alreadyTerminated, ...newlyDead };
  }

  /**
   * Terminate many tabs; dedupes by process id and writes storage once per batch group.
   * @param {chrome.tabs.Tab[]} tabs
   * @param {{
   *   prefixTitle?: boolean,
   *   concurrency?: number,
   *   allTabs?: chrome.tabs.Tab[],
   *   terminatedStorage?: ReturnType<typeof AutoEndRules.getTerminatedTabsStorage>,
   *   onItemDone?: (result: object) => void,
   * }} [options]
   */
  async function terminateTabsBatch(tabs, options = {}) {
    const {
      prefixTitle = false,
      concurrency = DEFAULT_CONCURRENCY,
      allTabs = null,
      terminatedStorage = AutoEndRules.getTerminatedTabsStorage(),
      onItemDone = null,
    } = options;

    if (!chrome.processes) {
      const err = new Error('chrome.processes API is not available');
      err.code = 'PROCESSES_UNAVAILABLE';
      throw err;
    }

    const tabsSnapshot = allTabs || (await chrome.tabs.query({}));
    const candidates = (tabs || []).filter((tab) => tab?.id && !isBuiltInPage(tab.url));
    if (candidates.length === 0) {
      return { terminatedTabIds: [], storedEntries: {}, results: [] };
    }

    // Resolve process ids first (limited concurrency).
    const tabMeta = await runWithConcurrency(candidates, concurrency, async (tab) => {
      try {
        const processId = await chrome.processes.getProcessIdForTab(tab.id);
        return { tab, processId, dead: false };
      } catch (err) {
        if (isProcessNotFoundError(err)) {
          return { tab, processId: null, dead: true };
        }
        return { tab, processId: null, dead: false, error: err };
      }
    });

    const storedEntries = {};
    const terminatedTabIds = [];
    const results = [];
    const terminatedProcessIds = new Set();

    // Already-dead tabs: mark without terminate.
    for (const meta of tabMeta) {
      if (!meta || meta.error) {
        if (meta?.error) {
          results.push({ tab: meta.tab, ok: false, error: meta.error });
        }
        continue;
      }
      if (meta.dead) {
        const entry = storedInfoFromTab(meta.tab);
        storedEntries[String(meta.tab.id)] = entry;
        terminatedTabIds.push(meta.tab.id);
        results.push({
          tab: meta.tab,
          ok: true,
          processAlreadyGone: true,
          terminatedTabIds: [meta.tab.id],
          storedEntries: { [String(meta.tab.id)]: entry },
        });
      }
    }

    // Group live tabs by process id.
    const byProcess = new Map();
    for (const meta of tabMeta) {
      if (!meta || meta.dead || meta.error || meta.processId == null) continue;
      if (!byProcess.has(meta.processId)) byProcess.set(meta.processId, []);
      byProcess.get(meta.processId).push(meta.tab);
    }

    const processGroups = Array.from(byProcess.entries());
    await runWithConcurrency(processGroups, concurrency, async ([processId, groupTabs]) => {
      if (terminatedProcessIds.has(processId)) return;
      terminatedProcessIds.add(processId);

      const primary = groupTabs[0];
      try {
        if (prefixTitle && typeof prefixTabTitleWithMarker === 'function') {
          // Only prefix the primary tab for speed when batching.
          await prefixTabTitleWithMarker(primary.id, primary.url, {
            maybeHasActiveTabAccess: !!primary.active,
          });
        }

        const affectedTabs = await resolveAffectedTabs(primary, processId, tabsSnapshot);
        const success = await chrome.processes.terminate(processId);
        if (!success) {
          try {
            await chrome.processes.getProcessIdForTab(primary.id);
            throw Object.assign(new Error('Unable to terminate process'), {
              code: 'TERMINATE_FAILED',
            });
          } catch (probeErr) {
            if (probeErr?.code === 'TERMINATE_FAILED') throw probeErr;
            if (!isProcessNotFoundError(probeErr)) throw probeErr;
          }
        }

        const entries = buildStoredEntries(affectedTabs);
        Object.assign(storedEntries, entries);
        for (const tab of affectedTabs) {
          if (tab?.id != null) terminatedTabIds.push(tab.id);
        }

        const result = {
          tab: primary,
          ok: true,
          processId,
          terminatedTabIds: affectedTabs.map((t) => t.id),
          storedEntries: entries,
          affectedTabs,
        };
        results.push(result);
        if (onItemDone) onItemDone(result);
      } catch (err) {
        if (isProcessNotFoundError(err)) {
          const entries = buildStoredEntries(groupTabs);
          Object.assign(storedEntries, entries);
          for (const tab of groupTabs) terminatedTabIds.push(tab.id);
          const result = {
            tab: primary,
            ok: true,
            processAlreadyGone: true,
            terminatedTabIds: groupTabs.map((t) => t.id),
            storedEntries: entries,
          };
          results.push(result);
          if (onItemDone) onItemDone(result);
        } else {
          results.push({ tab: primary, ok: false, error: err });
          if (onItemDone) onItemDone({ tab: primary, ok: false, error: err });
        }
      }
    });

    if (Object.keys(storedEntries).length > 0) {
      await terminatedStorage.setEntries(storedEntries);
    }

    return {
      terminatedTabIds: [...new Set(terminatedTabIds)],
      storedEntries,
      results,
    };
  }

  globalThis.EndTaskCore = {
    DEFAULT_CONCURRENCY,
    buildStoredEntries,
    isBuiltInPage,
    isProcessNotFoundError,
    reconcileDeadTabs,
    runWithConcurrency,
    storedInfoFromTab,
    terminateTabProcess,
    terminateTabsBatch,
  };
})();
