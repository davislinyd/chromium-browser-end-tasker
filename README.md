# Chromium Browser End Tasker

Chromium 系瀏覽器專用。一鍵終止分頁 process，釋放記憶體與 CPU 資源。等同於 Chrome Task Manager 的 End Task 功能。

## 功能

### 終止與恢復分頁

- **End Task**：終止選定分頁的 process，釋放記憶體與 CPU
- **Restore**：恢復已終止的分頁（會重新載入該頁面）
- **End Task All**：一次終止目前視窗中所有可操作分頁（包含作用中分頁）
- **Restore All**：一次恢復目前視窗中所有已終止的分頁
- **快捷鍵**終止當前分頁後，狀態會與 popup 同步（可 Restore）

終止 **http / https / file（本地 HTML）** 分頁前（手動、快捷鍵、**End Task All**），擴充功能會在 process 仍存活時 best-effort 於 `document.title` 前加上 ♻️，方便在分頁列辨識；**Restore** 或瀏覽器自動復活後標題會恢復。注入有短逾時，失敗不阻擋終止。若未授予站點／檔案存取權、或屬保護頁面，則跳過前綴但仍終止 process。**自動 End Task** 為減少延遲與喚醒閒置頁，不會注入 ♻️。

**本地 `file://` 檔案：** 需在 `chrome://extensions`（或 `edge://extensions`）→ 本擴充功能「詳細資料」中開啟 **「允許存取檔案網址」／Allow access to file URLs**，非作用中分頁才能穩定注入標題前綴；對目前作用中分頁，透過點擊工具列圖示開啟 popup 時，`activeTab` 通常已足夠。

**End Task All 部分成功：** 列表會依實際 process 狀態重載；僅在完全無法終止時才跳出錯誤。已終止與仍存活的分頁會分開顯示（Restore / End Task）。

**共用 process：** Chromium 可能讓多個分頁共用同一個 renderer process。End Task 是 process 級操作（與 Task Manager 相同），因此終止一個分頁時，同 process 的其他分頁也會一併結束，並在列表中一併標記為已終止。

**已終止狀態：** End Task 後列表會顯示 Restore，直到你按 **Restore / Restore All**（或關閉該分頁）。不會因為錯誤頁仍有 process 就自動清掉標記（否則 Restore All 會找不到目標）。

### 自動 End Task

- 啟用後，閒置超過指定分鐘數的分頁會自動被終止
- 可設定預設閒置時間（1–120 分鐘）
- 可為不同的 `domain`、`FQDN` 或 `URL` 設定不同規則
- 站點規則可設定為 **Never Close** 或指定分鐘數後自動 End Task
- 可直接在 popup 的分頁列為單一 tab 設定 **預設**、**Never Close** 或 **自訂閒置分鐘**
- 分頁級設定優先於站點規則與全域預設
- 啟用時每分鐘檢查一次；關閉自動 End Task 後會停止定時 alarm，避免無謂喚醒
- **Never Close**（分頁或站點規則）會略過 **自動 End Task** 與 **End Task All**；單一分頁手動 `End Task` 仍可強制終止
- popup 底部 **除錯 Log** 預設收合；展開可檢視全文，並可複製或清除

### 快捷鍵

- **終止當前分頁**：`Cmd+E`（macOS）/ `Ctrl+E`（Windows、Linux）— 預設
- **開啟擴充功能**：無預設，請至 `chrome://extensions/shortcuts` 或 `edge://extensions/shortcuts` 自行設定（如 `Cmd+Shift+E`，部分瀏覽器可能保留此組合）

### 操作方式

- 點擊工具列圖示開啟 popup，選擇分頁後按「End Task」
- 使用快捷鍵終止當前分頁
- popup 內可設定自動 End Task、預設閒置分鐘數、站點規則，以及單一分頁的 Never Close / 自訂閒置

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

本擴充功能另需 **`scripting`**、**`activeTab`** 與 **`http://*/*`、`https://*/*`、`file:///*` 主機權限**，才能在終止前修改分頁標題（僅於執行 End Task 時注入，不讀取網頁內容）。本機檔案另需使用者開啟「允許存取檔案網址」。舊版白名單會在首次載入新版時自動遷移成站點規則。

## 自訂快捷鍵

前往 `chrome://extensions/shortcuts`（Chrome）或 `edge://extensions/shortcuts`（Edge）可自訂：

- **Activate the extension**：開啟擴充功能 popup
- **終止當前分頁的 process**：終止目前分頁

## 專案結構

```
├── manifest.json       # 擴充功能設定
├── auto-end-rules.js   # 自動 End Task 規則、遷移與共享 storage helper
├── end-task-core.js    # 共用 terminate／批次／死分頁校正邏輯
├── debug-log.js        # popup 除錯 log（可複製）
├── popup.html          # popup 介面
├── popup.js            # popup 邏輯
├── popup.css           # popup 樣式
├── background.js       # Service Worker（快捷鍵、自動 End Task）
├── prefix-tab-title.js # 終止前為分頁標題加上 ♻️ 前綴
├── icons/              # 圖示
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── test-load/          # 載入測試用（無 processes API，用於偵錯）
│   ├── manifest.json
│   ├── background.js
│   └── popup.html
└── README.md
```
