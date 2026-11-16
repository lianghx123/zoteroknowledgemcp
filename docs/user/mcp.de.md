# Einen KI-Client verbinden

MCP erlaubt autorisierten Clients Literatursuche, Textstellensuche, strukturiertes Lesen und explizit erlaubte Anmerkungs-/Zusammenfassungsschreibvorgänge. Das Plugin bietet 16 Werkzeuge über authentifiziertes Streamable HTTP ausschließlich mit SSE-Antworten, keinen separaten alten HTTP+SSE-Endpunkt.

## Zugriff aktivieren

1. Öffnen Sie **Zotero-Einstellungen → Knowledge MCP → MCP-Verbindung**.
2. Aktivieren Sie lokales MCP und wenden Sie die Einstellungen an. Standard: `http://127.0.0.1:23126/mcp/knowledge`; maßgeblich ist Ihre angezeigte Adresse.
3. Erstellen Sie ein benanntes Token, wählen Sie explizite Bibliotheken und die benötigten Rechte. Suche/Lesen und Schreibrechte für Anmerkungen/Zusammenfassungen sind getrennt.
4. Kopieren Sie das Geheimnis sofort. Es wird einmalig angezeigt und ist nicht wiederherstellbar.
5. Hinterlegen Sie Adresse und Bearer-Token in der Remote-/HTTP-MCP-Konfiguration des Clients. Zotero muss laufen und der Computer wach bleiben.

Token-Laufzeiten: 30, 90, 180 oder 365 Tage. Name, Bibliotheken und Rechte lassen sich ändern; Geheimnis und Ablauf bleiben unverändert. Widerrufen Sie nicht mehr benötigte Token. Der Widerruf gilt für spätere Anfragen, auch auf bestehenden Verbindungen.

## Codex-Beispiel

Stellen Sie `ZOTERO_KNOWLEDGE_MCP_TOKEN` in der Startumgebung des Clients bereit und führen Sie aus:

```sh
codex mcp add zotero-knowledge --url http://127.0.0.1:23126/mcp/knowledge --bearer-token-env-var ZOTERO_KNOWLEDGE_MCP_TOKEN
```

Die Plugin-Einstellungen bieten Adresse und passenden Befehl zum Kopieren. Passen Sie die URL bei anderem Port an. Folgen Sie der Client-Anleitung für Umgebungsvariablen und veröffentlichen Sie Token nicht in Screenshots, Quellcode oder Fehlerberichten.

## Verbindungsgrenzen

Der Listener akzeptiert nur Loopback-Zugriff vom selben Computer, während Zotero läuft. Öffentliches HTTPS, kontobasierter Fernzugriff und Relay-/Cloud-Verbindungen sind nicht verfügbar. Cloud-Clients erreichen die lokale Loopback-Adresse nicht direkt. Ein autorisierter Client erhält Daten im Token-Bereich und kann diese an seinen eigenen Modelldienst weiterleiten.

Werkzeugschemas und Kompatibilität beschreibt die [MCP-Entwicklerreferenz](https://github.com/lianghx123/zoteroknowledgemcp/blob/main/docs/development/mcp.md).
