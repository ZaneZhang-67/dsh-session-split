import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] && fs.realpathSync(process.argv[2]);
if (!source) throw new Error('Usage: node scripts/export.mjs /path/to/patched/deepseek-harness');
const upstream = JSON.parse(fs.readFileSync(path.join(root, 'UPSTREAM.json'), 'utf8'));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (revision !== upstream.commit) throw new Error(`Expected upstream ${upstream.commit}, received ${revision}`);
const names = ['ui-session', 'ui-workspace', 'ui-conversation'];
const scopes = names.map(name => `packages/client/${name}`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const writeJSON = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const licenses = new Map();
const checksums = {};

for (const name of names) {
  const pkgRoot = path.join(source, 'packages/client', name);
  const output = path.join(root, 'modules', name);
  const original = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  fs.mkdirSync(output, { recursive: true });
  writeJSON(path.join(output, 'package.json'), {
    name: original.name, version: original.version, private: true, type: 'module',
    description: `${original.description} (modified by dsh-session-split)`, license: 'MIT',
    main: './lib/index.js',
    exports: { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json', './locale/*.json': './locale/*.json' },
    dsh: original.dsh,
  });
  for (const file of ['lib/index.js', 'lib/client.js', 'lib/client.js.map']) {
    const target = path.join(output, file);
    copy(path.join(pkgRoot, file), target);
    checksums[path.relative(root, target).split(path.sep).join('/')] = sha(fs.readFileSync(target));
  }
  const locale = path.join(pkgRoot, 'locale');
  for (const entry of fs.readdirSync(locale, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) copy(path.join(locale, entry.name), path.join(output, 'locale', entry.name));
  }
  copy(path.join(source, 'LICENSE'), path.join(output, 'LICENSE'));
  const map = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'lib/client.js.map'), 'utf8'));
  for (const item of map.sources) {
    if (!item.includes('node_modules/')) continue;
    const tail = item.slice(item.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const moduleName = tail.split('/').slice(0, tail.startsWith('@') ? 2 : 1).join('/');
    if (licenses.has(moduleName)) continue;
    const dependencyRoot = path.resolve(pkgRoot, 'lib', item.slice(0, item.lastIndexOf('node_modules/') + 'node_modules/'.length), moduleName);
    const meta = JSON.parse(fs.readFileSync(path.join(dependencyRoot, 'package.json'), 'utf8'));
    const licenseFile = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'license'].find(file => fs.existsSync(path.join(dependencyRoot, file)));
    if (!licenseFile) throw new Error(`Missing bundled dependency license: ${moduleName}`);
    licenses.set(moduleName, { version: meta.version, text: fs.readFileSync(path.join(dependencyRoot, licenseFile), 'utf8') });
  }
}

let notice = '# Third-party notices\n\nThe three replacement modules are modified DeepSeek Harness code, copyright (c) 2026 DeepSeek, distributed under the MIT license included in each module. Their original package identifiers are retained for DSH module loading; this is an independent community bundle.\n\nThe browser artifacts additionally contain the following libraries. Shared platform libraries supplied by DSH are not redistributed here.\n';
for (const [name, { version, text }] of [...licenses].sort(([a], [b]) => a.localeCompare(b))) {
  notice += `\n## ${name} ${version}\n\n\`\`\`text\n${text.trim()}\n\`\`\`\n`;
}
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), notice);
writeJSON(path.join(root, 'checksums.json'), checksums);

// Include only the feature's three packages, including newly added source/tests.
let patch = execFileSync('git', ['diff', '--binary', 'HEAD', '--', ...scopes], { cwd: source, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const additions = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...scopes], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of additions.sort()) {
  const diff = spawnSync('git', ['diff', '--no-index', '--', '/dev/null', file], { cwd: source, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (diff.status !== 1) throw new Error(`Expected an added-file diff for ${file}: ${diff.stderr}`);
  patch += diff.stdout;
}
if (!patch) throw new Error('The source checkout has no split implementation patch');
fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
fs.writeFileSync(path.join(root, 'patches', 'dsh-0.2.2-rc.5.patch'), patch);
console.log(`Exported ${names.length} modules, ${licenses.size} dependency licenses and the complete feature patch.`);
