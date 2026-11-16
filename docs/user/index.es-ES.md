# Zotero Knowledge MCP

Convierte los PDF seleccionados en Zotero en una biblioteca de conocimiento local con búsqueda. Lee y corrige el texto extraído junto al PDF y autoriza explícitamente a clientes de IA mediante el Model Context Protocol (MCP).

**Vista previa del código fuente: 0.2.0-preview.1.** Requiere Zotero **10.0.x**. La validación nativa se realizó en Windows con Zotero 10.0.6–10.0.8; queda pendiente una validación equivalente en macOS y Linux. Esta versión preliminar se instala y actualiza manualmente.

[Notas y todas las versiones](https://github.com/lianghx123/zoteroknowledgemcp/releases)

Actualmente no hay un instalador precompilado publicado. Los pasos siguientes se aplican cuando la página de versiones ofrezca un XPI y su suma de verificación. Los colaboradores pueden compilar el código con la guía de desarrollo.

## Empieza aquí

1. [Instala el complemento](installation.md) desde el XPI publicado.
2. [Procesa tu primer documento](quick-start.md) con un servicio de análisis compatible.
3. [Configura la búsqueda semántica](configuration.md) para utilizar modelos.
4. [Conecta un cliente de IA](mcp.md) para buscar y leer desde herramientas externas.

No necesitas Node.js, npm, Python ni un servidor separado. Los proveedores de análisis y modelos pueden exigir cuentas, credenciales de API y cuota de pago.

## Funciones

| Tarea | Guía |
| --- | --- |
| Organizar documentos y sincronizar colecciones Zotero | [Bibliotecas de conocimiento](knowledge-libraries.md) |
| Encontrar documentos y pasajes mediante texto o semántica | [Búsqueda](search.md) |
| Leer Markdown, consultar citas y guardar correcciones | [Lectura y edición](reader.md) |
| Autorizar clientes locales de IA | [Conexión MCP](mcp.md) |
| Comprender envíos externos, credenciales y copias | [Datos y privacidad](privacy.md) |
| Resolver problemas de configuración y procesamiento | [Solución de problemas](troubleshooting.md) |

## Límites de la versión preliminar

Zotero sigue gestionando la biblioteca y los adjuntos originales. El complemento guarda contenido derivado localmente y utiliza los servicios configurados para análisis, embeddings y reclasificación opcional. No ofrece acceso MCP remoto público, sincronización propia en la nube, importación directa de resultados arbitrarios ni copia/restauración completa integrada. Sigue pendiente validar el flujo completo con unos 1.000 documentos.

Autor: [lianghx123](https://github.com/lianghx123). El [código y las versiones](https://github.com/lianghx123/zoteroknowledgemcp) pueden requerir acceso al repositorio hasta que el proyecto sea público.
