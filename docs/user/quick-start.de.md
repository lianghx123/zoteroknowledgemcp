# Das erste Dokument verarbeiten

Beginnen Sie mit einer Arbeit, deren PDF bereits lokal in Zotero liegt. Die Verarbeitung lädt das PDF zum konfigurierten Analysedienst hoch; prüfen Sie vor vertraulichen Dokumenten dessen Bedingungen.

## 1. Analysedienst konfigurieren

Öffnen Sie **Zotero-Einstellungen → Knowledge MCP → Dokumentanalyse**. Wählen Sie **PaddleOCR (PaddleOCR VL-1.6)** oder **MinerU (VLM)**, geben Sie die passenden Zugangsdaten ein, aktivieren Sie die Analyse und speichern Sie. Endpunkte beschreibt die [Dienstkonfiguration](configuration.md).

## 2. Arbeit hinzufügen

Klicken Sie in einer nativen Zotero-Literaturansicht mit der rechten Maustaste auf die Arbeit und wählen Sie **Zur Wissensdatenbank hinzufügen** und das Ziel. Das Plugin übernimmt Metadaten und stellt geeignete PDF-Anhänge in die Warteschlange. Erneutes Hinzufügen derselben Arbeit zum selben Ort erzeugt keine doppelte Ressource.

Einträge ohne PDF können Metadaten enthalten, aber daraus allein entsteht kein extrahierter Volltext.

## 3. Verarbeitung verfolgen

Öffnen Sie **Importaufgaben**. Der Ablauf umfasst:

1. Zur Wissensdatenbank hinzufügen.
2. Dokumentinhalt extrahieren.
3. Semantische Suche vorbereiten, falls aktiviert.

Die Extraktion umfasst Vorbereitung, Upload, Warten beim Anbieter, Analyse, Download und lokales Speichern. Seitenprozente des Anbieters betreffen nur die Extraktion, nicht den gesamten Ablauf. Prüfen Sie Fehler und nutzen Sie Abbrechen oder Wiederholen. Eine Wiederholung der Vektorphase lädt das PDF nicht erneut hoch.

## 4. Ergebnis lesen

Öffnen Sie das PDF im nativen Zotero-Reader und klicken Sie auf **M**. War es bereits vor Abschluss geöffnet, schließen und öffnen Sie es erneut. Nutzen Sie Inhaltsverzeichnis, Dokumentsuche und Zitatvorschauen. Siehe [Lesen und bearbeiten](reader.md).

## 5. Suchen oder einen Client verbinden

Veröffentlichter Text ist ohne Embedding-Dienst durchsuchbar. Aktivieren und konfigurieren Sie für die semantische Suche die Modelldienste und warten Sie auf die Indexierung. Verwenden Sie dann die [Suche](search.md) oder [verbinden Sie einen lokalen KI-Client](mcp.md).
