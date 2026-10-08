# Acceso a la API

Identidad comprueba la autenticación y el permiso `quotes:create` para socios y para el canal web. Los endpoints de esta guía son sondeos de acceso: devuelven el actor autorizado, sin crear cotizaciones ni consultar señales o consentimiento. El contrato público está en [OpenAPI](../../../packages/contracts/openapi/v1/identity-access.yaml) y las solicitudes reproducibles en [Bruno](../../../tools/bruno/solventa/README.md).

## Ambientes

| Ambiente | URL base |
|---|---|
| local | `http://localhost:8787` |
| dev | `https://solventa-web-dev.ja-forerog1.workers.dev` |
| staging | `https://solventa-web-staging.ja-forerog1.workers.dev` |
| prod | `https://solventa-web-prod.ja-forerog1.workers.dev` |

Cada ambiente tiene su configuración, credenciales y registros propios. La ruta pública entra por el Worker web; los backends son privados. La presencia de la ruta en código no aprovisiona una aplicación M2M ni sus permisos en WorkOS.

## Elegir la identidad

| Consumidor | Credencial | Comprobación |
|---|---|---|
| Servidor de un socio | Access token JWT de WorkOS Connect M2M, enviado como `Authorization: Bearer <token>` | Firma, issuer, audience, claims, scopes y registro local vigente del socio/credencial |
| Navegador web de Solventa | Cookie sellada de la [sesión existente](autenticacion.md) | Sesión WorkOS, usuario/sesión local y credencial del canal web de este ambiente |
| Aplicación móvil | Flujo nativo pendiente | No usar el secreto M2M ni las cookies web como solución móvil |

`subjectToken` es el identificador seudónimo interno del cliente. No es un access token y no autentica peticiones. Tampoco sirve el secreto de `/internal/infra`, reservado al diagnóstico operativo. Una sesión de usuario no acredita por sí sola un socio, un permiso de negocio ni consentimiento.

## Socio: preparar WorkOS y obtener un token

