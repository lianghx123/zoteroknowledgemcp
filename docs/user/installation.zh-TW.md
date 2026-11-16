# 安裝與升級

[下載 XPI 外掛](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/zotero-knowledge-mcp.xpi){ .md-button .md-button--primary }
[SHA-256 驗證檔案](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/SHA256SUMS){ .md-button }

[發行說明與所有版本](https://github.com/lianghx123/zoteroknowledgemcp/releases)

目前下載：0.2.0-preview.1，適用於 Zotero 10.0.x。儲存庫為私有時，請先登入具備存取權限的 GitHub 帳號；公開文件網站不會讓私有版本附件變為公開。

## 使用要求

- Zotero **10.0.x**。Windows 已進行原生開發驗證；macOS 和 Linux 的同等驗收仍待完成。
- 需要處理的 PDF 附件已下載到本機。
- 擷取 PDF 正文需要受支援的解析服務及其憑據；語意檢索還需要受支援的嵌入服務。

## 安裝

1. 開啟[預覽版釋出頁](https://github.com/lianghx123/zoteroknowledgemcp/releases/tag/v0.2.0-preview.1)。儲存庫為私有時，請登入有存取權限的帳號。
2. 下載 **zotero-knowledge-mcp.xpi**。GitHub 的原始碼 ZIP、tar 壓縮包不能作為外掛安裝。
3. 在 Zotero 中開啟**工具 → 外掛**，點選齒輪選單，選擇**從檔案安裝外掛…**，然後選擇 XPI。
4. 如果 Zotero 要求重新啟動，請按提示操作。開啟 **Zotero 設定 → Knowledge MCP**。
5. 按[第一篇文獻](quick-start.md)繼續操作。新安裝預設關閉解析、模型服務和本機 MCP。

## 驗證下載檔案

從同一釋出頁下載 `SHA256SUMS`，將其中的 XPI 雜湊與以下指令的輸出比較：

```powershell
Get-FileHash .\zotero-knowledge-mcp.xpi -Algorithm SHA256
```

macOS 使用 `shasum -a 256 zotero-knowledge-mcp.xpi`；Linux 使用 `sha256sum zotero-knowledge-mcp.xpi`。

## 安全升級

1. 關閉 Zotero，在外部位置備份完整資料目錄，包括 `knowledgemcp/` 子目錄。
2. 閱讀目標版本的發行說明，再按照相同步驟安裝其 XPI。
3. 檢查知識庫和已處理文獻後，再決定何時清理備份。

目前私有儲存庫的預覽版仍須手動升級。自動更新流程已準備好，但僅在儲存庫和安裝套件可公開存取後提供已驗證的正式版；預覽版始終手動安裝。Zotero 本身的自動更新設定決定是否安裝可用的正式更新。尚無正式發布時，更新來源維持空白。安裝舊 XPI 不會降級外掛資料庫；舊版本可能拒絕較新的結構，復原需要相容的外部備份。

停用或移除外掛會保留已存資料。重設或切換 Zotero 資料目錄前，請閱讀[資料與隱私](privacy.md)。
