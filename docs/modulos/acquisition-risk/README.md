# Adquisición y Riesgo

Código: `backend/acquisition-risk`. El módulo posee cotización, pricing, perfilamiento, rating, underwriting, ofertas y actualización asíncrona de señales autorizadas. Emisión y cobro pertenecen a Pólizas; la autorización y el consentimiento pertenecen a Identidad.

## Estado implementado

Worker con esquema `acquisition`, rol runtime y Hyperdrive propios. `/health` indica liveness. El diagnóstico RPC protegido por web comprueba SQL y la comunicación con Identidad. Existen tablas base; dominio y aplicación siguen sin casos de uso de negocio. Cotización, perfilamiento, Open Finance, fallback y actualización asíncrona requieren implementación.

## Documentos

- [Datos, captura histórica y revisiones de ofertas](datos.md).
- [Contratos y captura de decisiones](../../compartidos/contracts/README.md).
- [Fronteras y comunicación](../../arquitectura.md).
- [Operación](../../infraestructura/README.md).

Al implementar endpoints y decisiones del módulo, seguir el [estándar común](../../estandares-endpoints.md), las [pruebas con propósito](../../pruebas.md) y el [procedimiento de migraciones](../../infraestructura/migraciones.md). Documentar aquí el comportamiento específico sin copiar las reglas compartidas.
