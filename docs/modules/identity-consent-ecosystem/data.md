# Identity and consent data

`clients.id` identifies the internal user; `subject_token` is the shared opaque reference. `external_identities` links a server-verified external subject, unique per provider/subject. Never accept that subject directly from a form. SQL contains no passwords or session tokens. The WorkOS adapter links the verified subject; `authentication_sessions` stores opaque references, expiry and local revocation. Each session query also checks that `clients.status` is `active`. Logout revokes locally before requesting provider revocation. Local sessions expire within seven days; the provider may require earlier reauthentication.

`registered_devices` registers devices after primary authentication; it stores no fingerprints, faces or biometric templates. Secure custody and biometrics belong to the device; a device row does not authenticate requests. `partner_credentials` stores references/scopes, not plaintext keys. Partner authentication and user sessions are distinct. User permissions and quotas are completed with their use cases.

Consent preserves purpose, scopes, source, validity and revocation per `(id, version)`. Scope changes require another revision. The adapter must enforce this rule and concurrency: the role has UPDATE on `consents`; DDL does not guarantee immutability of every field. Each signal use checks fresh authorization in Identity. Consent stored in a profile/message does not grant access.

See [permissions, events and SQL operations](../../infrastructure/data-model.md).
