# Conectar un cliente de IA

MCP permite descubrir documentos, buscar pasajes, leer contenido estructurado y escribir anotaciones o resúmenes cuando se autoriza explícitamente. El complemento ofrece 16 herramientas mediante Streamable HTTP autenticado exclusivamente con respuestas SSE, sin un punto antiguo HTTP+SSE separado.

## Activar el acceso

1. Abre **Ajustes de Zotero → Knowledge MCP → Conexión MCP**.
2. Activa MCP local y aplica. Dirección predeterminada: `http://127.0.0.1:23126/mcp/knowledge`; utiliza la que muestren tus ajustes.
3. Crea un token con nombre, selecciona bibliotecas explícitas y los permisos necesarios. Buscar/leer y escribir anotaciones/resúmenes son permisos distintos.
4. Copia el secreto de inmediato. Solo se muestra una vez y no puede recuperarse.
5. Configura el servidor MCP remoto/HTTP del cliente con la dirección y el token Bearer. Mantén Zotero abierto y el ordenador activo.

Los tokens duran 30, 90, 180 o 365 días. Cambiar nombre, bibliotecas o permisos conserva secreto y caducidad. Revoca los que ya no necesites; la revocación se aplica a solicitudes posteriores, incluso en conexiones existentes.

## Ejemplo de Codex

Define `ZOTERO_KNOWLEDGE_MCP_TOKEN` en el entorno que inicia el cliente y ejecuta:

```sh
codex mcp add zotero-knowledge --url http://127.0.0.1:23126/mcp/knowledge --bearer-token-env-var ZOTERO_KNOWLEDGE_MCP_TOKEN
```

Los ajustes también ofrecen la dirección y el comando para copiar. Adapta la URL si cambias el puerto. Sigue la documentación del cliente para las variables; no incluyas el token en capturas, repositorios ni informes.

## Límites de conexión

El servidor solo acepta bucle local en el mismo ordenador mientras Zotero está abierto. No hay HTTPS público, acceso remoto por cuenta ni conexiones de retransmisión/nube. Un cliente remoto en la nube no puede alcanzar directamente tu dirección local. Un cliente autorizado puede recibir el contenido permitido y enviarlo a su propio modelo.

Consulta esquemas y compatibilidad en la [referencia MCP para desarrolladores](https://github.com/lianghx123/zoteroknowledgemcp/blob/main/docs/development/mcp.md).
