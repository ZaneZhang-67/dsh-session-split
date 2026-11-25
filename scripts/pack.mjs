import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

await import('./verify.mjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });
const npmCLI = process.env.npm_execpath;
if (process.platform === 'win32' && !npmCLI) throw new Error('Run npm run pack:release so the npm CLI is available');
const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', output];
const json = execFileSync(npmCLI ? process.execPath : 'npm', npmCLI ? [npmCLI, ...args] : args,
  { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const [packed] = JSON.parse(json);
if (!packed?.filename || path.basename(packed.filename) !== packed.filename) throw new Error('Unexpected package filename');
const archive = path.join(output, packed.filename);
const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(`${archive}.sha256`, `${hash}  ${packed.filename}\n`);
console.log(JSON.stringify({ archive: path.relative(root, archive), sha256: hash, files: packed.files.length, bytes: packed.size }, null, 2));
