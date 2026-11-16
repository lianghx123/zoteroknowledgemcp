# Zotero Knowledge MCP

将选定的 Zotero PDF 附件转换为可在本地检索的知识库。在 PDF 旁阅读提取的正文，按需修正文稿，并通过模型上下文协议（MCP）明确授权 AI 客户端访问。

**源码预览: 0.2.0-preview.1.** 需要 Zotero **10.0.x**。原生验收使用 Windows 和 Zotero 10.0.6–10.0.8；macOS、Linux 的同等验收仍待完成。预览版目前采用手动安装与升级。

[发行说明与全部版本](https://github.com/lianghx123/zoteroknowledgemcp/releases)

目前没有已发布的预编译安装包。以下安装步骤适用于发布页提供 XPI 和校验文件之后；开发者可按开发指南自行构建源码。

## 从这里开始

1. 从发布页下载 XPI 并[安装插件](installation.md)。
2. 使用受支持的解析服务[处理第一篇文献](quick-start.md)。
3. 如需基于模型的检索，请[配置语义检索](configuration.md)。
4. 如需外部工具检索和阅读，请[连接 AI 客户端](mcp.md)。

普通用户不需要 Node.js、npm、Python 或单独的后台服务器。解析和模型服务可能需要账号、API 凭据及付费额度。

## 可以完成的任务

| 任务 | 指南 |
| --- | --- |
| 组织选定文献并同步 Zotero 分类 | [知识库](knowledge-libraries.md) |
| 使用文本或语义检索查找文献与片段 | [检索](search.md) |
| 阅读 Markdown、查看引文并保存正文修正 | [阅读与编辑](reader.md) |
| 授权本机 AI 客户端访问知识库 | [MCP 连接](mcp.md) |
| 了解外部请求、凭据与备份 | [数据与隐私](privacy.md) |
| 排查配置和处理问题 | [故障排查](troubleshooting.md) |

## 预览版范围

Zotero 继续管理原始文献库和附件。插件在本地保存派生内容，通过配置的外部服务执行解析、嵌入和可选的重排。目前不提供公网远程 MCP、插件云同步、任意解析结果直接导入或完整备份恢复工具。约 1,000 篇文献的完整工作流验收仍待完成。

插件作者：[lianghx123](https://github.com/lianghx123)。项目公开前，访问[源码与发布版本](https://github.com/lianghx123/zoteroknowledgemcp)可能需要仓库权限。
