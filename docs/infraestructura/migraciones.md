# Crear, aplicar y recuperar migraciones

Ejecutar los comandos desde la raíz del repositorio. El runner es [infra/database.mjs](../../infra/database.mjs); [schema-verify](../../infra/schema-verify.mjs) compara la revisión con el esquema real. Las migraciones requieren un operador con configuración administrativa custodiada. CI/CD nunca recibe esa conexión administrativa remota.

## 1. Preparar el cambio

Crear la rama base desde staging y su rama de integración siguiendo [Gitflow](ci-cd.md). Determinar el propietario y leer sus migraciones completas, el modelo de datos y los consumidores afectados.

| Propietario | SQL versionado | Permisos runtime |
|---|---|---|
| Adquisición y Riesgo | `backend/acquisition-risk/migrations/` | `backend/acquisition-risk/runtime-grants.json` |
| Identidad, Consentimiento y Ecosistema | `backend/identity-consent-ecosystem/migrations/` | `backend/identity-consent-ecosystem/runtime-grants.json` |
| Pólizas, Siniestros y Pagos | `backend/policy-claims-payments/migrations/` | `backend/policy-claims-payments/runtime-grants.json` |

Añadir un archivo nuevo con el siguiente número disponible del propietario: `NNNN_descripcion.sql`, por ejemplo `0006_clients_status_index.sql` en Identidad. El runner ordena los nombres `.sql` lexicográficamente y guarda el nombre completo como versión; coordinar la numeración si hay ramas concurrentes. Las secuencias son propias de cada módulo, no globales. No renombrar, reutilizar ni editar un archivo que ya se aplicó en algún ambiente.

Ejemplo ilustrativo, sin crear el archivo ni aplicar SQL como parte de esta guía:

```sql
CREATE INDEX clients_status_lookup ON clients (status);
```

El runner selecciona el esquema del propietario con `SET search_path` en la conexión. No crear objetos en `public`, FK entre propietarios ni accesos a tablas ajenas. No incluir control manual del ledger, limpieza de guardas o creación de roles en una migración. Separar los cambios de estructura de cualquier backfill significativo; especificar su ejecución, reanudación y validación antes de implementarlo.

Mantener compatibilidad con el código que seguirá funcionando durante el cambio: primero ampliar el esquema, después publicar los consumidores y finalmente retirar estructuras obsoletas en una entrega posterior, cuando sus dependencias ya no existan. Revisar datos existentes, nulabilidad, valores por defecto, restricciones, duplicados, cardinalidades e impacto de índices; no deducir reglas financieras de una conveniencia del DDL.

## 2. Permisos, pruebas y documentación

Al crear una tabla de negocio, añadirla al `runtime-grants.json` del propietario con el mínimo de `SELECT`, `INSERT` y/o `UPDATE` que necesite. `DELETE`, DDL, `ALL`, acceso cruzado y escritura de `schema_migrations` están prohibidos para runtime. `schema_migration_failures` es administrativa y no se lista en ese archivo.

El verificador deriva el catálogo esperado de los grants más ledger y guarda. Una tabla nueva omitida de los grants también hará fallar la comparación; definir conscientemente su acceso antes de incorporarla al modelo actual. Los grants se reconcilian por diferencias después de validar todas las tablas, sin `REVOKE ALL` sobre runtime. No son atómicos: un fallo puede dejar permisos parcialmente aplicados y requiere convergencia/verificación.

Actualizar la guía de datos del módulo y las [pruebas pertinentes](../pruebas.md). Probar la restricción o invariante nueva con datos sintéticos: casos válidos, rechazo de inválidos, instalación desde cero, replay sin cambios y permisos mínimos. La prueba SQL de infraestructura existente está en [schema-smoke](../../infra/schema-smoke.mjs); las reglas del negocio se prueban en su dominio o caso de uso, sin sustituirlas por un test de DDL.

## 3. Validar en local

Requiere Node/npm del proyecto, Docker y estado local compatible con la revisión. No conectar un checkout viejo a un volumen que contiene migraciones futuras y borrar versiones para hacerlo coincidir; conservar los datos y usar un entorno local aislado si la rama necesita otra línea de esquema.

```sh
npm ci
npm run check
npm run infra:up
npm run test:schema
npm run infra:local:schema-verify
node infra/schema-verify.mjs local --admin
```

`infra:up` inicia Docker, aplica migraciones pendientes y prepara los roles/bindings locales. `test:schema` instala desde cero en una base sintética temporal y comprueba replay, catálogo, restricciones y aislamiento; elimina solo esa base generada. Sus sondas sobre la base persistente usan transacciones sintéticas con rollback. Si se afecta autenticación o integración entre servicios, ejecutar además `npm run test:authentication:sql` y `npm run test:infra` según el flujo.

