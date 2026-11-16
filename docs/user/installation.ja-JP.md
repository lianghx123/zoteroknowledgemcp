# インストールと更新

[XPI をダウンロード](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/zotero-knowledge-mcp.xpi){ .md-button .md-button--primary }
[SHA-256 チェックサム](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/SHA256SUMS){ .md-button }

[リリースノートとすべてのバージョン](https://github.com/lianghx123/zoteroknowledgemcp/releases)

現在のダウンロードは Zotero 10.0.x 向けの 0.2.0-preview.1 です。ソース、リリースの XPI とチェックサムは公開されており、GitHub アカウントなしでダウンロードできます。

## 必要な環境

- Zotero **10.0.x**。Windows でネイティブ検証済みですが、macOS と Linux の同等の検証は未完了です。
- 処理対象の PDF 添付ファイルがローカルにあること。
- 本文抽出には対応する解析サービスと認証情報が必要です。セマンティック検索には対応する埋め込みサービスも必要です。

## インストール

1. [プレビュー版リリース](https://github.com/lianghx123/zoteroknowledgemcp/releases/tag/v0.2.0-preview.1)を開きます。
2. **zotero-knowledge-mcp.xpi** をダウンロードします。ソースの ZIP や tar はインストールできるプラグインではありません。
3. Zotero の **ツール → プラグイン**から歯車メニューを開き、**ファイルからプラグインをインストール…**で XPI を選びます。
4. 求められた場合は再起動し、**Zotero 設定 → Knowledge MCP** を開きます。
5. [最初の文献](quick-start.md)へ進みます。新規インストールでは解析、モデルサービス、ローカル MCP は無効です。

## ダウンロードの確認

同じリリースの `SHA256SUMS` を取得し、XPI のハッシュを次の出力と比較します。

```powershell
Get-FileHash .\zotero-knowledge-mcp.xpi -Algorithm SHA256
```

macOS では `shasum -a 256 zotero-knowledge-mcp.xpi`、Linux では `sha256sum zotero-knowledge-mcp.xpi` を使います。

## 安全な更新

1. Zotero を終了し、`knowledgemcp/` を含むデータディレクトリ全体を外部の場所にバックアップします。
2. 更新先のリリースノートを読み、同じ手順で XPI をインストールします。
3. ライブラリと処理済み文献を確認するまでバックアップを保持します。

プレビュー版のインストールと更新は常に手動です。自動更新は検証済みの安定版だけを対象とし、インストールは Zotero 自身の更新設定に従います。安定版の公開がなければフィードは空のままです。古い XPI を入れてもデータベースは旧スキーマに戻りません。古い版が新しいスキーマを拒否する場合、互換性のある外部バックアップが必要です。

無効化やアンインストールではデータは保持されます。Zotero のデータディレクトリをリセット・変更する前に[データとプライバシー](privacy.md)を確認してください。
