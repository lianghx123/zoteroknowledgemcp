# Procesar el primer documento

Empieza con un documento cuyo PDF ya esté disponible localmente en Zotero. Se enviará al servicio de análisis configurado; revisa sus condiciones antes de usar material confidencial.

## 1. Configurar el análisis

Abre **Ajustes de Zotero → Knowledge MCP → Análisis de documentos**. Selecciona **PaddleOCR (PaddleOCR VL-1.6)** o **MinerU (VLM)**, introduce las credenciales, activa el análisis y guarda. Consulta las direcciones en [Configurar servicios](configuration.md).

## 2. Añadir el documento

En una vista bibliográfica nativa de Zotero, haz clic derecho y elige **Añadir a la base de conocimientos** y el destino. El complemento incorpora metadatos y pone en cola los PDF aptos. Repetir el alta en la misma ubicación no duplica el recurso.

Un elemento sin PDF puede conservar metadatos, pero estos solos no generan texto extraído.

## 3. Seguir el procesamiento

Abre **Tareas de importación**. El flujo agrupa:

1. Añadir a la base de conocimiento.
2. Extraer contenido del documento.
3. Preparar búsqueda semántica, si está activada.

La extracción comprende preparación, carga, espera del proveedor, análisis, descarga y guardado local. El porcentaje de páginas solo describe la extracción, no todo el flujo. Revisa los errores y utiliza cancelar o reintentar. Reintentar la fase vectorial no vuelve a cargar el PDF.

## 4. Leer el resultado

Abre el PDF en el lector nativo y pulsa **M**. Si estaba abierto antes de terminar, ciérralo y vuelve a abrirlo. Usa el índice, la búsqueda y las vistas previas de citas; consulta [Lectura y edición](reader.md).

## 5. Buscar o conectar un cliente

El texto publicado permite búsquedas sin embeddings. Para búsqueda semántica, configura y activa los modelos y espera a la indexación. Después puedes [buscar](search.md) o [conectar un cliente local de IA](mcp.md).
