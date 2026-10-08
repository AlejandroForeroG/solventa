# Identidad, Consentimiento y Ecosistema

Código: `backend/identity-consent-ecosystem`. Este módulo es la autoridad de identidad, autorización, consentimiento, dispositivos y acceso de socios. Las decisiones actuariales y financieras pertenecen a los otros módulos.

## Documentos

- [Autenticación web: rutas, sesión, configuración y pruebas](autenticacion.md).
- [Datos de identidad, consentimiento y dispositivos](datos.md).
- [Fronteras y comunicación entre backends](../../arquitectura.md).
- [Operación](../../infraestructura/README.md).

La autenticación web está implementada. Consentimiento efectivo, permisos de negocio, cuotas, autenticación de socios, biometría y login móvil requieren sus casos de uso y validación. La existencia de tablas no acredita esos flujos.

Al implementar endpoints y decisiones del módulo, seguir el [estándar común](../../estandares-endpoints.md), las [pruebas con propósito](../../pruebas.md) y el [procedimiento de migraciones](../../infraestructura/migraciones.md). Documentar aquí el comportamiento específico sin copiar las reglas compartidas.
