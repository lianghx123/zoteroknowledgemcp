# Buscar documentos y pasajes

Selecciona un ámbito y un modo de **Base de conocimiento** en el menú de búsqueda de Zotero. Introduce una consulta no vacía y pulsa **Intro**. Cambiar solo el modo conserva la lista; Intro con texto vacío quita el filtro sin llamar al modelo.

| Modo | Base | Requisitos |
| --- | --- | --- |
| Texto | Texto y metadatos locales | Texto publicado para pasajes |
| Semántica | Vectores según significado | Embeddings activados y contenido indexado compatible |
| Semántica mejorada | Búsqueda semántica y reclasificación | Embeddings/reclasificación configurados e índice compatible |
| Fusión | Combina texto y semántica | Canales disponibles; la preparación semántica influye en resultados |

Despliega un resultado con la flecha nativa para ver pasajes, campos y enlaces de origen. Un aviso breve precede a resultados con menor puntuación, que siguen disponibles. La puntuación ordena resultados; no garantiza hechos ni sustituye la lectura de fuentes.

**Mi base de conocimiento** busca en bibliotecas activas. Una biblioteca o carpeta concreta limita el ámbito. La papelera tiene su propio ámbito de recuperación.

## Buscar dentro del PDF abierto

El panel Markdown dispone de búsqueda documental independiente con texto, semántica, semántica mejorada y fusión, aplicada al contenido actual del adjunto. Un resultado navega al bloque de origen; cerrar la búsqueda devuelve el índice.

La búsqueda textual puede funcionar antes de la indexación semántica. Si faltan resultados semánticos, revisa tareas de importación, modelos y recuperación. Consulta [Solución de problemas](troubleshooting.md) antes de reprocesar el PDF.
