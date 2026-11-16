# Instalación y actualización

[Notas y todas las versiones](https://github.com/lianghx123/zoteroknowledgemcp/releases)

Actualmente no hay un instalador precompilado publicado. Los pasos siguientes se aplican cuando la página de versiones ofrezca un XPI y su suma de verificación. Los colaboradores pueden compilar el código con la guía de desarrollo.

## Requisitos

- Zotero **10.0.x**. Se han realizado pruebas nativas en Windows; la validación equivalente en macOS y Linux está pendiente.
- Un adjunto PDF disponible localmente para procesarlo.
- Un servicio de análisis compatible y sus credenciales; la búsqueda semántica también necesita un servicio de embeddings compatible.

## Instalar

1. Abre la [versión preliminar](https://github.com/lianghx123/zoteroknowledgemcp/releases). Mientras el repositorio sea privado, inicia sesión con una cuenta autorizada.
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

Las actualizaciones de la versión preliminar privada siguen siendo manuales. El canal automático está preparado, pero solo ofrecerá versiones estables verificadas cuando el repositorio y los instaladores sean públicos. Las versiones preliminares siempre se instalan manualmente. El ajuste de actualizaciones de Zotero controla la instalación de las versiones estables ofrecidas. Sin una versión estable publicada, la fuente queda vacía. Instalar un XPI anterior no rebaja el esquema de la base. Una versión antigua puede rechazar un esquema nuevo; la recuperación requiere una copia externa compatible.

Desactivar o desinstalar conserva los datos. Consulta [Datos y privacidad](privacy.md) antes de restablecer o cambiar el directorio de Zotero.
