# Operación de desarrollo

## Local

Requiere Node 22.21.1, npm 10.9.4 y Docker con Compose. Desde la raíz:

```sh
npm ci
npm run infra:up
npm run check
npm run test:infra
npm run dev:backend
```

Compose usa CockroachDB 26.2.0, un nodo y un volumen persistente. Un proceso inicial genera CA y certificados; el nodo y los clientes verifican TLS. Solo se publican `127.0.0.1:26258` (SQL) y `127.0.0.1:8088` (consola HTTPS). La consola usa la CA local y requiere credenciales administrativas. `infra:up` puede repetirse: aplica migraciones pendientes y conserva contraseñas y datos.

`infra:down` detiene contenedores sin borrar el volumen. Certificados, contraseñas, configuraciones locales Wrangler y token de diagnóstico están ignorados por Git. Conservar `infra/.local` junto al volumen; perder las contraseñas exige recuperación administrativa. No compartir estos archivos ni usarlos en producción.

La base `solventa_local` tiene tres propietarios lógicos:

| Backend | Esquema | Binding |
|---|---|---|
| acquisition-risk | acquisition | ACQUISITION_DB |
| identity-consent-ecosystem | identity | IDENTITY_DB |
| policy-claims-payments | policy | POLICY_DB |

Cada rol runtime puede leer su registro de migraciones; no puede consultar los demás esquemas ni crear tablas. El aprovisionador utiliza una conexión administrativa separada. Las futuras migraciones deben otorgar explícitamente el DML mínimo de sus tablas al rol propio; nunca DDL ni privilegios sobre otro propietario. `infra:verify` comprueba permisos con consultas reales.

Cada backend mantiene sus SQL en `migrations/`. El registro conserva versión, checksum y fecha; modificar una migración aplicada produce un error. La inicial solo fija la línea base con `SELECT 1`. No crea tablas de negocio.

`test:infra` inicia temporalmente cuatro Workers en 8790 y verifica SQL, RPC, rechazo de tokens ausentes o inválidos, activos web y rutas de negocio deshabilitadas. El token local se genera en `apps/web/.dev.vars`; no se imprime. `/health` es liveness; `GET /internal/infra` exige `Authorization: Bearer <DEV_INFRA_TOKEN>` y devuelve 503 si una dependencia no está disponible.

## Cloudflare y CockroachDB: dev

La cuenta configurada es `803fd559877aae8f638140610f106857`. El perfil Wrangler esperado es `solventa-universidad`; puede seleccionarse otro perfil autorizado mediante `CLOUDFLARE_PROFILE`, pero la cuenta destino permanece fija. Autenticarse con `wrangler login --profile solventa-universidad`.

Crear `.env.infra.dev` local e ignorado con `DATABASE_URL` de una conexión administrativa y `DATABASE_CA_FILE` de la CA del clúster. Esta CA pública se registra en Cloudflare para verificar el origen. No copiar los certificados cliente ni las variables locales. La URL debe apuntar al clúster dev autorizado, con privilegios para crear `solventa_dev`, esquemas y roles. El script no crea ni cambia el plan del clúster.

El ambiente remoto tiene un aprovisionador designado. Los demás desarrolladores usan su entorno local y no necesitan credenciales administrativas. El aprovisionador custodia una copia cifrada, fuera de Git, de `infra/.local/runtime.dev.json` y `infra/.local/web.dev.secrets.json` mediante el almacén de secretos autorizado del equipo. Git no es una copia de seguridad de esos archivos.

Para cambiar de máquina o incorporar otro operador, restaurar los dos archivos bajo `infra/.local` con acceso limitado al usuario antes de ejecutar los comandos. Si los usuarios SQL ya existen y falta el estado, el preflight devuelve `runtime_state_missing` antes de modificar la base o los Hyperdrives. Recuperar el estado original desde custodia y repetir. Si se perdió definitivamente, requiere recuperación administrativa coordinada: rotar los tres usuarios y actualizar sus Hyperdrives juntos, además del secreto de diagnóstico si se perdió. El script no hace esa rotación automáticamente. No ejecutar aprovisionadores concurrentes sobre el mismo ambiente.

```sh
npm run infra:dev:up
npm run deploy:dev
npm run infra:dev:verify
```

`infra:dev:up` aplica migraciones, comprueba aislamiento, crea o actualiza exclusivamente los Hyperdrives de este entorno y guarda sus IDs en las configuraciones dev. Cada Hyperdrive usa su rol propio, caché deshabilitada, TLS `verify-full` y límite de cinco conexiones al origen. El aprovisionador no imprime URL, contraseñas ni token de Cloudflare. Las credenciales administrativas nunca se enlazan a un Worker.

El despliegue publica primero Identidad y Pólizas, después Adquisición y finalmente web. Genera un secreto aleatorio persistido en `infra/.local/web.dev.secrets.json` y lo sube con `--secrets-file`; el secreto es obligatorio. Los backends tienen `workers_dev: false` y `preview_urls: false`. Solo web tiene dirección dev pública: activos y liveness son públicos y el diagnóstico exige el secreto. Las rutas de negocio están cerradas. La dirección se registra localmente en `infra/.local/dev-endpoint.json`.

La comprobación remota valida configuración Hyperdrive, SQL vía Workers, RPC, permisos del diagnóstico y exposición privada de backends. No mide latencia, resiliencia, alertas, cumplimiento PCI ni seguridad integral. El clúster dev compartido entre esquemas constituye un fallo común: el aislamiento lógico no equivale a clústeres independientes.

CI valida código y entorno local; no contiene credenciales de despliegue. El despliegue dev es una operación explícita. No existe ambiente productivo configurado.

Referencias: [Hyperdrive y TLS](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/), [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), [secretos](https://developers.cloudflare.com/workers/configuration/secrets/).
