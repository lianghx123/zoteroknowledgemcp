# Daten und Datenschutz

Diese Seite beschreibt das Datenverhalten der aktuellen Vorschau. Anbieter und KI-Clients besitzen eigene Bedingungen, Aufbewahrungsregeln und Kosten.

## Lokale Daten

Wissensdatenbank, Aufgabenstatus, extrahierte Inhalte, Artefakte und Vektorindizes liegen unter `knowledgemcp/` im Zotero-Datenverzeichnis. Das SQLite-Schema ist von Zoteros Datenbank getrennt. Originalanhänge bleiben bei Zotero.

Die Analysekonfiguration speichert derzeit einen wiederverwendbaren API-Schlüssel im Klartext in `parsing.json`. Schützen Sie Verzeichnis und Sicherungen. Embedding-/Reranking-Schlüssel liegen im Gecko Login Manager; Einstellungen enthalten nur Referenzen. MCP-Token-Datensätze speichern Hashes statt wiederherstellbarer Geheimnisse.

## Externe Datenübertragung

| Aktion | An den konfigurierten Dienst übertragene Daten |
| --- | --- |
| PDF-Analyse | Ausgewählte PDF-Datei |
| Inhalts-Embedding | Ausgewählte extrahierte Textsegmente |
| Semantische Abfrage | Abfragetext für Embedding |
| Optionales Reranking | Abfrage und Kandidatentextstellen |
| Autorisiertes MCP | Angeforderte Wissensinhalte an den Client |

Lokale Textsuche und Indexreparatur benötigen keine Embedding-Anfragen. Das Plugin bietet keinen eigenen Cloud-Sync- oder Remote-Kontodienst. Externe Clients können weitere Modell-/Netzwerkaktivitäten ausführen.

## Sichern und entfernen

Schließen Sie Zotero vor einer externen Sicherung des vollständigen Datenverzeichnisses einschließlich `knowledgemcp/`. Datenbank-Upgrade-Snapshots enthalten nicht alle Artefakte und Indizes und ersetzen keine vollständige Sicherung.

Deaktivieren oder Deinstallieren erhält Daten. Zotero-Datenverzeichnis-Resets oder Kontowechsel können das Verzeichnis mitsamt Plugin-Daten und Snapshots entfernen. Lagern Sie Sicherungen außerhalb. Vollständige integrierte Wiederherstellung und Schema-Downgrade sind nicht verfügbar.

## Probleme datensparsam melden

Prüfen Sie Protokolle vor Weitergabe auf PDF-Inhalte, Titel, lokale Pfade, Dienst-URLs und Zugangsdaten. Hängen Sie keine Datenverzeichnisse, Wissensdatenbanken, Token oder Schlüssel an öffentliche Issues. Siehe [Support](support.md).
