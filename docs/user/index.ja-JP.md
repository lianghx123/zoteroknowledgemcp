# Zotero Knowledge MCP

Zotero で選んだ PDF 添付ファイルを、ローカルで検索できるナレッジライブラリに変換します。PDF の横で抽出テキストを読み、必要に応じて修正し、Model Context Protocol（MCP）を通じて AI クライアントにアクセスを許可できます。

**現在のバージョン：0.2.0-preview.1。** Zotero **10.0.x** が必要です。ネイティブ環境での検証は Windows と Zotero 10.0.6–10.0.8 で行われており、macOS と Linux の同等の受け入れ検証は未完了です。このプレビュー版のインストールと更新は手動です。

[XPI をダウンロード](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/zotero-knowledge-mcp.xpi){ .md-button .md-button--primary }
[SHA-256 チェックサム](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/SHA256SUMS){ .md-button }

[リリースノートとすべてのバージョン](https://github.com/lianghx123/zoteroknowledgemcp/releases)

現在のダウンロードは Zotero 10.0.x 向けの 0.2.0-preview.1 です。リポジトリが非公開の間は、アクセス権のある GitHub アカウントでログインしてください。公開ドキュメントサイトから非公開リリースのファイルが公開されることはありません。

## はじめに

1. 公開された XPI から[プラグインをインストール](installation.md)します。
2. 対応する解析サービスで[最初の文献を処理](quick-start.md)します。
3. モデルを利用する場合は[セマンティック検索を設定](configuration.md)します。
4. 外部ツールから検索・閲覧する場合は [AI クライアントを接続](mcp.md)します。

利用者は Node.js、npm、Python、別のバックグラウンドサーバーを用意する必要はありません。解析・モデルサービスにはアカウント、API 認証情報、有料の利用枠が必要な場合があります。

## 主な機能

| 操作 | ガイド |
| --- | --- |
| 文献の整理と Zotero コレクションの同期 | [ナレッジライブラリ](knowledge-libraries.md) |
| テキスト・セマンティック検索で文献や文章を探す | [検索](search.md) |
| Markdown の閲覧、引用の確認、本文修正の保存 | [閲覧と編集](reader.md) |
| ローカル AI クライアントへのアクセス許可 | [MCP 接続](mcp.md) |
| 外部送信、認証情報、バックアップの確認 | [データとプライバシー](privacy.md) |
| 設定や処理の問題を解決 | [トラブルシューティング](troubleshooting.md) |

## プレビュー版の範囲

元のライブラリと添付ファイルは引き続き Zotero が管理します。プラグインは派生コンテンツをローカル保存し、設定した外部サービスで解析、埋め込み、任意の再ランキングを行います。公開リモート MCP、プラグインのクラウド同期、任意の解析結果の直接取り込み、完全なバックアップ・復元機能は未提供です。約 1,000 本の文献による全工程の受け入れ検証は未完了です。

作者：[lianghx123](https://github.com/lianghx123)。プロジェクト公開前は[ソースとリリース](https://github.com/lianghx123/zoteroknowledgemcp)へのアクセス権が必要な場合があります。
