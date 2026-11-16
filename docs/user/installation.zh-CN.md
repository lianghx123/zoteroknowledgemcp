# 安装与升级

[发行说明与全部版本](https://github.com/lianghx123/zoteroknowledgemcp/releases)

目前没有已发布的预编译安装包。以下安装步骤适用于发布页提供 XPI 和校验文件之后；开发者可按开发指南自行构建源码。

## 使用要求

- Zotero **10.0.x**。Windows 已进行原生开发验证；macOS 和 Linux 的同等验收仍待完成。
- 需要处理的 PDF 附件已下载到本机。
- 提取 PDF 正文需要受支持的解析服务及其凭据；语义检索还需要受支持的嵌入服务。

## 安装

1. 打开[预览版发布页](https://github.com/lianghx123/zoteroknowledgemcp/releases)。仓库为私有时，请登录有访问权限的账号。
2. 下载 **zotero-knowledge-mcp.xpi**。GitHub 的源码 ZIP、tar 压缩包不能作为插件安装。
3. 在 Zotero 中打开**工具 → 插件**，点击齿轮菜单，选择**从文件安装插件…**，然后选择 XPI。
4. 如果 Zotero 要求重启，请按提示操作。打开 **Zotero 设置 → Knowledge MCP**。
5. 按[第一篇文献](quick-start.md)继续操作。新安装默认关闭解析、模型服务和本地 MCP。

## 校验下载文件

从同一发布页下载 `SHA256SUMS`，将其中的 XPI 哈希与以下命令的输出比较：

```powershell
Get-FileHash .\zotero-knowledge-mcp.xpi -Algorithm SHA256
```

macOS 使用 `shasum -a 256 zotero-knowledge-mcp.xpi`；Linux 使用 `sha256sum zotero-knowledge-mcp.xpi`。

## 安全升级

1. 关闭 Zotero，在外部位置备份完整数据目录，包括 `knowledgemcp/` 子目录。
2. 阅读目标版本的发行说明，再按照相同步骤安装其 XPI。
3. 检查知识库和已处理文献后，再决定何时清理备份。

目前私有仓库的预览版仍需手动升级。自动更新流程已准备好，但仅在仓库和安装包公开可访问后提供已验证的正式版；预览版始终手动安装。Zotero 自身的自动更新设置控制是否安装可用的正式更新。尚无正式发布时，更新源保持为空。安装旧 XPI 不会降级插件数据库；旧版本可能拒绝较新的结构，恢复需要兼容的外部备份。

禁用或卸载插件会保留已存数据。重置或切换 Zotero 数据目录前，请阅读[数据与隐私](privacy.md)。
