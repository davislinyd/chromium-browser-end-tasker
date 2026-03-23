const TITLE_PREFIX_MARK = '\u267B\uFE0F ';

/**
 * 在終止 process 前於分頁將 document.title 加上 ♻️ 前綴（僅 http/https）。
 * 注入失敗不拋錯，不阻擋後續 terminate。
 * @param {number} tabId
 * @param {string|undefined} [url] 若已持有 tab.url 可傳入以避免多一次 tabs.get
 */
async function prefixTabTitleWithMarker(tabId, url) {
  if (!chrome.scripting) return;

  let resolvedUrl = url;
  if (resolvedUrl === undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      resolvedUrl = tab.url;
    } catch {
      return;
    }
  }

  if (
    !resolvedUrl ||
    (!resolvedUrl.startsWith('http://') && !resolvedUrl.startsWith('https://'))
  ) {
    return;
  }

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
    console.warn('prefixTabTitleWithMarker failed:', err);
  }
}
