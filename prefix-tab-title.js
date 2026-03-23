const TITLE_PREFIX_END = '\uD83D\uDD1A ';

/**
 * 在終止 process 前於分頁將 document.title 加上 END 符號前綴（僅 http/https）。
 * 注入失敗不拋錯，不阻擋後續 terminate。
 * @param {number} tabId
 * @param {string|undefined} [url] 若已持有 tab.url 可傳入以避免多一次 tabs.get
 */
async function prefixTabTitleWithEndMarker(tabId, url) {
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
      args: [TITLE_PREFIX_END],
    });
  } catch (err) {
    console.warn('prefixTabTitleWithEndMarker failed:', err);
  }
}
