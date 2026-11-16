# Dienste konfigurieren

Öffnen Sie **Zotero-Einstellungen → Knowledge MCP**. Die Bereiche **Dokumentanalyse**, **Modelle und Suche** und **MCP-Verbindung** besitzen eigene Aktionen zum Speichern oder Anwenden. Ein Bereichswechsel erhält ungespeicherte Eingaben.

## Dokumentanalyse

| Dienst | Endpunkt | Modell |
| --- | --- | --- |
| PaddleOCR | `https://paddleocr.aistudio-app.com/api/v2/ocr/jobs` | `PaddleOCR-VL-1.6` |
| MinerU | `https://mineru.net/api/v4` | `vlm` |

Wählen Sie einen Dienst, geben Sie dessen API-Schlüssel/Token ein, aktivieren Sie die Analyse und speichern Sie. Beim Wechsel bleiben die jeweiligen Zugangsdaten und Optionen erhalten. Das Modell ist durch den Dienst festgelegt; beliebige OCR-Endpunkte sind nicht automatisch kompatibel.

Externe Endpunkte benötigen HTTPS; HTTP ist auf lokale Loopback-Dienste beschränkt. URLs dürfen keine Passwörter, Abfrageparameter oder Fragmente enthalten. Angenommene Aufgaben behalten ihre ursprüngliche Dienst- und Endpunktidentität; ein Dienstwechsel leitet sie nicht um.

Warteschlangeneinstellungen steuern lokale Ausführungsplätze, verfolgte Remote-Aufgaben, Abfragen, Zeitlimits sowie Datei- und Ergebnisgrößen. Beginnen Sie mit den Standardwerten. Zeiten werden in Sekunden, Größen in MB angezeigt (1 MB = 1.048.576 Byte).

## Modelle und Suche

Der ausgelieferte Anbieter ist **Bailian**. Standardmodelle sind `qwen3.7-text-embedding` und `qwen3.7-text-rerank`, mit 768 Vektordimensionen. Prüfen Sie die Unterstützung für Modell, Region, Endpunkt und Dimensionen in Ihrem Konto.

1. Tragen Sie kompatiblen Embedding-Endpunkt, Modell und Schlüssel ein.
2. Konfigurieren Sie bei Bedarf Reranking. Dabei können gefundene Textstellen an den Anbieter gesendet werden; ein eigener oder der Embedding-Schlüssel ist möglich.
3. Testen Sie jede Verbindung. Tests verwenden die aktuellen Eingaben und speichern nichts.
4. Aktivieren Sie die Dienste, wählen Sie **Speichern und anwenden** und prüfen Sie den Anwendungsstatus.
5. Nutzen Sie bei Bedarf **Vorhandene Dokumente vektorisieren**, um fehlende Embeddings zu erzeugen.

Ein leeres Feld für einen gespeicherten Schlüssel erhält diesen. Verbindungserfolg, gespeicherte Konfiguration und angewandter Laufzeitstatus sind getrennte Zustände.

Ein anderes Embedding-Modell, ein anderer Endpunkt oder andere Dimensionen ändern den Vektorraum. Wählen Sie bei Aufforderung zwischen Beibehalten, Löschen der alten Vektoren oder Abbrechen. Inkompatible Räume werden nicht vermischt.

**Suchindex reparieren** baut lokal aus gespeicherten Vektoren neu auf, ohne neue Embeddings anzufordern. **Vorhandene Dokumente vektorisieren** kann kostenpflichtige Anbieteranfragen auslösen. Siehe [Fehlerbehebung](troubleshooting.md).

## MCP-Verbindung

Lokales MCP ist optional und standardmäßig deaktiviert. Aktivieren Sie es bei Bedarf für einen lokalen KI-Client, wenden Sie den Port an und erstellen Sie ein Token mit expliziten Bibliotheken und Rechten. Folgen Sie dem [MCP-Leitfaden](mcp.md).
