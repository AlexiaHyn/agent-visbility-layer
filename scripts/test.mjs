import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(root, 'tests', name));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
