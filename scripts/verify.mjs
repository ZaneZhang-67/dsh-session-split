import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.name, '@local/dsh-session-split');
assert.equal(pkg.engines.dsh, '=0.2.2-rc.5');
assert.equal(pkg.dependencies['@deepseek-ai/schemastery'], '3.19.0');
for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts?.[script], undefined);
const patch = read('cordis.patch.yml');
const entries = [...patch.matchAll(/^\s+name:\s+(.+)$/gm)].map(match => match[1]);
assert.equal(entries.length, 3);
const expected = ['ui-session', 'ui-workspace', 'ui-conversation'];
const sums = JSON.parse(read('checksums.json'));
for (const name of expected) {
  const base = `modules/${name}`;
  assert.ok(entries.includes(`./${base}/lib/index.js`));
  const meta = JSON.parse(read(`${base}/package.json`));
  assert.equal(meta.name, `@deepseek-ai/dsh-client-${name}`);
  assert.equal(meta.version, '0.2.2-rc.5');
  assert.equal(meta.dsh.client.platform, 'web');
  assert.equal(meta.exports['./client'], './lib/client.js');
  assert.equal(meta.dependencies, undefined);
  assert.equal(meta.devDependencies, undefined);
  assert.equal(meta.peerDependencies, undefined);
  for (const target of [meta.exports['.'], meta.exports['./client']]) assert.ok(fs.statSync(path.join(root, base, target)).isFile());
  const registrations = [];
  new Function('window', read(`${base}/lib/client.js`))({ __ModuleLoader__: { load: value => registrations.push(value) } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, meta.name);
  assert.equal(typeof registrations[0].factory, 'function');
  execFileSync(process.execPath, ['--check', path.join(root, base, 'lib/index.js')]);
  execFileSync(process.execPath, ['--check', path.join(root, base, 'lib/client.js')]);
}
for (const [file, hash] of Object.entries(sums)) {
  assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'));
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), hash, file);
}
for (const lang of ['en', 'zh']) {
  const { meta } = JSON.parse(read(`locale/${lang}.json`));
  assert.ok(meta.title && meta.description);
}
assert.ok(read('LICENSE').includes('Copyright (c) 2026 DeepSeek'));
assert.ok(read('THIRD_PARTY_NOTICES.md').includes('lexical'));
assert.ok(read('icon.svg').includes('<svg'));

function inspect(relative) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  assert.ok(!stat.isSymbolicLink(), `Published symlink: ${relative}`);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolute)) inspect(`${relative}/${entry}`);
    return;
  }
  const text = fs.readFileSync(absolute, 'utf8');
  assert.ok(!/\/Users\/[^/]+\//.test(text), `Personal absolute path: ${relative}`);
  assert.ok(!/\/home\/[^/]+\//.test(text), `Personal absolute path: ${relative}`);
  assert.ok(!/gh[pousr]_[A-Za-z0-9]{30,}/.test(text), `Credential-like value: ${relative}`);
}
for (const entry of ['package.json', ...pkg.files]) inspect(entry);
console.log(`Verified ${expected.length} module registrations, ${Object.keys(sums).length} artifact hashes, relative patch paths and publication resources.`);
