// Verifies that the committed generated client matches contracts/openapi.json.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(mkdtempSync(join(tmpdir(), 'pg-api-')), 'schema.ts');
execFileSync(process.execPath, ['node_modules/openapi-typescript/bin/cli.js', '../../contracts/openapi.json', '-o', out], { stdio: 'inherit' });
const fresh = readFileSync(out, 'utf8');
const committed = readFileSync('../../packages/api-client/src/generated/schema.ts', 'utf8');
if (fresh !== committed) {
  console.error('packages/api-client is stale: run `npm run gen:api`.');
  process.exit(1);
}
console.log('api-client matches contracts/openapi.json');
