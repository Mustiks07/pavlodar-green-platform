// Writes packages/api-client/src/types.ts: one alias per canonical schema, nothing else.
// Usage: node scripts/gen-types.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';

const spec = JSON.parse(readFileSync('../../contracts/openapi.json', 'utf8'));
const names = Object.keys(spec.components.schemas).sort();
const out = [
  `// Generated from contracts/openapi.json ${spec.info.version} by apps/web/scripts/gen-types.mjs. Do not edit.`,
  "import type { components } from './generated/schema';",
  '',
  ...names.map((n) => `export type ${n} = components['schemas']['${n}'];`),
  '',
].join('\n');
const target = '../../packages/api-client/src/types.ts';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== out) {
    console.error('packages/api-client/src/types.ts is stale: run `npm run gen:api`.');
    process.exit(1);
  }
  console.log(`types.ts matches contract ${spec.info.version} (${names.length} schemas)`);
} else {
  writeFileSync(target, out);
  console.log(`types.ts written for contract ${spec.info.version} (${names.length} schemas)`);
}
