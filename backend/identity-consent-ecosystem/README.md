# Identidad y autenticación

Worker privado con esquema, rol runtime y Hyperdrive propios. WorkOS AuthKit
verifica la identidad mediante OAuth con PKCE. Web enruta `/auth/*` por Service
Binding; Identidad conserva su usuario interno, estado y sesión. SDK y SQL
permanecen en adaptadores.

| Ruta | Método | Resultado |
|---|---|---|
| `/auth/login` | GET | Redirección AuthKit; transacción OAuth cifrada, válida diez minutos |
| `/auth/callback` | GET | Valida state/PKCE, token y correo; registra usuario/sesión y redirige a `/` |
| `/auth/session` | GET | 200 con `authenticated` y `principal: {clientId, subjectToken}`; 401 sin sesión válida |
| `/auth/logout` | POST | Exige Origin propio, revoca sesión local y devuelve `logoutUrl` para completar salida del proveedor |

Respuestas sin caché. Tokens y refresh tokens quedan en una cookie sellada
`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, sin Domain y con prefijo `__Host-`
en remotos. Local permite HTTP solo en localhost. No entregar tokens a React ni
guardarlos en localStorage, SQL, logs o Git. El adaptador verifica firma e issuer
del cliente configurado. Si expira el access token, usa refresco del SDK; un fallo
transitorio devuelve 503 y conserva la cookie. Las respuestas de validación
fallida del proveedor tampoco borran cookies: una petición concurrente puede haber
instalado una sesión renovada. Si SQL no encuentra un principal activo y vigente,
la respuesta 401 sí borra la cookie; logout también la elimina. Cada sesión comprueba usuario activo,
pertenencia, vencimiento y revocación local en SQL. Duración local máxima: siete días.

El alta confirma cliente, vínculo, sesión, auditoría y evento de creación en una
transacción propia. Una carrera de alta falla de forma segura y permite reiniciar
el login. Logout revoca primero en SQL y después intenta la salida al proveedor.
La revocación externa desde WorkOS se refleja al expirar/refrescar el token:
todavía no hay consumidor de eventos de revocación del proveedor.

## Configuración y ejecución

Cada ambiente requiere aplicación WorkOS propia, Redirect URI exacta,
Initiate login URI y Sign-out URI. `AUTH_ORIGIN` y `AUTH_REDIRECT_URI` están en
Wrangler. Secretos: `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` y `AUTH_COOKIE_PASSWORD`
(64 caracteres hex aleatorios, custodiados por ambiente). No compartir claves.
Producción requiere habilitar el ambiente WorkOS antes de configurar credenciales.

En Authentication, habilitar correo/contraseña y Magic Auth; mantener deshabilitados
los proveedores sociales mientras no exista una integración aprobada. La cuenta
de Outlook del operador no implica habilitar Microsoft como proveedor del producto.

En Branding, usar los SVG de `packages/assets/brand`: logo e icono verdes para
modo claro y blancos para oscuro, IBM Plex Sans y apariencia System. Colores
claro/oscuro: fondo `#F7F6F3`/`#062F2A`, botón y enlaces `#0B6B5F`/`#12D9B8`,
texto del botón `#FFFFFF`/`#062F2A`. El editor permite copiar únicamente branding
entre ambientes; guardar y comprobar la página AuthKit real después de copiar.
El idioma sigue la localización de AuthKit según las preferencias del navegador.

Local: restaurar esos tres valores en `.dev.vars` de este backend. Desde la raíz,
ejecutar `npm run infra:up`, `npm run build --workspace @solventa/web` y
`npm run dev:backend`. Abrir `http://localhost:8787`. Vite en 5173 redirige `/auth`
al Worker; el callback regresa a 8787.

CD restaura `IDENTITY_AUTH_JSON` desde cada GitHub Environment: objeto con
`environment` y `secrets` con las tres claves anteriores. Custodia local:
`infra/.local/identity.<ambiente>.secrets.json`; nunca imprimirlo. Configuración
ausente o un ambiente diferente bloquea el despliegue.

Pruebas: `npm run test:authentication` y, con SQL local iniciado,
`npm run test:authentication:sql`. La segunda usa una base temporal independiente
y datos sintéticos; no vacía la base del desarrollador.

## Fronteras pendientes

Una sesión no concede consentimiento, permisos operativos ni acceso a otros
propietarios. Móvil requiere login PKCE propio y almacenamiento seguro nativo;
no reutilizar cookies web ni claves de servidor. Las tablas de dispositivos existen,
pero biometría, registro/revocación de dispositivo y validación nativa requieren
implementación. Una fila no acredita biometría.

Ver [modelo SQL](../../infra/data-model.md), [fronteras](../README.md) y
[operación](../../infra/README.md).
