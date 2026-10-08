# Estándar de endpoints y decisiones de negocio

Aplicar esta guía al implementar una ruta de negocio nueva y a sus cambios posteriores. Código y docs del módulo evolucionan juntos. Los ejemplos explican el patrón; no crean un endpoint ni acreditan cotización, Pact o publicación de eventos implementados.

## Captura histórica de cada decisión

[decision-capture.v1.json](../packages/contracts/schemas/decision-capture.v1.json) define la ficha común. Crear **una instancia con los datos usados para cada decisión**, no copias del archivo de esquema por endpoint. Una petición que toma varias decisiones puede producir varias fichas con el mismo `correlationId`; una consulta que no toma una decisión no necesita inventar una.

| Campo | Qué preservar |
|---|---|
| `schemaVersion` | `1` para este esquema |
| `contractVersion` | Versión de entrada, por ejemplo `v1` |
| `correlationId` | UUID de la petición conforme al patrón del esquema |
| `inputs` | Entradas normalizadas mínimas realmente usadas, sin PII ni secretos |
| `sources` | Fuentes consultadas, `capturedAt` y calidad/degradación cuando corresponda; `[]` si no se consultaron |
| `consent` | `verified` con `id` y `version`, `not_required` o `absent`, según la autorización real |
| `rule` | Identificador y versión de la regla aplicada |
| `model` | Identificador y versión del modelo, si se utilizó |
| `outcome` | Resultado del vocabulario del caso de uso |

Ejemplo: un futuro `POST /api/v1/quotes` recibe `{ "amount": 320000000 }` y obtiene una prima ilustrativa de 86.400. El cálculo y la regla real requieren implementación; esta cifra no define una fórmula aprobada.

```ts
const capture = {
  schemaVersion: 1,
  contractVersion: 'v1',
  correlationId: '11111111-1111-4111-8111-111111111111',
  inputs: { amount: 320000000 },
  sources: [],
  consent: { status: 'not_required' },
  rule: { id: 'quote-rating', version: '2026.1' },
  outcome: 'quoted',
};
```

Guardar la cotización, su ficha histórica, auditoría y outbox pertinentes en la transacción de Adquisición. Una llamada `save` solo cumple la regla si su adaptador realmente los confirma juntos. Si falla el commit, no devolver éxito ni prometer auditoría durable. No guardar la ficha únicamente en logs o en una tabla de otro propietario.

Seis meses después, la ficha debe permitir explicar el monto de entrada, la regla `quote-rating` versión `2026.1` y sus fuentes/consentimiento aunque la versión actual sea `2026.2`. Preservar también las entradas o referencias inmutables necesarias y el artefacto histórico de regla/modelo: el nombre de versión solo no permite recalcular una regla eliminada. No reconstruir una oferta vieja desde su proyección mutable. Ver [datos de Adquisición](modulos/acquisition-risk/datos.md).

`not_required` es una conclusión del caso de uso; no un atajo para omitir consentimiento. `absent` no habilita proveedor ni respaldo. Una versión de consentimiento archivada explica el pasado, pero no autoriza uso futuro: verificar vigencia en Identidad antes de consultar, aplicar o reutilizar señales. Generar la ficha en el caso de uso usando tipos propios; validar su representación contra el esquema compartido en la frontera/adaptador o pruebas, sin importar `packages/contracts` al núcleo.

## Dependencias de los endpoints

La fábrica HTTP recibe sus puertos/casos de uso. No crea SQL, WorkOS u otros Workers dentro del handler. El adaptador transforma y valida la entrada; Application orquesta y Domain decide. Mantener las rutas delgadas.

```ts
import { Hono } from 'hono';

type QuoteUseCase = {
  execute(input: unknown): Promise<{ id: string; premium: string }>;
};

export function createHttp(deps: { quotes: QuoteUseCase }) {
  const app = new Hono();
  app.post('/api/v1/quotes', async c => {
    const quote = await deps.quotes.execute(await c.req.json());
    return c.json(quote, 201);
  });
  return app;
}
```

La firma es ilustrativa; definir el DTO validado y los errores del contrato real. En `src/index.ts`, raíz de composición, crear `SqlQuoteRepository`, los adaptadores de Identidad y el caso de uso, e inyectar este último en `createHttp`. En una prueba HTTP o de contrato, inyectar el caso de uso con repositorios/adaptadores en memoria. Así esas pruebas pueden correr sin Docker. Las pruebas SQL del adaptador son una capa separada. No refactorizar `/auth/*` como parte de añadir estas rutas.

## Routing público y cabeceras de versión

La compuerta vive en [apps/web/worker/index.ts](../apps/web/worker/index.ts), con [gateApiVersion y withHeaders](../apps/web/worker/api-versions.ts). Al montar una ruta, cambiar la procedencia de su respuesta y mantener `withHeaders(response, gate.headers)` como último paso. Resolver `gate.response` primero para que una versión retirada no invoque un backend.

```ts
if (path.startsWith('/api/')) {
  const gate = gateApiVersion(path, new Date(), apiVersions);
  if (gate.response) return gate.response;

  const quotesPath = path === '/api/v1/quotes'
    || path.startsWith('/api/v1/quotes/');
  const response = quotesPath
    ? await env.ACQUISITION.fetch(request)
    : Response.json({ error: 'not_implemented' }, { status: 404, headers });

  return withHeaders(response, gate.headers);
}
```

Aplicar el mismo patrón con `env.IDENTITY.fetch(request)` o `env.POLICY.fetch(request)` para rutas de su propietario. Evitar un `return env.<binding>.fetch(request)` que salte las cabeceras. Mantenerlas también en respuestas de error normalizadas; los fallos inesperados del binding requieren traducción a una respuesta técnica segura antes de ese paso final. No enrutar accidentalmente `/quotes-other` como si fuera `/quotes`.

Antes del retiro, la versión con `sunset` conserva `Deprecation`, `Sunset` y `Link` cuando aplique. Desde el retiro devuelve 410. Una versión sin fecha no añade esos avisos. Ver [contratos y versionado](compartidos/contracts/README.md) para los formatos y actualización conjunta de registro/spec.

## Qué validar

Usar [pruebas con propósito](pruebas.md). Para la capacidad que se implemente, cubrir cálculo/reglas y sus límites, consentimiento real, ficha conforme al esquema y conservación de versiones, persistencia conjunta, idempotencia con payload diferente, y errores sin éxito parcial. En HTTP comprobar entrada inválida, acceso denegado y salida contractual con dependencias en memoria; en el Worker web comprobar cabeceras en éxitos/errores y cero llamadas al backend tras retiro.

Los specs OpenAPI de dominio, la guía del módulo y las pruebas cambian con el comportamiento. El PR enlaza esas guías. Que los ejemplos estén documentados no sustituye la implementación ni sus pruebas.
