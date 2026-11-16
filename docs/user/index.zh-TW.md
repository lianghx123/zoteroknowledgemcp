# Zotero Knowledge MCP

將選定的 Zotero PDF 附件轉換為可在本機檢索的知識庫。在 PDF 旁閱讀擷取的正文，按需修正文稿，並透過模型上下文協議（MCP）明確授權 AI 用戶端存取。

**目前版本：0.2.0-preview.1。** 需要 Zotero **10.0.x**。原生驗收使用 Windows 和 Zotero 10.0.6–10.0.8；macOS、Linux 的同等驗收仍待完成。預覽版目前採用手動安裝與升級。

[下載 XPI 外掛](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/zotero-knowledge-mcp.xpi){ .md-button .md-button--primary }
[SHA-256 驗證檔案](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/SHA256SUMS){ .md-button }

[發行說明與所有版本](https://github.com/lianghx123/zoteroknowledgemcp/releases)

目前下載：0.2.0-preview.1，適用於 Zotero 10.0.x。原始碼、釋出頁 XPI 和驗證檔案均已公開，無需 GitHub 帳號即可下載。

## 從這裡開始

1. 從釋出頁下載 XPI 並[安裝外掛](installation.md)。
2. 使用受支援的解析服務[處理第一篇文獻](quick-start.md)。
3. 如需基於模型的檢索，請[設定語意檢索](configuration.md)。
4. 如需外部工具檢索和閱讀，請[連線 AI 用戶端](mcp.md)。

普通使用者不需要 Node.js、npm、Python 或單獨的背景伺服器。解析和模型服務可能需要帳號、API 憑據及付費額度。

## 可以完成的任務

| 任務 | 指南 |
| --- | --- |
| 組織選定文獻並同步 Zotero 分類 | [知識庫](knowledge-libraries.md) |
| 使用文字或語意檢索查詢文獻與片段 | [檢索](search.md) |
| 閱讀 Markdown、檢視引文並儲存正文修正 | [閱讀與編輯](reader.md) |
| 授權本機 AI 用戶端存取知識庫 | [MCP 連線](mcp.md) |
| 瞭解外部請求、憑據與備份 | [資料與隱私](privacy.md) |
| 排查設定和處理問題 | [疑難排解](troubleshooting.md) |

## 預覽版範圍

Zotero 繼續管理原始文獻庫和附件。外掛在本機儲存派生內容，透過設定的外部服務執行解析、嵌入和可選的重排。目前不提供公網遠端 MCP、外掛雲同步、任意解析結果直接匯入或完整備份恢復工具。約 1,000 篇文獻的完整工作流程驗收仍待完成。

外掛作者：[lianghx123](https://github.com/lianghx123)。[原始碼與釋出版本](https://github.com/lianghx123/zoteroknowledgemcp)均可公開存取。
