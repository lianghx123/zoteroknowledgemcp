# Instalación y actualización

[Descargar XPI](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/zotero-knowledge-mcp.xpi){ .md-button .md-button--primary }
[Suma de verificación SHA-256](https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v0.2.0-preview.1/SHA256SUMS){ .md-button }

[Notas y todas las versiones](https://github.com/lianghx123/zoteroknowledgemcp/releases)

Descarga actual: 0.2.0-preview.1 para Zotero 10.0.x. El código fuente, el XPI publicado y su suma de verificación son públicos y se pueden descargar sin una cuenta de GitHub.

## Requisitos

- Zotero **10.0.x**. Se han realizado pruebas nativas en Windows; la validación equivalente en macOS y Linux está pendiente.
- Un adjunto PDF disponible localmente para procesarlo.
- Un servicio de análisis compatible y sus credenciales; la búsqueda semántica también necesita un servicio de embeddings compatible.

## Instalar

1. Abre la [versión preliminar](https://github.com/lianghx123/zoteroknowledgemcp/releases/tag/v0.2.0-preview.1).
2. Descarga **zotero-knowledge-mcp.xpi**. Los ZIP y tar del código fuente no son complementos instalables.
3. En Zotero, abre **Herramientas → Complementos**, el menú del engranaje y **Instalar complemento desde archivo…**. Selecciona el XPI.
4. Reinicia si se solicita y abre **Ajustes de Zotero → Knowledge MCP**.
5. Continúa con el [primer documento](quick-start.md). El análisis, los modelos y MCP local están desactivados en instalaciones nuevas.

## Comprobar la descarga

Descarga `SHA256SUMS` de la misma versión y compara el hash del XPI con esta salida:

```powershell
Get-FileHash .\zotero-knowledge-mcp.xpi -Algorithm SHA256
```

En macOS: `shasum -a 256 zotero-knowledge-mcp.xpi`; en Linux: `sha256sum zotero-knowledge-mcp.xpi`.

## Actualizar con seguridad

1. Cierra Zotero y crea una copia externa de todo su directorio de datos, incluido `knowledgemcp/`.
2. Lee las notas de la versión de destino e instala su XPI con los mismos pasos.
3. Conserva la copia hasta comprobar bibliotecas y documentos procesados.

Las versiones preliminares siempre se instalan y actualizan manualmente. El canal automático solo ofrece versiones estables verificadas. Los ajustes de actualización de Zotero controlan su instalación. Sin una versión estable publicada, la fuente permanece vacía. Instalar un XPI anterior no reduce la versión del esquema; la recuperación requiere una copia externa compatible si una versión antigua rechaza un esquema más reciente.

Desactivar o desinstalar conserva los datos. Consulta [Datos y privacidad](privacy.md) antes de restablecer o cambiar el directorio de Zotero.
