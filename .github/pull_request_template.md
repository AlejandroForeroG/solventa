## Cambio

Describe el problema y el comportamiento final.

## Documentación

Enlaza las guías creadas o actualizadas con URLs de GitHub de esta rama. Si una corrección interna no afecta documentación, explica por qué; toda feature debe documentarse.

## Validación

Indica las comprobaciones ejecutadas, sus resultados y los límites pendientes. Si cambia una funcionalidad, actualiza sus pruebas unitarias y conserva las regresiones pertinentes.

Enlaza la revisión de Codex completada sobre el SHA final e indica cómo se resolvieron sus hallazgos. No integrar mientras la revisión esté pendiente o exista un hallazgo que requiera decisión del usuario.

## Candidato

Para staging: enlaza la rama base, su rama `-dev` y el Deploy exitoso de dev que contiene esa revisión. Para prod: enlaza el Deploy exitoso del candidato staging. Declara migraciones o cambios de configuración requeridos antes de integrar.
