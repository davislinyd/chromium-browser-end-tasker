# Chromium Browser End Tasker

Chromium 系瀏覽器專用。一鍵終止分頁 process，釋放記憶體與 CPU 資源。等同於 Chrome Task Manager 的 End Task 功能。

## 功能

### 終止與恢復分頁

- **End Task**：終止選定分頁的 process，釋放記憶體與 CPU
- **Restore**：恢復已終止的分頁（會重新載入該頁面）
- **End Task All**：一次終止所有非作用中分頁
- **Restore All**：一次恢復所有已終止的分頁

終止 **http / https** 分頁前，擴充功能會嘗試在該頁的 `document.title` 前加上 💤，方便在分頁列辨識已 End Task 的分頁；**Restore** 重新載入後標題會恢復為網站標題。無法注入腳本的頁面仍會照常終止 process，但分頁列可能沒有前綴。

### 自動 End Task

- 啟用後，閒置超過指定分鐘數的分頁會自動被終止
- 可設定閒置時間（1–120 分鐘）
- 每分鐘檢查一次
- 白名單：可排除特定網站，使其不受自動終止影響

### 快捷鍵

- **終止當前分頁**：`Cmd+E`（macOS）/ `Ctrl+E`（Windows、Linux）— 預設
- **開啟擴充功能**：無預設，請至 `chrome://extensions/shortcuts` 或 `edge://extensions/shortcuts` 自行設定（如 `Cmd+Shift+E`，部分瀏覽器可能保留此組合）

### 操作方式

- 點擊工具列圖示開啟 popup，選擇分頁後按「End Task」
- 使用快捷鍵終止當前分頁
- popup 內可設定自動 End Task、閒置分鐘數與白名單

## 安裝方式

### Chrome Dev

1. 安裝 [Chrome Dev](https://www.google.com/chrome/dev/)
2. 前往 `chrome://extensions`
3. 開啟右上角「開發人員模式」
4. 點擊「載入未封裝項目」
5. 選擇本專案資料夾

### Edge Dev

1. 安裝 [Edge Dev](https://www.microsoft.com/edge/download/insider)
2. 前往 `edge://extensions`
3. 開啟「開發人員模式」
4. 點擊「載入未封裝項目」
5. 選擇本專案資料夾

## 相容性

- **Chrome Dev**：完整支援
- **Edge Dev**：完整支援
- **Chromium（開發版）**：若含 `chrome.processes` API 則支援
- **Chrome 穩定版 / Brave**：`chrome.processes` API 不支援，會顯示錯誤訊息，無法使用

本擴充功能另需 **`scripting`** 與 **`http://*/*`、`https://*/*` 主機權限**，才能在終止前修改分頁標題（僅於執行 End Task 時注入，不讀取網頁內容）。

## 自訂快捷鍵

前往 `chrome://extensions/shortcuts`（Chrome）或 `edge://extensions/shortcuts`（Edge）可自訂：

- **Activate the extension**：開啟擴充功能 popup
- **終止當前分頁的 process**：終止目前分頁

## 專案結構

```
├── manifest.json    # 擴充功能設定
├── popup.html       # popup 介面
├── popup.js         # popup 邏輯
├── popup.css        # popup 樣式
├── background.js       # Service Worker（快捷鍵、自動 End Task）
├── prefix-tab-title.js # 終止前為分頁標題加上 💤 前綴（僅 popup 載入；SW 內嵌相同邏輯）
├── icons/           # 圖示
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── test-load/       # 載入測試用（無 processes API，用於偵錯）
│   ├── manifest.json
│   ├── background.js
│   └── popup.html
└── README.md
```
