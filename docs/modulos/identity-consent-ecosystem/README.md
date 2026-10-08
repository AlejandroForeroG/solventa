# Identidad, Consentimiento y Ecosistema

Código: `backend/identity-consent-ecosystem`. Este módulo es la autoridad de identidad, autorización, consentimiento, dispositivos y acceso de socios. Las decisiones actuariales y financieras pertenecen a los otros módulos.

## Documentos

- [Autenticación web: rutas, sesión, configuración y pruebas](autenticacion.md).
- [API access: M2M partners, web channel, contract and Bruno](acceso-api.md).
- [Datos de identidad, consentimiento y dispositivos](datos.md).
- [Fronteras y comunicación entre backends](../../arquitectura.md).
- [Operación](../../infraestructura/README.md).

Web authentication and `quotes:create` access probes for partners and the web channel are implemented. M2M access requires WorkOS setup and configuration per environment. Quoting, effective consent, quotas, other business permissions, biometrics and mobile login still require their use cases and validation. The presence of tables does not demonstrate these flows.
