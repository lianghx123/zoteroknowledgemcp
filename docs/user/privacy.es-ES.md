# Datos y privacidad

Esta página describe la versión preliminar actual. Los proveedores y clientes de IA tienen sus propias condiciones, normas de conservación y costes.

## Datos locales

La base de conocimiento, estados de tareas, contenido extraído, artefactos e índices vectoriales se guardan en `knowledgemcp/`, dentro del directorio Zotero. El esquema SQLite es independiente de la base nativa. Zotero sigue gestionando los adjuntos originales.

El análisis guarda actualmente una clave API reutilizable en texto plano en `parsing.json`; protege directorio y copias. Las claves de embeddings/reclasificación usan el gestor de credenciales Gecko y los ajustes guardan referencias. Los tokens MCP se almacenan como hashes, sin secretos recuperables.

## Envíos externos

| Acción | Datos enviados al servicio configurado |
| --- | --- |
| Análisis de PDF | Archivo PDF seleccionado |
| Embeddings del contenido | Segmentos de texto extraído seleccionados |
| Consulta semántica | Texto de consulta para embeddings |
| Reclasificación opcional | Consulta y pasajes candidatos |
| Acceso MCP autorizado | Contenido solicitado devuelto al cliente |

La búsqueda textual local y la reparación del índice no requieren embeddings. El complemento no ofrece sincronización propia en la nube ni servicio remoto de cuentas. Los clientes externos pueden realizar otras llamadas de red o modelos.

## Copias y eliminación

Cierra Zotero antes de copiar externamente todo el directorio, incluido `knowledgemcp/`. Las instantáneas de actualización de la base no incluyen todos los artefactos e índices y no son una copia completa.

Desactivar o desinstalar conserva datos. Restablecer el directorio Zotero o cambiar de cuenta puede eliminarlo, incluidos datos e instantáneas del complemento. Guarda las copias fuera. No hay restauración completa integrada ni reducción de versión del esquema.

## Informar sin divulgar

Antes de compartir registros, revisa texto PDF, títulos, rutas locales, URL y credenciales. No adjuntes directorios Zotero, bases, tokens ni claves a incidencias públicas. Consulta [Asistencia](support.md).
