# Arbeiten und Textstellen suchen

Wählen Sie einen Wissensbereich und einen **Wissensdatenbank**-Modus im Zotero-Suchmenü. Geben Sie Text ein und drücken Sie **Enter**. Ein reiner Moduswechsel erhält die Liste; Enter bei leerer Abfrage entfernt den Plugin-Filter ohne Modellanfrage.

| Modus | Grundlage | Voraussetzungen |
| --- | --- | --- |
| Text | Lokaler Text und Metadaten | Veröffentlichter Text für Textstellen |
| Semantisch | Bedeutungsbasierte Vektorsuche | Aktivierter Embedding-Dienst und passend indexierte Inhalte |
| Erweitert semantisch | Semantische Suche mit Reranking | Konfigurierte Embedding-/Reranking-Dienste und passender Index |
| Fusion | Kombination aus Text- und semantischer Suche | Verfügbare Kanäle; semantische Bereitschaft beeinflusst Ergebnisse |

Klappen Sie Ergebnisse mit dem nativen Pfeil auf, um Textstellen, Metadatenfelder und Quellenlinks zu prüfen. Ein kurzer Relevanzhinweis steht vor schwächer bewerteten Ergebnissen; diese bleiben zugänglich. Bewertungen sind Rangsignale, keine Tatsachensicherheit und kein Ersatz für Quellenlektüre.

**Meine Wissensdatenbank** durchsucht aktive Bibliotheken. Eine Bibliothek oder ein Ordner grenzt den Bereich ein. Der Wissenspapierkorb besitzt einen eigenen Wiederherstellungsbereich.

## Im geöffneten PDF suchen

Die Markdown-Begleitansicht hat eine eigene Dokumentsuche mit Text-, semantischem, erweitert semantischem und Fusionsmodus für den aktuellen Inhalt dieses Anhangs. Ein Treffer springt zum Quellblock; Schließen zeigt wieder das Inhaltsverzeichnis.

Textsuche kann vor der semantischen Indexierung funktionieren. Fehlen semantische Treffer, prüfen Sie Importaufgaben, Modellkonfiguration und Wiederherstellung. Lesen Sie vor erneutem Analysieren die [Fehlerbehebung](troubleshooting.md).
