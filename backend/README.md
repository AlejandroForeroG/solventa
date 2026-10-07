# Fronteras de los backends

Cada backend es una unidad de despliegue y posee sus migraciones, esquema SQL y credencial runtime. Adquisición usa un service binding hacia Identidad. El Worker web enruta `/auth/*` por el binding de Identidad y compone comprobaciones operativas mediante RPC a los tres servicios. Estas llamadas de diagnóstico no son contratos de negocio.

`src/index.ts` es la raíz de composición de Cloudflare. `adapters/inbound/http.ts` contiene Hono y liveness; en Identidad también monta las rutas de autenticación. `adapters/outbound/database-probe.ts` contiene PostgreSQL y el diagnóstico del almacén. Las sondas operativas no representan casos de uso de negocio; no envolverlas en interfaces artificiales para dar apariencia de dominio.

Cuando se implemente una capacidad:

- `domain` contiene reglas y tipos propios sin SDK, red, variables de ambiente ni APIs de plataforma.
- `application` coordina el caso de uso y define los puertos que requiere. Puede depender de su dominio y aplicación, nunca de adaptadores.
- `adapters` implementa los puertos; Hono, PostgreSQL, proveedores y Cloudflare permanecen aquí o en la raíz de composición.
- La raíz de composición inyecta adaptadores. Una transacción pertenece a un solo propietario. Las colaboraciones entre propietarios usan contratos; los eventos futuros requieren idempotencia y una estrategia transaccional antes de habilitar escrituras.
- `packages/contracts` contiene únicamente contratos de frontera estables. No agregar entidades, servicios ni repositorios compartidos para eludir la separación.

`architecture:check` analiza importaciones, exportaciones, imports de tipos e imports dinámicos. Rechaza dependencias del núcleo hacia SDK o adaptadores, del dominio hacia aplicación e importaciones relativas fuera del backend. Compila el núcleo con ES2022 sin tipos de Node, DOM o Workers. `test:architecture` verifica ejemplos de infracción. Es una ayuda estática; la revisión debe comprobar responsabilidades y dependencias semánticas.

Identidad implementa los casos de uso de autenticación web mediante puertos de
sesión y persistencia, con adaptadores WorkOS y SQL; consultar su
[README](identity-consent-ecosystem/README.md). El alta de cliente confirma vínculo,
sesión, auditoría y evento de creación en una transacción; la revocación local
confirma estado y auditoría juntos.

Los núcleos de Adquisición y Pólizas siguen sin casos de uso de negocio. La base
actual no acredita contratos públicos de negocio, publicación/consumo de eventos,
consentimiento efectivo ni recorridos financieros completos.
