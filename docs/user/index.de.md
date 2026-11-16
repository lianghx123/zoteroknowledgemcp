# Zotero Knowledge MCP

Verwandeln Sie ausgewählte Zotero-PDF-Anhänge in eine lokal durchsuchbare Wissensbibliothek. Lesen und korrigieren Sie extrahierten Text neben dem PDF und erlauben Sie KI-Clients gezielten Zugriff über das Model Context Protocol (MCP).

**Quellcode-Vorschau: 0.2.0-preview.1.** Erfordert Zotero **10.0.x**. Native Abnahmeprüfungen erfolgten unter Windows mit Zotero 10.0.6–10.0.8; entsprechende Prüfungen unter macOS und Linux stehen aus. Installation und Upgrades dieser Vorschau erfolgen manuell.

[Versionshinweise und alle Versionen](https://github.com/lianghx123/zoteroknowledgemcp/releases)

Derzeit ist kein vorgefertigtes Installationspaket veröffentlicht. Die folgenden Schritte gelten, sobald eine XPI-Datei und ihre Prüfsumme auf der Release-Seite verfügbar sind. Mitwirkende können den Quellcode gemäß der Entwicklungsanleitung bauen.

## Hier beginnen

1. [Installieren Sie das Plugin](installation.md) mit der veröffentlichten XPI-Datei.
2. [Verarbeiten Sie Ihr erstes Dokument](quick-start.md) mit einem unterstützten Analysedienst.
3. [Konfigurieren Sie die semantische Suche](configuration.md) für modellgestützte Abfragen.
4. [Verbinden Sie einen KI-Client](mcp.md), um externe Werkzeuge suchen und lesen zu lassen.

Anwender benötigen weder Node.js, npm, Python noch einen separaten Hintergrundserver. Analyse- und Modelldienste können Konten, API-Zugangsdaten und kostenpflichtiges Kontingent voraussetzen.

## Funktionen

| Aufgabe | Anleitung |
| --- | --- |
| Ausgewählte Literatur organisieren und Zotero-Sammlungen synchronisieren | [Wissensbibliotheken](knowledge-libraries.md) |
| Literatur und Textstellen per Text- oder semantischer Suche finden | [Suche](search.md) |
| Markdown lesen, Zitate verfolgen und Korrekturen speichern | [Lesen und bearbeiten](reader.md) |
| Lokale KI-Clients für Wissensbibliotheken autorisieren | [MCP-Verbindung](mcp.md) |
| Externe Anfragen, Zugangsdaten und Sicherungen verstehen | [Daten und Datenschutz](privacy.md) |
| Konfigurations- und Verarbeitungsprobleme untersuchen | [Fehlerbehebung](troubleshooting.md) |

## Grenzen der Vorschau

Zotero verwaltet weiterhin die ursprüngliche Bibliothek und ihre Anhänge. Das Plugin speichert abgeleitete Inhalte lokal und nutzt konfigurierte externe Dienste für Analyse, Embeddings und optionales Reranking. Öffentlicher MCP-Fernzugriff, Plugin-Cloud-Synchronisierung, direkter Import beliebiger Analyseausgaben und vollständige Sicherungs-/Wiederherstellungswerkzeuge sind nicht verfügbar. Die Abnahme des vollständigen Ablaufs mit etwa 1.000 Arbeiten steht aus.

Plugin-Autor: [lianghx123](https://github.com/lianghx123). Für [Quellcode und Veröffentlichungen](https://github.com/lianghx123/zoteroknowledgemcp) kann bis zur Freigabe des Projekts Repository-Zugriff erforderlich sein.
