# Configurar servicios

Abre **Ajustes de Zotero → Knowledge MCP**. Las pestañas **Análisis de documentos**, **Modelos y búsqueda** y **Conexión MCP** tienen sus propias acciones de guardar o aplicar. Cambiar de pestaña conserva los datos sin guardar.

## Análisis de documentos

| Servicio | Dirección | Modelo |
| --- | --- | --- |
| PaddleOCR | `https://paddleocr.aistudio-app.com/api/v2/ocr/jobs` | `PaddleOCR-VL-1.6` |
| MinerU | `https://mineru.net/api/v4` | `vlm` |

Selecciona el servicio, introduce su clave API o token, actívalo y guarda. Al cambiar se conservan las credenciales y opciones de cada uno. El modelo está fijado por la selección; cualquier API OCR no es automáticamente compatible.

Las direcciones externas requieren HTTPS; HTTP solo se permite en bucle local. Las URL no pueden incluir contraseñas, parámetros de consulta ni fragmentos. Una tarea aceptada conserva el proveedor y la dirección iniciales; cambiar de servicio no la redirige.

La cola controla ejecución local, tareas remotas seguidas, sondeo, tiempos y límites de archivos/resultados. Empieza con los valores predeterminados. Los tiempos se muestran en segundos y los tamaños en MB (1 MB = 1.048.576 bytes).

## Modelos y búsqueda

El proveedor incluido es **Bailian**. Los modelos predeterminados son `qwen3.7-text-embedding` y `qwen3.7-text-rerank`, con 768 dimensiones. Comprueba que tu cuenta admite modelo, región, dirección y dimensiones.

1. Introduce una dirección, modelo y clave compatibles para embeddings.
2. Configura la reclasificación si la necesitas. Puede enviar pasajes al proveedor; admite clave propia o compartida con embeddings.
3. Prueba cada conexión. Las pruebas usan el formulario actual y no lo guardan.
4. Activa los servicios, elige **Guardar y aplicar** y comprueba el estado aplicado.
5. Usa **Vectorizar documentos existentes** para generar embeddings que falten.

Dejar vacío el campo de una clave guardada la conserva. Conexión correcta, configuración guardada y estado aplicado son indicadores distintos.

Cambiar modelo de embeddings, dirección o dimensiones cambia el espacio vectorial. Cuando se solicite, conserva los vectores anteriores, bórralos o cancela. No se mezclan espacios incompatibles.

**Reparar el índice de búsqueda** reconstruye el índice local con vectores guardados sin pedir nuevos embeddings. **Vectorizar documentos existentes** puede llamar al proveedor y consumir cuota. Consulta [Solución de problemas](troubleshooting.md).

## Conexión MCP

MCP local es opcional y está desactivado por defecto. Actívalo para un cliente local, aplica el puerto y crea un token con bibliotecas y permisos explícitos. Sigue la [guía MCP](mcp.md).
