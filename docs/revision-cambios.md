# Revisar cambios contra criterios de aceptación

Jira conserva la fuente operativa de las historias y sus subtareas. El repositorio conserva código, contratos, pruebas y documentación técnica vigente. Esta guía permite revisar un incremento local o un PR sin trasladar backlog, planificación, responsables, documentos académicos ni contenido privado indiscriminado al producto.

## Preparar el alcance antes de implementar o revisar

1. Leer la historia completa, sus criterios de aceptación y las subtareas pertinentes mediante una fuente autorizada. No inferir criterios del título ni del nombre de una rama. Leer también arquitectura, contratos y guías del módulo afectado.
2. Identificar el incremento concreto: comportamiento que entrega este PR, consumidores/dependencias afectados y lo que queda fuera. Dividir criterios amplios en comprobaciones técnicas observables sin cambiar la intención de la historia.
3. Si no hay acceso al ticket, declarar la fuente ausente y los criterios que no pudieron verificarse. No afirmar cumplimiento de Jira ni inventar una historia. Una tarea sin ticket identificado puede usar el alcance técnico aprobado explícitamente por el usuario, identificado como esa fuente; si falta una decisión imprescindible, consultarla antes de implementar el comportamiento dependiente.
4. Mantener la trazabilidad de cada comprobación con su criterio/subtarea original en Jira o en notas internas del repositorio padre, junto al enlace del PR, SHA revisado y fecha de consulta. Si cambia el criterio durante la implementación, volver a leerlo y actualizar alcance, código, pruebas y resumen de revisión.

Esta lectura no autoriza cambiar estados, responsables, compromisos ni criterios de Jira.

## Entregar contexto real al revisor de GitHub

El revisor automático no hereda una conversación local ni un conector de Jira disponible en otro chat. Una instrucción «consulta Jira» o un enlace privado inaccesible no le entrega los criterios. Antes de pedir revisión, completar la [plantilla de PR](../.github/pull_request_template.md) con un resumen técnico autocontenido y sanitizado:

- Indicar la fuente de criterios: historia/subtareas consultadas, alcance aprobado por el usuario o fuente no disponible. No publicar claves/enlaces privados del ticket, credenciales, PII, datos del socio, conversaciones, responsables o calendario.
- Expresar expectativas observables del incremento con identificadores locales como C1/C2. Incluir contratos, errores, autorizaciones o límites necesarios para juzgar el cambio; no copiar la historia completa ni la planificación.
- Relacionar cada criterio con archivos/guías accesibles en el PR y evidencia realmente ejecutada sobre una revisión identificada. Una referencia privada no cuenta como evidencia disponible al revisor.
- Explicar qué queda fuera y qué sigue bloqueado. Si el texto técnico no puede compartirse de forma segura, mantenerlo en el contexto autorizado y declarar que el revisor de GitHub no puede comprobar ese criterio. No afirmar que el gate lo validó.

Ejemplo de formato, sin representar una historia real ni resultados ejecutados:

| Criterio | Expectativa técnica | Revisión necesaria | Estado inicial |
|---|---|---|---|
| C1 | Una solicitud sin autorización no persiste una decisión ni llama al proveedor | Handler, caso de uso y prueba de rechazo con dependencias en memoria | Pendiente de ejecutar |
| C2 | Cotización y ficha se confirman juntas; un fallo no devuelve éxito | Adaptador/transacción SQL y prueba real de rollback | Pendiente de ejecutar |
| C3 | Una versión retirada devuelve 410 sin invocar el backend | Gate y prueba de routing | Pendiente de ejecutar |

Actualizar el texto del PR antes de la revisión; no guardar copias de criterios por rama dentro de docs. El comportamiento técnico permanente se documenta en la guía existente del módulo. El PR resume el incremento y enlaza esa guía.

## Revisar código y evidencia

Aplicar [Code Review Rules de AGENTS](../AGENTS.md#code-review-rules). La revisión local usa la fuente original autorizada y el resumen del incremento. La revisión en GitHub usa el diff final, las reglas aplicables y el resumen técnico realmente visible; no inventa acceso a Jira.

Para cada criterio aplicable, seguir el flujo completo y comprobar que el código satisface la expectativa: canal/ruta, adaptador, caso de uso, dominio, persistencia, proveedor/consumidor y respuesta, según corresponda. Revisar las garantías pertinentes de autorización/consentimiento, historial de decisiones, compatibilidad, propiedad de datos y fallos. Validar los casos relevantes con [pruebas con propósito](pruebas.md).

Registrar por criterio:

| Estado | Qué significa |
|---|---|
| Cubierto | Implementación y evidencia ejecutada suficientes para esa comprobación y capa; indicar SHA, prueba/ejecución y límites |
| Fuera del incremento | No se entrega en este PR; conservarlo como pendiente en la fuente operativa sin atribuir cumplimiento |
| Bloqueado | Falta código, evidencia, fuente, decisión o dependencia necesaria para un criterio aplicable; explicar el bloqueo |

Una prueba planeada no está ejecutada. Un repositorio en memoria no acredita una transacción SQL; un export móvil no acredita biometría; un smoke no acredita el recorrido de negocio completo. Si la evidencia no corresponde al SHA final, identificar qué cambió y volver a validar lo afectado.

Resolver los hallazgos corregibles dentro del alcance, actualizar pruebas/documentación y pedir revisión de la versión final. Si el hallazgo es ambiguo, contradice requisitos, requiere una decisión de producto o no puede resolverse, explicarlo al usuario y esperar su respuesta antes de integrar. No cerrar una conversación como resuelta sin corregir o acordar expresamente su tratamiento.

## Qué comprueba la automatización

CI ejecuta las suites y controles programados de política Git, arquitectura, contratos, tipos, lint, builds e integración SQL. El gate de revisión comprueba que Codex haya terminado sobre el SHA actual y GitHub aplica sus protecciones/conversaciones. Sus detalles operativos pertenecen a [CI/CD](infraestructura/ci-cd.md).

El gate no recupera historias de Jira ni contrasta automáticamente sus criterios. AGENTS y el resumen del PR guían una comprobación explícita del revisor; no son un verificador determinista de aceptación. Una revisión Completed puede contener hallazgos y no significa aprobación humana, aceptación integral ni historia terminada. Evaluar hallazgos y evidencia antes de integrar, y mantener cualquier decisión de cierre en Jira bajo su autorización propia.

La [documentación oficial de OpenAI sobre reglas de revisión](https://learn.chatgpt.com/docs/agent-configuration/agents-md#add-code-review-rules) indica usar `## Code Review Rules` en el AGENTS aplicable. Por eso las reglas generales están en la raíz y esta guía contiene el procedimiento; los controles mecánicos permanecen en CI.
