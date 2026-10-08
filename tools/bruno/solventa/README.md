# Solventa API en Bruno

Abrir esta carpeta como colección en Bruno y elegir `local`, `dev`, `staging` o `prod`. El contrato y el alta de acceso están en la [guía de Identidad](../../../docs/modulos/identity-consent-ecosystem/acceso-api.md); los esquemas en [OpenAPI](../../../packages/contracts/openapi/v1/identity-access.yaml).

| Carpeta | Qué comprueba | Requisito |
|---|---|---|
| `00-public` | Health 200 y sesión inválida 401 | Workers y autenticación web configurados |
| `10-partner` | Emisión de token M2M y permiso de socio 200 | Connect y registro local del socio activos |
| `20-web` | Sesión y permiso del canal web 200 | Sesión de prueba válida y canal habilitado |
| `30-negative` | Sin token, token/cookie inválidos, mezcla de credenciales y método incorrecto | Configuración de verificación del ambiente completa |
| `40-provisioned-negative` | Socio denegado y canal web inhabilitado 403 | Credenciales de prueba con ese estado; ejecutar casos por separado |

No ejecutar toda la colección como si todos los escenarios compartieran el mismo estado: el canal web no puede estar habilitado e inhabilitado al mismo tiempo. Los GET son sondeos, sin efectos de cotización. Las rutas no acreditan consentimiento ni login móvil.

## Variables y secretos

Los ambientes versionan `baseUrl`, `sessionCookieName` y los campos inicialmente vacíos `issuer` y `audience`. Completar estos dos últimos con los valores públicos propios del ambiente según la guía de Identidad. `audience` documenta la configuración esperada por la API; la solicitud M2M no la envía ni permite elegir otra audiencia.

En las variables secretas locales de Bruno, completar cuando se necesiten:

- `m2mClientId` y `m2mClientSecret`: credenciales de la aplicación M2M de prueba.
- `webSessionCookie`: valor sellado de una sesión web de prueba autorizada; sin el nombre ni los atributos de la cookie.
- `deniedPartnerToken`: JWT válido de una credencial local revocada/inactiva o sin `quotes:create`, para el caso 403.

Los archivos `.bru` solo declaran nombres de secretos. Bruno mantiene sus valores fuera del archivo de ambiente según su [documentación de secretos](https://docs.usebruno.com/secrets-management/secret-variables). No reemplazar las variables por valores en requests ni compartir informes con headers, cuerpos de emisión o cookies.

La respuesta de emisión guarda `accessToken` como variable runtime mediante `bru.setVar`, sin `console.log` ni persistencia a environments. Volver a emitirlo al cambiar de ambiente o al expirar. No usar `bru.setEnvVar` para guardarlo: puede escribirlo en disco. El token pertenece al servidor del socio; no se copia a la aplicación móvil o web.

Bruno y el navegador no comparten automáticamente las cookies. El caso web requiere una sesión de prueba suministrada por un flujo autorizado; la colección no lee cookies HttpOnly del navegador. Para verificar el flujo normal sin transferir una sesión, usar el navegador autenticado y el ejemplo `fetch` de la guía. Los casos anónimos mandan una cookie sintética inválida: desactivar el cookie jar al ejecutarlos para evitar otras sesiones.

## Ejecución

1. Preparar local con la [guía de desarrollo](../../../docs/desarrollo.md), o elegir el ambiente desplegado correspondiente.
2. Ejecutar `00-public`. Un 503 de sesión significa que primero debe restaurarse la configuración web.
3. Para socio, completar issuer/audience y secretos de la aplicación registrada. Ejecutar en orden `10-partner/01-token.bru` y `10-partner/02-access.bru`. Sin alta externa el éxito no está disponible.
4. Ejecutar `20-web/01-access.bru` cuando se dispone de sesión de prueba y canal configurado. Una sesión expirada debe refrescarse por `/auth/session` en el flujo que la originó.
5. Ejecutar negativos. `40-provisioned-negative` requiere preparar el estado descrito antes de cada solicitud, sin revocar credenciales compartidas para probar.

Con Bruno CLI ya instalado, desde esta carpeta puede ejecutarse el grupo público sin cookies:

```sh
bru run 00-public --env local --disable-cookies
```

No pasar secretos con `--env-var` en comandos compartidos o registrados. Para comandos e informes consultar las [opciones oficiales](https://docs.usebruno.com/bru-cli/run/options); los informes de llamadas autenticadas deben omitir headers y cuerpos. Las pruebas incluidas comprueban status, error/actor, correlación y ausencia de caché donde aplica. No sustituyen contratos Pact, validación de carga ni el recorrido de cotización.
