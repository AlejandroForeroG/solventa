# Identidad, Consentimiento y Ecosistema

Código: `backend/identity-consent-ecosystem`. Este módulo es la autoridad de identidad, autorización, consentimiento, dispositivos y acceso de socios. Las decisiones actuariales y financieras pertenecen a los otros módulos.

## Documentos

- [Autenticación web: rutas, sesión, configuración y pruebas](autenticacion.md).
- [Acceso a la API: socios M2M, canal web, contrato y Bruno](acceso-api.md).
- [Datos de identidad, consentimiento y dispositivos](datos.md).
- [Fronteras y comunicación entre backends](../../arquitectura.md).
- [Operación](../../infraestructura/README.md).

La autenticación web y los sondeos de acceso `quotes:create` para socios y canal web están implementados. El acceso M2M requiere alta y configuración WorkOS por ambiente. Cotización, consentimiento efectivo, cuotas, otros permisos de negocio, biometría y login móvil requieren sus casos de uso y validación. La existencia de tablas no acredita esos flujos.
