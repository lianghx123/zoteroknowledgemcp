# 连接 AI 客户端

MCP 允许授权客户端发现文献、检索片段、读取结构化内容，并执行明确授权的批注或摘要写入。插件通过带认证的 Streamable HTTP 提供 16 个工具，响应仅使用 SSE，不提供旧式独立 HTTP+SSE 端点。

## 启用访问

1. 打开 **Zotero 设置 → Knowledge MCP → MCP 连接**。
2. 启用本地 MCP 并应用设置。默认地址为 `http://127.0.0.1:23126/mcp/knowledge`，以设置中实际地址为准。
3. 创建具名令牌，明确选择知识库并授予客户端需要的权限。检索、读取、批注写入和摘要写入具有独立权限。
4. 立即复制令牌密钥；它仅显示一次，无法找回。
5. 在客户端的远程或 HTTP MCP 设置中填入地址和 Bearer 令牌。保持 Zotero 运行且电脑唤醒。

令牌有效期可选 30、90、180 或 365 天。编辑名称、知识库或权限不会改变密钥和到期时间；不再需要时撤销。撤销适用于后续请求，也包括已有连接。

## Codex 示例

在启动客户端的环境中设置 `ZOTERO_KNOWLEDGE_MCP_TOKEN`，然后运行：

```sh
codex mcp add zotero-knowledge --url http://127.0.0.1:23126/mcp/knowledge --bearer-token-env-var ZOTERO_KNOWLEDGE_MCP_TOKEN
```

插件设置中也提供地址和匹配命令的复制按钮。修改端口后请同步调整 URL。环境变量的配置方式以客户端文档为准，不要把令牌放进截图、源码仓库或问题报告。

## 连接范围

监听器仅在 Zotero 运行时接受同机回环访问。目前不支持公网 HTTPS、账号远程访问或中继、云连接。远程云客户端不能直接访问本机回环地址。授权客户端可读取令牌范围内的数据，也可能将取回内容发送给自己的模型服务。

工具结构及应用兼容性详见[开发者 MCP 参考](https://github.com/lianghx123/zoteroknowledgemcp/blob/main/docs/development/mcp.md)。
