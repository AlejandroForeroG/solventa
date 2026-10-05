# Modelo SQL base

Las migraciones implementan los agregados de la arquitectura con UUID, timestamps,
versiones y restricciones locales. Los nombres SQL, tipos y estados iniciales son
decisiones de implementación del modelo conceptual. Las máquinas de estado y la
autorización por usuario se completan en los casos de uso.

| Propietario | Tablas de negocio |
|---|---|
| identity | clients, external_identities, partners, partner_credentials, consents, registered_devices |
| acquisition | quotes, risk_profiles, underwriting_decisions, offers, offer_revisions, signal_refresh_jobs |
| policy | policies, claims, indemnities, payments, evidence_metadata |

Cada propietario añade audit_events, outbox_events e inbox_events: 26 tablas, además
de tres registros administrativos schema_migrations. No hay FK entre esquemas;
referencias externas se validan por contrato o evento, nunca por consulta a tablas ajenas.

## Identidad y consentimiento

clients.id identifica al usuario interno; subject_token es la referencia opaca compartida.
external_identities vincula un sujeto externo verificado por servidor, único por proveedor
y sujeto. No aceptar ese sujeto directamente de un formulario. No hay contraseñas ni
tokens de sesión en SQL y no se fija un proveedor OAuth/OIDC.

registered_devices registra dispositivos tras autenticación principal; no guarda huellas,
rostros ni plantillas biométricas. La custodia segura y biometría pertenecen al dispositivo;
una fila de dispositivo no autentica peticiones. partner_credentials guarda referencias
y scopes, no claves en claro. Autenticación de socios y sesión de usuario son distintas.
Permisos por usuario y cuotas se completan junto con sus casos de uso.

Consentimiento conserva propósito, scopes, fuente, vigencia y revocación por (id, version).
Cambiar alcance exige otra revisión. El adaptador debe controlar esta regla y concurrencia:
el rol posee UPDATE sobre consents; el DDL no garantiza inmutabilidad de todos sus campos.
Cada uso de señales comprueba autorización fresca en Identidad. El consentimiento
guardado en un perfil o mensaje no concede acceso.

## Historia, dinero y evidencia

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

Pólizas preservan coberturas y versión de oferta. Money usa DECIMAL(19,4) y moneda,
nunca float. Claves únicas limitan duplicados; las transiciones válidas y conciliación
con terceros siguen siendo responsabilidad de los casos de uso. FK compuestas mantienen
indemnización, siniestro y pago dentro de la misma póliza. Tener tablas no implementa
las operaciones ni acredita cumplimiento PCI-DSS.

evidence_metadata guarda clave R2, tamaño, checksum, estado y retención. verified exige
verified_at; la aplicación comprueba el objeto y checksum. SQL y R2 no comparten transacción.

## Eventos y permisos

Confirmar resultado, auditoría y outbox en una transacción local. Outbox mantiene lease,
intentos y disponibilidad; solo marcar published tras confirmar transporte. Confirmar
efecto e inbox juntos; UNIQUE(event_id, consumer) deduplica por consumidor. Handlers,
Queues, reintentos, DLQ y reconciliación aún requieren implementación.

runtime-grants.json enumera tablas/privilegios propios: sin DELETE, DDL, acceso cruzado
o escritura del ledger. Auditoría e inbox son append-only para runtime. Retención y
mantenimiento requieren un operador administrativo. Estos permisos aíslan backends;
no sustituyen la autorización por usuario ni su consentimiento.

## Operación

Ejecutar npm run infra:up y npm run test:schema desde la raíz. La prueba crea y elimina
solo su base sintética temporal para validar migraciones desde cero y replay. También
verifica restricciones y rollback de transacciones sintéticas en la base local persistente,
sin borrar datos ni crear fixtures permanentes. CI ejecuta la misma prueba.

El operador aplica node infra/database.mjs provision dev (o staging/prod) desde la revisión
aprobada del ambiente, con credenciales administrativas custodiadas. CD no obtiene estas
credenciales ni ejecuta DDL. Aplicar migraciones aditivas antes de desplegar consumidores
que las necesiten; promover código por PR. Rollback de Workers no revierte tablas.
Nunca editar migraciones registradas. Clúster Basic actual de una región; no se afirma HA.

El checksum nuevo normaliza LF; replay también admite el hash CRLF histórico sin
reescribir el ledger. Cualquier otra modificación falla. Los permisos se reconcilian
por diferencias tras validar todas las tablas; no se usa REVOKE ALL sobre runtime.
CockroachDB puede conservar GRANT/REVOKE pese al rollback. Un fallo intermedio puede
dejar el plan incompleto, pero no elimina los permisos deseados que ya existían; la
reprovisión converge y luego se verifica. Roles con ALL/grant option exigen revisión
administrativa antes de continuar. No se afirma atomicidad de permisos.

schema_migration_failures es una tabla administrativa, sin permisos runtime. El
runner guarda allí la intención antes de iniciar DDL y solo la elimina tras confirmar
la transacción. Si falla o se interrumpe, bloquea replay incluso si existe un checksum
en el ledger: CockroachDB puede confirmar DML y fallar ALTER TABLE con XXA00.
El operador debe comprobar SHOW CONSTRAINTS/SHOW CREATE TABLE y el ledger de esa
versión. Si el esquema está completo, conserva el ledger y elimina únicamente su
marca; si está incompleto, reconcilia el DDL y su ledger antes de quitar la marca.
No borrar marcas ni volver a ejecutar automáticamente sin esa inspección. No editar
el SQL registrado para resolverlo. Véase la [limitación oficial de CockroachDB](https://docs.cockroachlabs.com/docs/stable/online-schema-changes#schema-change-ddl-statements-inside-a-multi-statement-transaction-can-fail-while-other-statements-succeed).
