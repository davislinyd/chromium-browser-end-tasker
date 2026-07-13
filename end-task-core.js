/**
 * Shared End Task helpers for popup and service worker.
 * Depends on: AutoEndRules, prefixTabTitleWithMarker (optional for prefix).
 */
(function () {
  const DEFAULT_CONCURRENCY = 4;
  /** Bound slow / hung Edge processes APIs so batch End Task cannot stall forever. */
  const PROCESS_API_TIMEOUT_MS = 2500;
  const RESOLVE_AFFECTED_TIMEOUT_MS = 400;
  const PREFIX_SINGLE_MS = 1000;
  const PREFIX_BATCH_PER_TAB_MS = 350;
  const PREFIX_BATCH_GROUP_MS = 700;
  const PROBE_STATE_ALIVE = 'alive';
  const PROBE_STATE_DEAD = 'dead';
  const PROBE_STATE_UNKNOWN = 'unknown';

  function isBuiltInPage(url) {
    return (
      url?.startsWith('chrome://') ||
      url?.startsWith('brave://') ||
      url?.startsWith('edge://')
    );
  }

  function isProcessNotFoundError(err) {
    const message = String(err?.message || err || '').toLowerCase();
    return (
      message.includes('process not found') ||
      message.includes('no process') ||
      message.includes('invalid process') ||
      message.includes('could not find')
    );
  }

  function storedInfoFromTab(tab) {
    return {
      url: tab?.url,
      title: tab?.title,
    };
  }

  function normalizeProcessId(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${label || 'Operation'} timed out`);
        err.code = 'TIMEOUT';
        reject(err);
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer != null) clearTimeout(timer);
    });
  }

  /**
   * Call chrome.processes methods with Promise + callback fallback (Edge Dev).
   * Some builds only settle via callback when a completion arg is provided.
   */
  function callProcessesMethod(methodName, args = []) {
    const fn = chrome.processes?.[methodName];
    if (typeof fn !== 'function') {
      return Promise.reject(new Error(`chrome.processes.${methodName} is not available`));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve(value);
      };

      let ret;
      try {
        ret = fn.call(chrome.processes, ...args, (value) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError) {
            finish(new Error(lastError.message));
          } else {
            finish(null, value);
          }
        });
      } catch (err) {
        // Method may reject a trailing callback argument — retry without it.
        try {
          ret = fn.call(chrome.processes, ...args);
        } catch (err2) {
          finish(err2);
          return;
        }
      }

      if (ret != null && typeof ret.then === 'function') {
        ret.then(
          (value) => finish(null, value),
          (err) => finish(err)
        );
      }
    });
  }

  async function getProcessIdForTab(tabId) {
    const raw = await withTimeout(
      callProcessesMethod('getProcessIdForTab', [tabId]),
      PROCESS_API_TIMEOUT_MS,
      'getProcessIdForTab'
    );
    return normalizeProcessId(raw);
  }

  async function terminateProcess(processId) {
    const id = normalizeProcessId(processId);
    if (id == null) {
      const err = new Error('Invalid process id');
      err.code = 'TERMINATE_FAILED';
      throw err;
    }
    return withTimeout(
      callProcessesMethod('terminate', [id]),
      PROCESS_API_TIMEOUT_MS,
      'terminate'
    );
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
    const id = normalizeProcessId(processId);
    if (id == null || typeof chrome.processes?.getProcessInfo !== 'function') {
      return null;
    }

    try {
      const info = await withTimeout(
        callProcessesMethod('getProcessInfo', [id, false]),
        RESOLVE_AFFECTED_TIMEOUT_MS,
        'getProcessInfo'
      );
      const processInfo = info?.[id] ?? info?.[String(id)];
      if (processInfo && Array.isArray(processInfo.tabs)) {
        return processInfo.tabs.map((tabId) => Number(tabId)).filter((n) => Number.isFinite(n));
      }
    } catch {
      // Fall through — caller uses known tabs.
    }
    return null;
  }

  function mergeTabsById(...tabLists) {
    const map = new Map();
    for (const list of tabLists) {
      for (const tab of list || []) {
        if (tab?.id != null) map.set(tab.id, tab);
      }
    }
    return Array.from(map.values());
  }

  async function resolveAffectedTabs(primaryTab, processId, allTabs, knownTabs = null) {
    const base =
      knownTabs && knownTabs.length > 0
        ? mergeTabsById(knownTabs, primaryTab ? [primaryTab] : [])
        : primaryTab
          ? [primaryTab]
          : [];

    const tabsById = new Map();
    for (const tab of allTabs || []) {
      if (tab?.id != null) tabsById.set(tab.id, tab);
    }
    for (const tab of base) {
      if (tab?.id != null) tabsById.set(tab.id, tab);
    }

    try {
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
        return mergeTabsById(base, affected);
      }
    } catch {
      // Use base / scan fallback.
    }

    // Fallback: scan known tabs for the same process id (bounded).
    const affected = [...base];
    const seen = new Set(base.map((tab) => tab.id).filter((id) => id != null));
    const normalizedTarget = normalizeProcessId(processId);
    const scanTargets = (allTabs || []).filter(
      (tab) => tab?.id && !seen.has(tab.id) && !isBuiltInPage(tab.url)
    );

    await runWithConcurrency(scanTargets, DEFAULT_CONCURRENCY, async (tab) => {
      try {
        const pid = await getProcessIdForTab(tab.id);
        if (pid != null && pid === normalizedTarget) {
          seen.add(tab.id);
          affected.push(tab);
        }
      } catch {
        // Ignore tabs that cannot be inspected.
      }
    });
    return affected;
  }

  /**
   * Resolve co-process tabs without blocking terminate on a hung processes API.
   */
  async function resolveAffectedTabsBounded(primaryTab, processId, allTabs, knownTabs) {
    try {
      const resolved = await Promise.race([
        resolveAffectedTabs(primaryTab, processId, allTabs, knownTabs),
        new Promise((resolve) => {
          setTimeout(() => resolve(null), RESOLVE_AFFECTED_TIMEOUT_MS);
        }),
      ]);
      if (resolved && resolved.length > 0) {
        return mergeTabsById(knownTabs || [], primaryTab ? [primaryTab] : [], resolved);
      }
    } catch {
      // fall through
    }
    return mergeTabsById(knownTabs || [], primaryTab ? [primaryTab] : []);
  }

  function buildStoredEntries(tabs) {
    const entries = {};
    for (const tab of tabs || []) {
      if (tab?.id == null) continue;
      entries[String(tab.id)] = storedInfoFromTab(tab);
    }
    return entries;
  }

  async function ensureTerminated(processId, probeTabId) {
    const success = await terminateProcess(processId);
    if (success) return;

    // false may mean protected process, or process already exiting.
    const state = await probeTabProcess(probeTabId);
    if (state === PROBE_STATE_DEAD || state === PROBE_STATE_UNKNOWN) {
      // Gone or ambiguous after false — treat as terminated.
      return;
    }
    const err = new Error('Unable to terminate process');
    err.code = 'TERMINATE_FAILED';
    throw err;
  }

  /**
   * Best-effort title prefix before kill. Never throws; bounded wait.
   * @param {chrome.tabs.Tab[]} tabs
   * @param {{ perTabMs?: number, totalMs?: number }} [options]
   */
  async function prefixTabsBestEffort(tabs, options = {}) {
    if (typeof prefixTabTitleWithMarker !== 'function') return;
    const list = (tabs || []).filter((tab) => tab?.id && !isBuiltInPage(tab.url));
    if (list.length === 0) return;

    const perTabMs = options.perTabMs ?? PREFIX_BATCH_PER_TAB_MS;
    const totalMs = options.totalMs ?? PREFIX_BATCH_GROUP_MS;

    const work = Promise.all(
      list.map((tab) =>
        Promise.race([
          prefixTabTitleWithMarker(tab.id, tab.url, {
            maybeHasActiveTabAccess: !!tab.active,
          }),
          sleep(perTabMs),
        ]).catch(() => {})
      )
    );

    await Promise.race([work, sleep(totalMs)]).catch(() => {});
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

    if (prefixTitle) {
      await prefixTabsBestEffort(
        [{ ...tab, active: maybeHasActiveTabAccess || !!tab.active }],
        { perTabMs: PREFIX_SINGLE_MS, totalMs: PREFIX_SINGLE_MS }
      );
    }

    const tabsSnapshot = allTabs || (await chrome.tabs.query({}));
    let processId = null;
    let processAlreadyGone = false;

    try {
      processId = await getProcessIdForTab(tab.id);
      if (processId == null) {
        const err = new Error('No process id for tab');
        err.code = 'TERMINATE_FAILED';
        throw err;
      }
    } catch (err) {
      if (isProcessNotFoundError(err)) {
        processAlreadyGone = true;
      } else if (err?.code === 'TIMEOUT') {
        const err2 = new Error('Unable to resolve process for tab');
        err2.code = 'TERMINATE_FAILED';
        throw err2;
      } else {
        throw err;
      }
    }

    let affectedTabs;
    if (processAlreadyGone) {
      affectedTabs = [tab];
    } else {
      // Terminate first; resolve sibling tabs after so hung processInfo cannot block kill.
      await ensureTerminated(processId, tab.id);
      affectedTabs = await resolveAffectedTabsBounded(tab, processId, tabsSnapshot, [tab]);
    }

    /**
     * After a successful kill, always mark the primary tab terminated.
     * Edge often still returns a process id briefly (or an error-page renderer),
     * so filtering on "alive" right after terminate left the popup stuck on
     * "End Task" until a second click saw Process-not-found.
     * Markers stay until explicit Restore / Restore All (error-page processes
     * still look "alive" and must not auto-clear the terminated flag).
     */
    const storedEntries = buildStoredEntries(affectedTabs);
    storedEntries[String(tab.id)] = storedInfoFromTab(tab);

    // Co-process siblings only: drop confirmed-alive (primary always kept above).
    for (const sibling of affectedTabs || []) {
      if (!sibling?.id || sibling.id === tab.id) continue;
      const state = await probeTabProcess(sibling.id);
      if (state === PROBE_STATE_ALIVE) {
        delete storedEntries[String(sibling.id)];
      }
    }

    const deadIds = Object.keys(storedEntries).map((id) => Number(id));
    const deadTabs = (affectedTabs || [tab]).filter((t) => deadIds.includes(t.id));
    if (deadIds.includes(tab.id) && !deadTabs.some((t) => t.id === tab.id)) {
      deadTabs.push(tab);
    }

    if (Object.keys(storedEntries).length > 0) {
      await terminatedStorage.setEntries(storedEntries);
    }

    return {
      ok: true,
      processId,
      processAlreadyGone,
      terminatedTabIds: deadIds,
      affectedTabs: deadTabs,
      storedEntries,
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Probe whether a tab's renderer process is alive.
   * @param {number} tabId
   * @returns {Promise<'alive'|'dead'|'unknown'>}
   */
  async function probeTabProcess(tabId) {
    if (!chrome.processes || tabId == null) return PROBE_STATE_UNKNOWN;
    try {
      const processId = await getProcessIdForTab(tabId);
      return processId != null ? PROBE_STATE_ALIVE : PROBE_STATE_DEAD;
    } catch (err) {
      if (isProcessNotFoundError(err)) return PROBE_STATE_DEAD;
      return PROBE_STATE_UNKNOWN;
    }
  }

  /**
   * @param {number} tabId
   * @returns {Promise<boolean>} true only when process is confirmed alive
   */
  async function isTabProcessAlive(tabId) {
    return (await probeTabProcess(tabId)) === PROBE_STATE_ALIVE;
  }

  /**
   * Keep entries that are dead or unknown. Drop only confirmed-alive tabs
   * (failed kill or instant browser revive).
   */
  async function retainDeadTabEntries(entries) {
    const source =
      entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
    const ids = Object.keys(source);
    if (ids.length === 0) return {};

    const kept = {};
    await runWithConcurrency(ids, DEFAULT_CONCURRENCY, async (id) => {
      const state = await probeTabProcess(Number(id));
      if (state !== PROBE_STATE_ALIVE) kept[id] = source[id];
    });
    return kept;
  }

  /**
   * Classify tabs by process state after batch operations.
   * @param {chrome.tabs.Tab[]|number[]} tabsOrIds
   */
  async function verifyTabProcessStates(tabsOrIds) {
    const ids = [];
    for (const item of tabsOrIds || []) {
      const id = typeof item === 'number' ? item : item?.id;
      if (id != null && Number.isFinite(Number(id))) ids.push(Number(id));
    }
    const deadIds = [];
    const aliveIds = [];
    const unknownIds = [];
    await runWithConcurrency(ids, DEFAULT_CONCURRENCY, async (tabId) => {
      const state = await probeTabProcess(tabId);
      if (state === PROBE_STATE_ALIVE) aliveIds.push(tabId);
      else if (state === PROBE_STATE_DEAD) deadIds.push(tabId);
      else unknownIds.push(tabId);
    });
    return { deadIds, aliveIds, unknownIds };
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
        const processId = await getProcessIdForTab(tab.id);
        if (processId == null) {
          newlyDead[String(tab.id)] = storedInfoFromTab(tab);
        }
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
   * Clear terminated markers for tabs whose renderer process is alive again
   * (user clicked tab / browser auto-reloaded after End Task).
   * @param {chrome.tabs.Tab[] | number[]} tabsOrIds
   * @param {Record<string, unknown>} alreadyTerminated
   * @param {ReturnType<typeof AutoEndRules.getTerminatedTabsStorage>} [terminatedStorage]
   * @returns {Promise<Record<string, unknown>>} remaining terminated map
   */
  async function reconcileRevivedTabs(
    tabsOrIds,
    alreadyTerminated = {},
    terminatedStorage
  ) {
    const storage = terminatedStorage || AutoEndRules.getTerminatedTabsStorage();
    const current =
      alreadyTerminated && typeof alreadyTerminated === 'object'
        ? { ...alreadyTerminated }
        : {};

    const candidateIds = [];
    if (Array.isArray(tabsOrIds)) {
      for (const item of tabsOrIds) {
        const id = typeof item === 'number' ? item : item?.id;
        if (id == null) continue;
        if (current[String(id)]) candidateIds.push(Number(id));
      }
    }

    // Also probe every id still marked terminated if list was empty of matches.
    if (candidateIds.length === 0) {
      for (const id of Object.keys(current)) {
        const n = Number(id);
        if (Number.isFinite(n)) candidateIds.push(n);
      }
    }

    if (candidateIds.length === 0 || !chrome.processes) {
      return current;
    }

    const revivedIds = [];
    await runWithConcurrency(candidateIds, DEFAULT_CONCURRENCY, async (tabId) => {
      if (!current[String(tabId)]) return;
      if (await isTabProcessAlive(tabId)) {
        revivedIds.push(tabId);
      }
    });

    if (revivedIds.length > 0) {
      await storage.removeEntries(revivedIds);
      for (const tabId of revivedIds) {
        delete current[String(tabId)];
      }
    }

    return current;
  }

  /**
   * If this tab is marked terminated but its process is live, clear the marker.
   * @returns {Promise<boolean>} true if cleared
   */
  async function clearTerminatedIfAlive(tabId, terminatedStorage) {
    if (tabId == null) return false;
    const storage = terminatedStorage || AutoEndRules.getTerminatedTabsStorage();
    const all = await storage.getAll();
    if (!all[String(tabId)]) return false;
    // Only clear on confirmed alive — unknown keeps the marker.
    if ((await probeTabProcess(tabId)) !== PROBE_STATE_ALIVE) return false;
    await storage.removeEntry(tabId);
    return true;
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
        const processId = await getProcessIdForTab(tab.id);
        if (processId == null) {
          return {
            tab,
            processId: null,
            dead: false,
            error: Object.assign(new Error('No process id for tab'), {
              code: 'TERMINATE_FAILED',
            }),
          };
        }
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

    // Group live tabs by process id (normalized number key).
    const byProcess = new Map();
    for (const meta of tabMeta) {
      if (!meta || meta.dead || meta.error || meta.processId == null) continue;
      const processId = normalizeProcessId(meta.processId);
      if (processId == null) continue;
      if (!byProcess.has(processId)) byProcess.set(processId, []);
      byProcess.get(processId).push(meta.tab);
    }

    // Terminate sequentially per process. Concurrent terminate + processInfo has hung on Edge Dev.
    const processGroups = Array.from(byProcess.entries());
    for (const [processId, groupTabs] of processGroups) {
      const primary = groupTabs[0];
      try {
        // Prefix BEFORE kill — once the process is gone, scripting cannot set the title.
        if (prefixTitle) {
          await prefixTabsBestEffort(groupTabs, {
            perTabMs: PREFIX_BATCH_PER_TAB_MS,
            totalMs: PREFIX_BATCH_GROUP_MS,
          });
        }

        await ensureTerminated(processId, primary.id);

        const affectedTabs = await resolveAffectedTabsBounded(
          primary,
          processId,
          tabsSnapshot,
          groupTabs
        );

        // Always mark the whole group after successful terminate (same as single-tab).
        // Edge often still reports a process id / error-page renderer immediately after
        // kill — filtering those as "alive" caused empty terminatedTabIds, false
        // failure alerts, and Restore All finding nothing.
        const entries = buildStoredEntries(
          affectedTabs?.length ? affectedTabs : groupTabs
        );
        for (const t of groupTabs) {
          if (t?.id != null) entries[String(t.id)] = storedInfoFromTab(t);
        }

        Object.assign(storedEntries, entries);
        for (const id of Object.keys(entries)) {
          terminatedTabIds.push(Number(id));
        }

        if (globalThis.DebugLog) {
          globalThis.DebugLog.info('terminateTabsBatch group ok', {
            processId,
            tabIds: Object.keys(entries),
          });
        }

        const result = {
          tab: primary,
          ok: true,
          processId,
          terminatedTabIds: Object.keys(entries).map((id) => Number(id)),
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
          if (globalThis.DebugLog) {
            globalThis.DebugLog.error('terminateTabsBatch group fail', {
              processId,
              message: String(err?.message || err),
              code: err?.code,
            });
          }
          results.push({ tab: primary, ok: false, error: err });
          if (onItemDone) onItemDone({ tab: primary, ok: false, error: err });
        }
      }
    }

    const finalTerminatedIds = [...new Set(terminatedTabIds.filter((id) => id != null))];
    const finalEntries = {};
    for (const id of finalTerminatedIds) {
      const key = String(id);
      if (storedEntries[key]) finalEntries[key] = storedEntries[key];
    }

    if (Object.keys(finalEntries).length > 0) {
      await terminatedStorage.setEntries(finalEntries);
    }

    if (globalThis.DebugLog) {
      globalThis.DebugLog.info('terminateTabsBatch done', {
        terminatedCount: finalTerminatedIds.length,
        ok: results.filter((r) => r?.ok).length,
        fail: results.filter((r) => r && !r.ok).length,
      });
    }

    return {
      terminatedTabIds: finalTerminatedIds,
      storedEntries: finalEntries,
      results,
    };
  }

  globalThis.EndTaskCore = {
    DEFAULT_CONCURRENCY,
    PROBE_STATE_ALIVE,
    PROBE_STATE_DEAD,
    PROBE_STATE_UNKNOWN,
    buildStoredEntries,
    clearTerminatedIfAlive,
    isBuiltInPage,
    isProcessNotFoundError,
    isTabProcessAlive,
    prefixTabsBestEffort,
    probeTabProcess,
    reconcileDeadTabs,
    reconcileRevivedTabs,
    retainDeadTabEntries,
    runWithConcurrency,
    storedInfoFromTab,
    terminateTabProcess,
    terminateTabsBatch,
    verifyTabProcessStates,
  };
})();
