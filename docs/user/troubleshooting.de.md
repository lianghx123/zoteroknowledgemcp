# Fehlerbehebung

## Veröffentlichung oder Download fehlt

Release-XPI und `SHA256SUMS` können ohne Anmeldung öffentlich heruntergeladen werden. Laden Sie die XPI statt eines Quellarchivs herunter. Prüfen Sie bei Installationsfehlern die Zotero-Version und `SHA256SUMS`.

## Keine Analyseaufgabe oder fehlendes PDF

Prüfen Sie, ob Analyse aktiviert und gespeichert ist und der Anhang als PDF lokal vorliegt. Das Plugin lädt fehlende Dateien nicht herunter. Nutzen Sie **Anhänge analysieren** für vorhandene Wissenseinträge. Andere Dateitypen können reine Metadaten behalten.

## Aufgabe wartet oder schlägt fehl

Prüfen Sie Extraktionsphase und Details. Anbieterwarteschlangen unterscheiden sich von lokaler Arbeit; unbekannter Fortschritt bedeutet keinen Abschluss. Prüfen Sie Anbieter, Endpunkt, Zugangsdaten, Kontingent, Netzwerk und Grenzen. Wiederholen Sie die fehlgeschlagene Phase statt die Arbeit mehrfach hinzuzufügen.

Angenommene Aufgaben behalten ihre Anbieteridentität. Nach einem Dienstwechsel muss die ursprüngliche passende Endpunkt-/Schlüsselkonfiguration zum Fortsetzen verfügbar bleiben. Analyse zu deaktivieren bricht laufende Anfragen nicht ab.

## Text vorhanden, semantische Suche nicht

Prüfen Sie aktivierte, gespeicherte und angewandte Modelldienste sowie den Embedding-Verbindungstest. Kontrollieren Sie die semantische Phase in Importaufgaben und Hinweise zur Startwiederherstellung. Modell und Dimensionen müssen zum Vektorraum passen.

**Vorhandene Dokumente vektorisieren** erzeugt fehlende Embeddings und kann Kontingent verbrauchen. **Suchindex reparieren** baut aus gespeicherten Vektoren neu auf, ohne Embeddings neu zu erzeugen.

## Markdown leer oder veraltet

Warten Sie auf erfolgreiche Veröffentlichung, schließen/öffnen Sie das richtige PDF und klicken Sie auf **M**. Vorhandene Inhalte übernehmen neue Analyseregeln nicht automatisch; erneute Verarbeitung ist explizit nötig. Sichern Sie ungespeicherte Änderungen vorher.

## Einstellungen lassen sich nicht speichern

Lesen Sie die Validierungshinweise. Ein anderes Fenster oder ein externer Editor kann die Konfiguration geändert haben. Sichern Sie Eingaben, laden Sie das Formular neu und versuchen Sie es erneut. Verbindungstests speichern nichts.

## MCP-Verbindung schlägt fehl

- Prüfen Sie Laufstatus und tatsächliche Adresse.
- Lassen Sie Zotero laufen und den Computer wach.
- Client und Zotero müssen auf demselben Computer laufen und authentifiziertes Streamable HTTP unterstützen.
- Prüfen Sie Bearer-Token, Ablauf, Bibliotheken und Rechte.
- Wählen Sie bei belegtem Port einen freien lokalen Port und aktualisieren Sie nach Anwendung den Client.

## PDF-Scrollen stockt bei Entwicklungsautomatisierung

Windows-UI-Automation-Clients können Zotero-Barrierefreiheit aktivieren und PDF-Scrollen beeinträchtigen. Dies wurde beim Codex-Computer-Use-Hilfsprozess in isolierten Prüfungen beobachtet. Beenden Sie die aufgabeneigene Sitzung und den Helfer, starten Sie isoliertes Zotero neu und vergleichen Sie erneut. Das beweist keinen allgemeinen Fehler aller Installationen.

Bei anhaltenden Problemen folgen Sie [Support](support.md) mit minimaler Reproduktion und bereinigten Angaben.
