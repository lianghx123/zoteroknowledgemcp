# Installation und Upgrade

[Versionshinweise und alle Versionen](https://github.com/lianghx123/zoteroknowledgemcp/releases)

Derzeit ist kein vorgefertigtes Installationspaket veröffentlicht. Die folgenden Schritte gelten, sobald eine XPI-Datei und ihre Prüfsumme auf der Release-Seite verfügbar sind. Mitwirkende können den Quellcode gemäß der Entwicklungsanleitung bauen.

## Voraussetzungen

- Zotero **10.0.x**. Native Entwicklungsprüfungen erfolgten unter Windows; entsprechende Abnahmen unter macOS und Linux stehen aus.
- Ein lokal verfügbarer PDF-Anhang zur Dokumentverarbeitung.
- Ein unterstützter Analysedienst mit Zugangsdaten zur Textextraktion; die semantische Suche benötigt zusätzlich einen unterstützten Embedding-Dienst.

## Installation

1. Öffnen Sie die [Vorschauveröffentlichung](https://github.com/lianghx123/zoteroknowledgemcp/releases). Melden Sie sich mit einem berechtigten Konto an, solange das Repository privat ist.
2. Laden Sie **zotero-knowledge-mcp.xpi** herunter. GitHubs ZIP- und tar-Quellarchive sind keine installierbaren Plugins.
3. Öffnen Sie in Zotero **Extras → Plugins**, dann das Zahnradmenü und **Plugin aus Datei installieren…**. Wählen Sie die XPI-Datei.
4. Starten Sie Zotero bei Aufforderung neu und öffnen Sie **Zotero-Einstellungen → Knowledge MCP**.
5. Fahren Sie mit dem [ersten Dokument](quick-start.md) fort. Analyse, Modelldienste und lokales MCP sind bei Neuinstallationen deaktiviert.

## Download prüfen

Laden Sie `SHA256SUMS` aus derselben Veröffentlichung herunter und vergleichen Sie den XPI-Hash mit der Ausgabe:

```powershell
Get-FileHash .\zotero-knowledge-mcp.xpi -Algorithm SHA256
```

Unter macOS: `shasum -a 256 zotero-knowledge-mcp.xpi`; unter Linux: `sha256sum zotero-knowledge-mcp.xpi`.

## Sicher aktualisieren

1. Schließen Sie Zotero und sichern Sie das vollständige Datenverzeichnis einschließlich `knowledgemcp/` an einem externen Speicherort.
2. Lesen Sie die Versionshinweise des Ziels und installieren Sie dessen XPI wie oben beschrieben.
3. Bewahren Sie die Sicherung auf, bis Bibliotheken und verarbeitete Dokumente geprüft sind.

Upgrades der aktuellen privaten Vorschau erfolgen manuell. Der vorbereitete automatische Kanal bietet ausschließlich geprüfte stabile Versionen an, sobald Repository und Installationsdateien öffentlich erreichbar sind. Vorschauen werden immer manuell installiert. Zoteros eigene Update-Einstellung steuert die Installation angebotener stabiler Updates. Ohne stabile Veröffentlichung bleibt der Feed leer. Eine ältere XPI stuft die Datenbank nicht zurück. Ältere Versionen können ein neueres Schema ablehnen; zur Wiederherstellung ist eine kompatible externe Sicherung erforderlich.

Deaktivieren oder Deinstallieren erhält die Daten. Lesen Sie vor einem Zurücksetzen oder Wechsel des Zotero-Datenverzeichnisses [Daten und Datenschutz](privacy.md).
