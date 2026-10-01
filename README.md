# Solventa

Monorepo TypeScript con aplicaciones web y móvil y tres backends independientes.

| Ruta | Componente |
|---|---|
| `apps/web` | React y Vite |
| `apps/mobile` | React Native y Expo |
| `backend/acquisition-risk` | Adquisición y Riesgo |
| `backend/policy-claims-payments` | Pólizas, Siniestros y Pagos |
| `backend/identity-consent-ecosystem` | Identidad, Consentimiento y Ecosistema |
| `packages/contracts` | Contratos de frontera |
| `infra` | Configuración operativa |

## Instalación y comprobación

Usar Node.js 22.21.1 y npm 10.9.4. Ejecutar desde esta raíz:

```sh
npm ci
npm run check
```

`check` ejecuta lint, generación de tipos de Workers, TypeScript y builds. El build web produce activos; móvil exporta un bundle Android; backend solo empaqueta mediante `wrangler deploy --dry-run`. No se despliega infraestructura. CI ejecuta las mismas comprobaciones.

## Desarrollo local

```sh
npm run dev:web
npm run dev:mobile
npm run dev:acquisition
npm run dev:policy
npm run dev:identity
```

Web usa el puerto 5173. Los Workers usan 8787, 8788 y 8789, respectivamente, con una ruta `/health` de identificación. El móvil requiere un dispositivo compatible o emulador para validar capacidades nativas.

## Límites técnicos

Cada backend reserva `domain`, `application`, `application/ports` y `adapters`. Los SDK pertenecen a los adaptadores. Cada propietario mantendrá sus migraciones y acceso a datos; los otros dominios consumirán contratos en vez de consultar sus tablas.

Esta versión es scaffolding: pantallas iniciales y procesos HTTP mínimos, sin recorridos de negocio, autenticación, base de datos, proveedores ni bindings remotos. `packages/contracts` está vacío. Los builds no acreditan pruebas funcionales, contratos, seguridad o ejecución móvil nativa.

Las plantillas se basan en las guías oficiales de [Vite](https://vite.dev/guide/), [Expo](https://docs.expo.dev/get-started/create-a-project/) y [Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/).
