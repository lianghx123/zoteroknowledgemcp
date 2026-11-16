# 連線 AI 用戶端

MCP 允許授權用戶端發現文獻、檢索片段、讀取結構化內容，並執行明確授權的批註或摘要寫入。外掛透過帶認證的 Streamable HTTP 提供 16 個工具，回應僅使用 SSE，不提供舊式獨立 HTTP+SSE 端點。

## 啟用存取

1. 開啟 **Zotero 設定 → Knowledge MCP → MCP 連線**。
2. 啟用本機 MCP 並套用設定。預設地址為 `http://127.0.0.1:23126/mcp/knowledge`，以設定中實際地址為準。
3. 建立具名權杖，明確選擇知識庫並授予用戶端需要的權限。檢索、讀取、批註寫入和摘要寫入具有獨立權限。
4. 立即複製權杖秘密值；它僅顯示一次，無法找回。
5. 在用戶端的遠端或 HTTP MCP 設定中填入地址和 Bearer 權杖。保持 Zotero 執行且電腦喚醒。

權杖有效期可選 30、90、180 或 365 天。編輯名稱、知識庫或權限不會改變秘密值和到期時間；不再需要時撤銷。撤銷適用於後續請求，也包括已有連線。

## Codex 示例

在啟動用戶端的環境中設定 `ZOTERO_KNOWLEDGE_MCP_TOKEN`，然後執行：

```sh
codex mcp add zotero-knowledge --url http://127.0.0.1:23126/mcp/knowledge --bearer-token-env-var ZOTERO_KNOWLEDGE_MCP_TOKEN
```

外掛設定中也提供地址和匹配指令的複製按鈕。修改連接埠後請同步調整 URL。環境變數的設定方式以用戶端文件為準，不要把權杖放進截圖、原始碼儲存庫或問題報告。

## 連線範圍

監聽器僅在 Zotero 執行時接受同機迴環存取。目前不支援公網 HTTPS、帳號遠端存取或中繼、雲連線。遠端雲用戶端不能直接存取本機迴環地址。授權用戶端可讀取權杖範圍內的資料，也可能將取回內容傳送給自己的模型服務。

工具結構及套用相容性詳見[開發者 MCP 參考](https://github.com/lianghx123/zoteroknowledgemcp/blob/main/docs/development/mcp.md)。
