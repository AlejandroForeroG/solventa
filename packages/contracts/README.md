# Contratos

Contratos de frontera estables: versionado de la API pública, especificaciones OpenAPI y esquemas de datos que cruzan límites. No contiene entidades, servicios ni reglas de dominio compartidas. El núcleo (`domain`/`application`) de un backend no puede importar este paquete; lo consumen adaptadores, el Worker web y las pruebas.

| Ruta | Contenido |
|---|---|
| `openapi/v<N>.yaml` | Especificación OpenAPI de la versión N. `paths` se llena con cada endpoint que se publica; los componentes comunes (`X-Trace-Id`, `Error`, cabeceras de deprecación) ya existen |
| `src/versions.ts` | Registro de versiones (`apiVersions`) con `deprecatedAt` y `sunset` opcionales |
| `schemas/decision-capture.v1.json` | Esquema de lo que se guarda con cada cotización o decisión para poder reconstruirla |
| `redocly.yaml` | Reglas del linter OpenAPI |

## Versionado de la API

La versión va en la ruta: `/api/v1/...`. Un cambio compatible (campo opcional nuevo, endpoint nuevo) se queda en la versión actual y sube `info.version` (1.0.0 → 1.1.0). Un cambio incompatible (quitar o renombrar un campo, cambiar un tipo, volver obligatorio un campo opcional, endurecer una validación, cambiar el sentido de un código de estado) exige una versión nueva. Las versiones conviven: cada una tiene su propio adaptador de entrada que traduce al mismo caso de uso.

**Una versión nunca se retira salvo que tenga fecha de retiro.** Sin `sunset` es indefinida y no lleva cabeceras. Con `sunset` (día `YYYY-MM-DD`, hora de Bogotá, que empieza a las 00:00 -05:00):

| Momento | Respuesta del Worker web |
|---|---|
| Antes de `sunset` | La versión responde y añade `Deprecation: @<epoch de deprecatedAt>`, `Sunset: <fecha HTTP>` y, si existe una versión posterior, `Link: <ruta equivalente>; rel="successor-version"` |
| Desde `sunset` | 410 `{ "error": "version_retired" }` con el mismo `Link` |

La compuerta vive en `apps/web/worker/api-versions.ts` y se aplica a toda ruta `/api/v<N>/...`; los backends no repiten esa lógica.

### Publicar una versión nueva

1. Copiar `openapi/v<N>.yaml` a `openapi/v<N+1>.yaml`, ajustar `info.version` (`<N+1>.0.0`) y `servers[0].url` (`/api/v<N+1>`).
2. Añadir `{ id: 'v<N+1>' }` a `apiVersions`.
3. Montar el grupo de rutas `/api/v<N+1>` en el backend propietario y enrutar el prefijo en el Worker web.

### Retirar una versión

En `apiVersions`, dar a la versión `deprecatedAt` y `sunset`; en su spec, poner `info.x-sunset` con la misma fecha y `deprecated: true` en cada operación. Las pruebas comprueban que registro y spec coincidan, y que una versión sin fecha no tenga operaciones deprecadas. Los contratos de una versión retirada se archivan en el mismo cambio.

## Linter y pruebas

```sh
npm run lint:openapi     # Redocly sobre openapi/*.yaml
npm run test:contracts   # versionado, registro, coherencia spec-registro y esquema de captura
```

Ambos corren dentro de `npm run check` (CI y despliegue). El hook `pre-commit` ejecuta el linter cuando hay cambios en `openapi/` o `redocly.yaml`, y `pre-push` lo ejecuta siempre; los hooks se pueden omitir, así que CI es el control que bloquea. `no-unused-components` está desactivada mientras los componentes comunes no los referencie ningún endpoint; reactivarla con los primeros endpoints. Con `security-defined`, cada operación debe declarar `security` (`security: []` si es pública).

## Captura histórica

`decision-capture.v1.json` fija qué se persiste con cada decisión: versión del esquema y del contrato de API, `correlationId`, entradas normalizadas (sin PII), fuentes consultadas con su fecha y calidad, estado del consentimiento (`verified` con identificador y versión, `not_required` o `absent`), regla y modelo con sus versiones y el resultado. Evoluciona solo con campos opcionales; un cambio incompatible crea `decision-capture.v2.json`. Encaja con las columnas JSON existentes (`input_snapshot`, `explanation`, `normalized_request`); la versión del contrato de API es la que se guarda en `contract_version`.

## Tipos TypeScript desde OpenAPI (pendiente)

Todavía no se generan. Cuando haya endpoints: usar `openapi-typescript` sobre `openapi/v<N>.yaml` para escribir `src/generated/v<N>.d.ts`, añadir un script `generate` a este paquete (como `@solventa/assets`), versionar fuente y generados juntos y hacer que CI regenere y falle si hay diferencias.
