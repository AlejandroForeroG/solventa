import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const read = (path: string) => readFileSync(new URL('../../packages/contracts/openapi/v1/' + path, import.meta.url), 'utf8');
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const file of ['common', 'quotes', 'partner-offers', 'partner-authorizations', 'partner-portal']) ajv.addSchema({ ...parse(read(file + '.yaml')), $id: `https://solventa.test/v1/${file}.yaml` });

ajv.addSchema({ ...parse(readFileSync(new URL('../../packages/contracts/openapi/v2/partner-portal.yaml', import.meta.url), 'utf8')), $id: 'https://solventa.test/v2/partner-portal.yaml' });

// A compiled validator for one component schema of a committed OpenAPI contract.
export function contractSchema(file: 'partner-offers' | 'partner-authorizations' | 'partner-portal', name: string, version: 'v1'|'v2' = 'v1') {
  const validate = ajv.getSchema(`https://solventa.test/${version}/${file}.yaml#/components/schemas/${name}`);
  if (!validate) throw new Error(`schema ${file}/${name}`);
  return (value: unknown) => ({ valid: validate(value) as boolean, errors: JSON.stringify(validate.errors) });
}