1. En el ambiente WorkOS correspondiente, preparar una organización para el socio y una aplicación Connect M2M asociada; habilitar el alcance `quotes:create` y crear sus credenciales según la [guía oficial de M2M](https://workos.com/docs/authkit/connect/m2m).
2. Configurar `WORKOS_CONNECT_ISSUER` y `WORKOS_CONNECT_AUDIENCE` en `backend/identity-consent-ecosystem/wrangler.jsonc`, en `vars` de local o del ambiente remoto correspondiente. Son valores públicos; no añadirlos a `IDENTITY_AUTH_JSON`, que mantiene las tres claves secretas de sesión web. El issuer debe ser el origen HTTPS exacto de AuthKit, con un único subdominio formado por letras minúsculas, dígitos o guiones bajo `.authkit.app`, sin ruta ni barra final. La audience es el client ID del **ambiente**, no el client ID de la aplicación M2M. Los [claims oficiales de Connect](https://workos.com/docs/authkit/connect/token-claims) distinguen ambos valores.
3. Registrar en SQL de Identidad el socio y la credencial local vinculados al issuer, organización y aplicación. Conceder únicamente los scopes acordados y una vigencia acotada. El registro local no crea recursos en WorkOS.
4. Custodiar `client_id` y `client_secret` de M2M en el servidor del socio. Son distintos de `WORKOS_API_KEY` y de la configuración de sesión web de Solventa. El secreto M2M no se entrega a React ni a Expo.

El servidor del socio solicita un token con este intercambio HTTP; los marcadores se sustituyen en memoria con la configuración custodiada, nunca en archivos versionados:

```http
POST <WORKOS_CONNECT_ISSUER>/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<M2M_CLIENT_ID>&client_secret=<M2M_CLIENT_SECRET>&scope=quotes%3Acreate
```

Usar `access_token` de la respuesta para llamar `GET /api/v1/access/partner`. Renovar solicitando otro token antes de su expiración; este flujo no representa un usuario ni requiere copiar la sesión web. No guardar tokens o secretos en SQL, logs o Git. Los errores de emisión provienen de WorkOS y no usan el formato de errores de Solventa.

Los valores `WORKOS_CONNECT_*` parten vacíos hasta completar el alta externa por ambiente. Si falta esa configuración, una verificación de token de socio responde `503 access_unavailable`. No sustituirla por credenciales de otro ambiente. El alta M2M y una llamada real con su token deben verificarse aparte del build y de las pruebas con datos sintéticos.

## Web: sesión y canal autorizado

El navegador inicia sesión mediante `/auth/login` y el callback existente. Después llama a `/auth/session` para comprobar o refrescar su sesión y a `/api/v1/access/web` con la cookie del mismo origen. La respuesta de acceso incluye el principal interno; no entrega tokens al navegador.

```js
const session = await fetch('/auth/session', { credentials: 'same-origin' });
if (!session.ok) throw new Error('session_unavailable');
const access = await fetch('/api/v1/access/web', { credentials: 'same-origin' });
const result = await access.json();
if (!access.ok) throw new Error(result.error);
// result.actor identifica el canal y el principal autorizado.
```

El canal web es una credencial de servidor con `provider='solventa-web'` y `credential_reference=APP_ENV`. Debe pertenecer a un socio activo, estar vigente/no revocada y tener `quotes:create`. Su ausencia devuelve 403 aunque el usuario haya iniciado sesión. El cliente nunca selecciona el `partnerId`, el `credentialId` ni el `clientId` que se consideran autenticados. La ruta web rechaza con 400 una cabecera Authorization para impedir mezclar tipos de credencial.

La comprobación de acceso no refresca la cookie: si el token de sesión caducó, usar `/auth/session` y volver a intentar el sondeo una vez, según su resultado. Los futuros adaptadores de escrituras web deben enviar el método y el Origin reales al RPC: POST/PUT/PATCH/DELETE exigen Origin igual al configurado; local también admite `http://localhost:5173`. El RPC admite esos métodos y GET/HEAD; no admite OPTIONS. Los sondeos de esta guía solo admiten GET. No hay una API CORS genérica para páginas de terceros.

## Respuestas

`GET /api/v1/access/partner` y `GET /api/v1/access/web` comprueban el permiso fijo `quotes:create`. No reciben un identificador de actor ni un scope elegido por el cliente. Un ejemplo sintético de respuesta web:

```json
{
  "actor": {
    "kind": "web",
    "partnerId": "10000000-0000-4000-8000-000000000001",
    "credentialId": "20000000-0000-4000-8000-000000000001",
    "scopes": ["quotes:create"],
    "principal": {
      "clientId": "30000000-0000-4000-8000-000000000001",
      "subjectToken": "40000000-0000-4000-8000-000000000001"
    }
  },
  "traceId": "50000000-0000-4000-8000-000000000001"
}
```

El actor socio tiene `kind:'partner'` y no incluye `principal`. Sus scopes efectivos son la intersección del JWT y de la credencial local; un permiso en uno solo no concede acceso. `X-Trace-Id` preserva un UUID válido de entrada o se genera en el servidor, y coincide con `traceId` del cuerpo. Las respuestas llevan `Cache-Control: no-store`.

| HTTP | `error` | Interpretación |
|---|---|---|
| 400 | `invalid_request` | Entrada inválida para la comprobación |
| 401 | `unauthorized` | Credencial de autenticación ausente, inválida o expirada; sesión local de usuario inválida |
| 403 | `forbidden` | Socio/credencial local ausente, inactiva, expirada o revocada; scope insuficiente u Origin no autorizado |
| 405 | `method_not_allowed` | El sondeo solo acepta GET |
| 503 | `access_unavailable` | Configuración ausente o verificación/SQL no disponible |

Los errores de acceso incluyen únicamente el código canónico y el UUID de correlación, sin datos del proveedor. Si no puede verificarse identidad o permiso, no se continúa con una operación protegida.

## Contrato entre backends

Identidad expone por Service Binding el método `authorizeApiAccessV1`. No es una ruta HTTP pública. Adquisición puede usar su binding existente de Identidad antes de invocar el caso de uso de cotización. El adaptador consumidor construye una de estas entradas a partir de la petición real:

```ts
{ kind: 'partner', token, scope: 'quotes:create' }
{ kind: 'web', cookie, origin, method, scope: 'quotes:create' }
```

`cookie` contiene el valor de la cookie sellada, no toda la cabecera Cookie. `origin` es la cabecera Origin recibida; `method` es el método real. La respuesta es `{allowed:true,actor}` o `{allowed:false,error,status}`, con status 400, 401, 403 o 503. Esperar la llamada, aplicar el deadline del recorrido y convertir un fallo del RPC en indisponibilidad; nunca continuar con un actor parcial ni con IDs aportados por el cliente. El contexto de actor se obtiene de Identidad y se traduce al puerto propio del consumidor; no importar repositorios ni entidades de otro backend.

Una respuesta positiva vale para esa comprobación y no se almacena como permiso perpetuo. Cada uso verifica firma y estado local vigente; el RPC no renueva cookies. No duplicar llamadas a Identidad sin revisar el límite de una dependencia interna remota del recorrido. La autorización de consentimiento necesaria para señales es una capacidad adicional pendiente.

## Registrar y revocar acceso local

Desde la raíz, ejecutar el operador de Identidad con ambiente explícito y un JSON local fuera de Git:

```sh
node infra/partner-access.mjs local register infra/.local/partner-registration.json
node infra/partner-access.mjs local revoke infra/.local/partner-revocation.json
```

`register` recibe exactamente `partnerCode`, `provider`, `reference`, `scopes` y `expiresAt`. `partnerCode` tiene hasta 64 caracteres minúsculos, números, guion o guion bajo y empieza con letra/número. `scopes` es exactamente `["quotes:create"]`; `expiresAt` es una fecha UTC futura real con formato `YYYY-MM-DDTHH:mm:ssZ` o milisegundos `.sssZ`.

Ejemplo sintético para el canal local; elegir una vigencia futura antes de ejecutar:

```json
{
  "partnerCode": "web-local",
  "provider": "solventa-web",
  "reference": "local",
  "scopes": ["quotes:create"],
  "expiresAt": "2027-01-01T00:00:00Z"
}
```

Para M2M, `provider` es `workos-connect` y `reference` contiene el string producido por `JSON.stringify([issuer, organizationId, applicationId])`, sin espacios añadidos. Usar la organización `org_...` y la aplicación `client_...` verificadas del ambiente. No introducir el client secret ni el token en ese archivo. `revoke` recibe solo `provider` y `reference`, por ejemplo:

```json
{ "provider": "solventa-web", "reference": "local" }
```

El operador usa host/CA de `.env.infra.<ambiente>` y el estado custodiado `infra/.local/runtime.<ambiente>.json`, con el rol runtime `solventa_<ambiente>_identity` y TLS verificado. No ejecuta migraciones ni usa la credencial administrativa para sus operaciones; las tablas deben existir y la custodia debe estar restaurada según [infraestructura](../../infraestructura/README.md).

El alta crea o reutiliza un socio activo y registra la credencial con auditoría en la misma transacción. Una referencia existente devuelve `credential_exists`, incluso si está revocada; un socio inactivo devuelve `partner_inactive`. No reactiva registros. Revocar una referencia inexistente devuelve `credential_not_found`; repetir una revocación devuelve `changed:false`. La salida satisfactoria contiene ambiente, acción, IDs y `changed`, sin la referencia externa ni secretos. La recuperación de una credencial web ya revocada requiere un procedimiento explícito posterior; no borrar su historial para repetir el alta.

## Persistencia y límites

Identidad conserva `partners` y `partner_credentials`; cada llamada consulta su vigencia. La referencia M2M se forma como `JSON.stringify([issuer, organizationId, applicationId])`, usando claims ya verificados. SQL conserva identificadores y scopes, sin JWT, client secret ni cookie. La revocación local bloquea usos posteriores aunque el JWT siga firmado y dentro de su expiración. La verificación JWT no acredita revocación inmediata en WorkOS: no se hace introspección por petición.

Esta base no implementa cotización, consentimiento, cuotas, biometría, autorización móvil, Pact ni un catálogo de permisos para todos los futuros recursos. El alta y la revocación local tienen auditoría transaccional; los sondeos no generan todavía auditoría durable de rechazos ni alertas automáticas. La implementación de cada operación debe incorporar sus reglas, autorización de recurso, persistencia y pruebas. La referencia de sesión web permanece en [autenticación](autenticacion.md); la de evolución pública, en [contratos](../../compartidos/contracts/README.md).

## Comprobaciones

Desde la raíz: `npm run test:authentication` valida sesión, verificación JWT, autorización y adaptador HTTP con datos sintéticos; `npm run test:contracts` comprueba el registro de versión/esquemas, y `npm run lint:openapi` valida la especificación. Con SQL local preparado, `npm run test:partner-access:sql` ejercita persistencia de acceso en una base temporal. Estas pruebas no crean aplicaciones WorkOS ni demuestran emisión M2M real. Los sondeos y casos manuales están en la colección Bruno enlazada al inicio.
