const TITLE_PREFIX_MARK = '\u267B\uFE0F ';
const RESTRICTED_HOST_RULES = [
  { host: 'chromewebstore.google.com' },
  { host: 'chrome.google.com', pathPrefix: '/webstore' },
  { host: 'microsoftedge.microsoft.com', pathPrefix: '/addons' },
];

function getScriptableOriginPattern(url) {
  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) return null;
    if (isRestrictedScriptingPage(parsedUrl)) return null;
    return `${parsedUrl.protocol}//${parsedUrl.host}/*`;
  } catch {
    return null;
  }
}

function isRestrictedScriptingPage(parsedUrl) {
  return RESTRICTED_HOST_RULES.some(
    ({ host, pathPrefix }) =>
      parsedUrl.hostname === host &&
      (pathPrefix === undefined || parsedUrl.pathname.startsWith(pathPrefix))
  );
}

async function hasHostAccess(originPattern) {
  if (!originPattern || !chrome.permissions?.contains) return true;

  try {
    return await chrome.permissions.contains({ origins: [originPattern] });
  } catch {
    return true;
  }
}

function isExpectedAccessError(err) {
  const message = String(err?.message || '');
  return (
    message.includes('Cannot access contents of the page') ||
    message.includes('Missing host permission for the tab') ||
    message.includes('The extensions gallery cannot be scripted')
  );
}

/**
 * 在終止 process 前於分頁將 document.title 加上 ♻️ 前綴（僅 http/https）。
 * 注入失敗不拋錯，不阻擋後續 terminate。
 * @param {number} tabId
 * @param {string|undefined} [url] 若已持有 tab.url 可傳入以避免多一次 tabs.get
 * @param {{ maybeHasActiveTabAccess?: boolean }} [options]
 */
async function prefixTabTitleWithMarker(tabId, url, options = {}) {
  if (!chrome.scripting) return;
  const { maybeHasActiveTabAccess = false } = options;

  let resolvedUrl = url;
  if (resolvedUrl === undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      resolvedUrl = tab.url;
    } catch {
      return;
    }
  }

  const originPattern = resolvedUrl ? getScriptableOriginPattern(resolvedUrl) : null;
  if (!originPattern) return;

  const canUseHostPermission = await hasHostAccess(originPattern);
  if (!canUseHostPermission && !maybeHasActiveTabAccess) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (prefix) => {
        const t = document.title || '';
        if (t.startsWith(prefix)) return;
        document.title = prefix + t;
      },
      args: [TITLE_PREFIX_MARK],
    });
  } catch (err) {
    if (isExpectedAccessError(err)) return;
    console.warn('prefixTabTitleWithMarker failed:', err);
  }
}
