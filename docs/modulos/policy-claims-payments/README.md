# Pólizas, Siniestros y Pagos

Código: `backend/policy-claims-payments`. El módulo posee emisión, pólizas, primas, pagos, conciliación, siniestros, evidencia e indemnización. Recibe las referencias de ofertas de Adquisición; conserva adaptadores separados para pagos, firma y otras integraciones de su responsabilidad.

## Estado implementado

Worker con esquema `policy`, rol runtime y Hyperdrive propios. `/health` indica liveness. El diagnóstico RPC protegido por web comprueba su almacén SQL. Existen tablas base; dominio y aplicación siguen sin casos de uso de negocio. Emisión, operaciones financieras, carga R2 y coordinación con Workflows requieren implementación.

## Documentos

- [Datos contractuales, dinero y evidencia](datos.md).
- [Fronteras y comunicación](../../arquitectura.md).
- [Operación](../../infraestructura/README.md).
