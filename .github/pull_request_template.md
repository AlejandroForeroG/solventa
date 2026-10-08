## Cambio

Describe el problema y el comportamiento final.

## Criterios técnicos del incremento

Indica si los criterios proceden de una historia/subtareas consultadas en Jira, del alcance aprobado por el usuario o de una fuente no disponible. Resume solo expectativas técnicas sanitizadas y autocontenidas; conserva enlaces privados y trazabilidad del ticket en Jira/contexto interno. El revisor de GitHub no hereda acceso a Jira ni a la conversación local.

| Criterio | Comportamiento esperado | Código/documentación | Evidencia ejecutada y SHA | Estado y límite |
|---|---|---|---|---|
| C1 | Expectativa observable de este incremento | Archivo o guía enlazada | Ejecución real; pendiente si no existe | Cubierto, fuera del incremento o bloqueado |

Explica el alcance excluido y cualquier bloqueo. No afirmar historia terminada por tener CI o revisión verde. Seguir [revisión de cambios](../docs/revision-cambios.md).

## Documentación

Enlaza las guías creadas o actualizadas con URLs de GitHub de esta rama. Si una corrección interna no afecta documentación, explica por qué; toda feature debe documentarse.

## Validación

Indica las comprobaciones ejecutadas, sus resultados y los límites pendientes. Si cambia una funcionalidad, actualiza sus pruebas unitarias y conserva las regresiones pertinentes.

Enlaza la revisión de Codex completada sobre el SHA final e indica cómo se resolvieron sus hallazgos. No integrar mientras la revisión esté pendiente o exista un hallazgo que requiera decisión del usuario.

## Candidato

Para staging: enlaza la rama base, su rama `-dev` y el Deploy exitoso de dev que contiene esa revisión. Para prod: enlaza el Deploy exitoso del candidato staging. Declara migraciones o cambios de configuración requeridos antes de integrar.
