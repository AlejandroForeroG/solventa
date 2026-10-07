# Datos de identidad y consentimiento

clients.id identifica al usuario interno; subject_token es la referencia opaca compartida.
external_identities vincula un sujeto externo verificado por servidor, único por proveedor
y sujeto. No aceptar ese sujeto directamente de un formulario. No hay contraseñas ni
tokens de sesión en SQL. El adaptador WorkOS vincula el sujeto verificado;
authentication_sessions conserva referencias opacas, vencimiento y revocación local.
Cada consulta de sesión comprueba además que clients.status sea active. Logout
revoca localmente antes de solicitar la revocación al proveedor. La sesión local
vence como máximo en siete días; el proveedor puede exigir reautenticación antes.

registered_devices registra dispositivos tras autenticación principal; no guarda huellas,
rostros ni plantillas biométricas. La custodia segura y biometría pertenecen al dispositivo;
una fila de dispositivo no autentica peticiones. partner_credentials guarda referencias
y scopes, no claves en claro. Autenticación de socios y sesión de usuario son distintas.
Permisos por usuario y cuotas se completan junto con sus casos de uso.

Consentimiento conserva propósito, scopes, fuente, vigencia y revocación por (id, version).
Cambiar alcance exige otra revisión. El adaptador debe controlar esta regla y concurrencia:
el rol posee UPDATE sobre consents; el DDL no garantiza inmutabilidad de todos sus campos.
Cada uso de señales comprueba autorización fresca en Identidad. El consentimiento
guardado en un perfil o mensaje no concede acceso.


Ver [permisos, eventos y operación SQL](../../infraestructura/modelo-datos.md).
