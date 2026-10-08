# Datos contractuales, dinero y evidencia

Pólizas preservan coberturas y versión de oferta. Money usa DECIMAL(19,4) y moneda,
nunca float. Claves únicas limitan duplicados; las transiciones válidas y conciliación
con terceros siguen siendo responsabilidad de los casos de uso. FK compuestas mantienen
indemnización, siniestro y pago dentro de la misma póliza. Tener tablas no implementa
las operaciones ni acredita cumplimiento PCI-DSS.

evidence_metadata guarda clave R2, tamaño, checksum, estado y retención. verified exige
verified_at; la aplicación comprueba el objeto y checksum. SQL y R2 no comparten transacción.


Ver [permisos, eventos y operación SQL](../../infraestructura/modelo-datos.md).