La primera aplicación registra versión, checksum y fecha en `<esquema>.schema_migrations`. El checksum nuevo normaliza LF; se admite el checksum histórico CRLF equivalente sin reescribir el ledger. Cualquier otro cambio del SQL aplicado falla. Repetir el runner normalmente omite las versiones ya registradas; una guarda pendiente bloquea el replay completo del propietario.

## 4. Aplicar por ambiente antes de integrar

La aplicación administrativa requiere la tarea autorizada y el candidato definitivo aprobado para ese ambiente. Congelar el SQL probado en local/CI; aplicarlo desde ese checkout antes de integrar código que lo necesita. Si se corrige el candidato después de aplicar SQL, conservarlo y añadir otra migración.

Restaurar `.env.infra.<ambiente>`, la CA y `infra/.local/runtime.<ambiente>.json` desde custodia. Ver [acceso y custodia](README.md) y [consultas de solo lectura](consultas-sql.md). No imprimir la URL administrativa ni secretos. Si hay usuarios provisionados sin su estado runtime, `runtime_state_missing` detiene el proceso: restaurar el original, no inventar contraseñas.

Antes de mutar, inspeccionar ledger, catálogo y guardas con una conexión administrativa READ ONLY del ambiente. Una diferencia esperada por la migración pendiente debe distinguirse de un checksum alterado, objetos inesperados o una ejecución parcial. No usar `schema-verify` como preflight que obligue a tener ya aplicada una versión nueva: la comparación estricta es necesaria **después** de aplicar.

Para SQL solamente, el operador usa estos comandos, uno por ambiente y según su autorización:

```sh
node infra/database.mjs provision dev
node infra/schema-verify.mjs dev --admin
node infra/database.mjs verify dev
```

Sustituir los tres argumentos `dev` por `staging` o `prod` para la promoción correspondiente. `provision` recorre los tres propietarios, aplica pendientes y reconcilia permisos; no existe selección de una sola migración o de un solo propietario en su CLI. Si únicamente cambia SQL, este comando evita reprovisionar Hyperdrive. `infra:<ambiente>:up` también modifica recursos Cloudflare y se reserva para cambios de infraestructura que lo requieran.

Después de la verificación administrativa, integrar el PR y esperar Deploy exitoso. CD comprueba esquema, versiones, checksums y permisos con roles runtime antes de publicar; también comprueba SQL/RPC e aislamiento remoto. La verificación administrativa adicional confirma `public` vacío y guardas vacías. CI local no acredita la aplicación remota.

Con el Gitflow vigente, dev puede contener migraciones de varias features. Staging recibe únicamente las migraciones presentes en el candidato de la rama base, ya probado por su rama `-dev`; prod recibe las del release de staging. No copiar datos ni credenciales entre ambientes.

## 5. Fallos, reconciliación y reversión

El runner persiste la intención en `<esquema>.schema_migration_failures` **antes** del DDL. Mantiene `autocommit_before_ddl=on`: `BEGIN/ROLLBACK` no garantiza atomicidad del archivo completo ni del ledger con sus sentencias DDL. La guarda se elimina únicamente al terminar la aplicación correctamente. Un corte de conexión, fallo de COMMIT o error intermedio puede dejar estructura parcial incluso si el ledger tiene checksum.

Ante `migration_reconciliation_required`, detener la ejecución y reconciliar administrativamente. No reintentar a ciegas, editar el SQL registrado, desactivar el ajuste global ni quitar la marca como primer paso.

1. Identificar ambiente, propietario, versión, checksum y causa técnica sin exponer secretos.
2. Inspeccionar la marca, el ledger, `SHOW CREATE TABLE <esquema>.<tabla>` y `SHOW CONSTRAINTS FROM <esquema>.<tabla>` para cada objeto afectado; confirmar qué sentencias persistieron.
3. Si el esquema y ledger están completos, conservarlos y retirar únicamente la marca reconciliada mediante operación administrativa autorizada. Si están incompletos, reparar la estructura y su registro de forma controlada antes de retirar esa marca. Documentar la intervención fuera del producto; no automatizar una eliminación genérica de guardas.
4. Reconciliar los grants pendientes si corresponde y volver a ejecutar las verificaciones administrativa/runtime y de aislamiento. Un `GRANT/REVOKE` también puede sobrevivir al rollback.

Una reversión del Worker no revierte SQL ni datos. Preparar una nueva revisión compatible con el esquema aplicado, preservar los archivos/checksums y promoverla por PR. Desplegar un SHA antiguo cuyo catálogo ya no coincide fallará en el gate; no borrar versiones para forzarlo.

Los detalles del modelo están en [modelo SQL](modelo-datos.md). La [documentación oficial de CockroachDB sobre cambios de esquema](https://docs.cockroachlabs.com/docs/stable/online-schema-changes#schema-change-ddl-statements-inside-a-multi-statement-transaction-can-fail-while-other-statements-succeed) explica la limitación de DDL dentro de transacciones de varias sentencias.
