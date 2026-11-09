# Assistance provider search

Policy contains a synthetic assistance directory and reusable search rules. The directory is local test data with three fictional providers in Bogotá and Medellín. Provider names, addresses, phone placeholders and hours are synthetic. The adapter does not perform network I/O or accept real provider data.

Manual search matches a supported city, fixture address or fixture address plus city. Matching ignores case, accents and extra whitespace. Nearby search validates latitude and longitude and returns results within a 25 km straight-line radius, closest first. The radius is a provisional rule for the synthetic directory. A result includes the provider reference, category, display name, address, phone and hours. Nearby results also include the distance in kilometers.

The adapter rejects unknown catalog versions, malformed records and duplicate provider references as unavailable. An empty list means the catalog was valid and had no matching provider. This distinction lets a caller offer manual search or continue filing a claim after a directory failure. The [versioned catalog schema](../../../packages/contracts/schemas/synthetic-assistance-directory.v1.json) and positive and negative corpus run in `npm run test:integrations`.

The directory has no public entry point yet. Connecting web and mobile requires authorization at the server boundary, explicit device location permission, a manual search path and an authenticated handoff to the separate assistance request. Search does not persist the supplied location or create an assistance request.
