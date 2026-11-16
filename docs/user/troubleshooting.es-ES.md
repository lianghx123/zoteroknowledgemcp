# Solución de problemas

## Versión o descarga no disponible

Mientras el repositorio sea privado necesitas una cuenta GitHub autorizada. Descarga el XPI, no el archivo fuente. Si falla la instalación, comprueba Zotero y `SHA256SUMS`.

## No hay tarea o falta el PDF

Comprueba que el análisis esté activado y guardado, y que el adjunto sea un PDF local. El complemento no descarga archivos ausentes. Usa **Analizar adjuntos** para elementos ya añadidos. Otros tipos pueden conservar solo metadatos.

## Tarea en cola o fallida

Revisa la fase y los detalles. La cola del proveedor no es trabajo local; progreso desconocido no significa finalización. Comprueba servicio, dirección, credenciales, cuota, red y límites. Reintenta la fase fallida en vez de repetir el alta.

Las tareas aceptadas conservan la identidad original. Tras cambiar de servicio, mantén una configuración compatible de dirección/clave para reanudarlas. Desactivar el análisis no cancela solicitudes en curso.

## Hay texto pero no búsqueda semántica

Comprueba que los modelos estén activados, guardados y aplicados y que la prueba de embeddings funcione. Revisa la fase semántica de las tareas y los avisos de recuperación. Modelo y dimensiones deben coincidir con el espacio vectorial.

**Vectorizar documentos existentes** genera embeddings faltantes y puede gastar cuota. **Reparar el índice de búsqueda** usa los vectores guardados sin generar nuevos embeddings.

## Markdown vacío o antiguo

Espera a la publicación, cierra y abre el PDF correcto y pulsa **M**. El contenido anterior no adopta automáticamente nuevas reglas de análisis: necesita reprocesamiento explícito. Conserva los cambios sin guardar antes de cerrar o reprocesar.

## No se guardan los ajustes

Lee los mensajes de validación. Otra ventana o editor externo puede haber cambiado la configuración. Conserva los valores, recarga y reintenta. Probar la conexión no guarda nada.

## Falla MCP

- Revisa el estado y la dirección real.
- Mantén Zotero abierto y el ordenador activo.
- El cliente debe estar en el mismo ordenador y admitir Streamable HTTP autenticado.
- Comprueba token Bearer, caducidad, bibliotecas y permisos.
- Si el puerto está ocupado, aplica uno libre y actualiza el cliente.

## Desplazamiento PDF lento durante automatización

Los clientes Windows UI Automation pueden activar accesibilidad en Zotero y afectar al desplazamiento. Se observó con el asistente computer-use de Codex en pruebas aisladas. Cierra la sesión y el asistente de esa tarea, reinicia Zotero aislado y compara. No demuestra que todas las instalaciones tengan el mismo problema.

Si persiste, sigue [Asistencia](support.md) con una reproducción mínima y datos depurados.
