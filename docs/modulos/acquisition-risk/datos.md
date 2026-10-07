# Datos de adquisición y riesgo

quotes guarda solicitud canónica y clave de idempotencia por socio y sujeto. Reusar una
clave con otro request_hash debe rechazarse en aplicación: UNIQUE solo previene otra fila.
JSON debe contener datos mínimos canónicos, sin PII en claro, secretos ni respuestas
externas sin filtrar. El DDL no inspecciona JSON; validar y tokenizar en los adaptadores.

Perfiles preservan fuente, vigencia y consentimiento por revisión. Decisiones preservan
reglas, contrato e input_snapshot para reconstrucción histórica. Runtime solo puede
leer/insertar perfiles y decisiones, sin alterar esa historia. offer_revisions conserva
los términos inmutables por (offer_id, version), que referencia la póliza. Confirmar
cada cambio de offers, su revisión histórica, auditoría y outbox en una transacción
local. offers es la proyección vigente; nunca reconstruir una oferta anterior desde
esa fila mutable. Runtime no puede actualizar ni borrar offer_revisions. Ofertas distinguen
preliminary y definitive; la aplicación debe impedir emitir desde una preliminar.



Ver [permisos, eventos y operación SQL](../../infraestructura/modelo-datos.md).
