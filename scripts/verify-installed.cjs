#!/usr/bin/env node
'use strict';

// Read-only packaging smoke for DSH 0.2.2-rc.5. No profile, HTTP listener, or browser.
// Run with the installed Electron runtime so app.asar and Node Loader internals work:
// ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --expose-internals \
//   scripts/verify-installed.cjs /absolute/path/to/unpacked/package
// Install the unpacked package's production dependencies in that directory first.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');

const VERSION = '0.2.2-rc.5';
const ACTIVE = 2; // Installed Cordis FiberState.ACTIVE (a compiled const enum).
const MODULES = ['ui-session', 'ui-workspace', 'ui-conversation'];
// Audited release baseline: packages/client/web/src/platform.ts:8-15.
const PLATFORM = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]);

function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function inside(root, file, label) {
  const actual = fs.realpathSync(file);
  const relative = path.relative(root, actual);
  assert(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `${label} escapes unpacked package: ${actual}`);
  return actual;
}

function flatten(rows) {
  return rows.flatMap(row => row.group && Array.isArray(row.config)
    ? [row, ...flatten(row.config)] : [row]);
}

function registersOnly(code, label) {
  const records = [];
  vm.runInNewContext(code, {
    window: { __ModuleLoader__: { load(record) { records.push(record); } } },
  }, { filename: label, timeout: 5000 });
  // Deliberately do not materialize factories: this tests actual registration,
  // not a fake implementation of React, the DOM, or the platform module table.
  return records;
}

async function main() {
  assert.equal(process.argv.length, 3, 'Usage: portable-registry-smoke.cjs /absolute/package/root');
  assert(path.isAbsolute(process.argv[2]), 'Package root must be absolute');
  assert(process.env.DSH_INSTALL_DIR, 'DSH_INSTALL_DIR must identify the running DSH installation');
  assert(process.versions.electron, 'Use DSH_NODE_EXECUTABLE with ELECTRON_RUN_AS_NODE=1');
  const root = fs.realpathSync(process.argv[2]);
  const rootManifest = json(path.join(root, 'package.json'));
  assert.equal(rootManifest.dependencies?.['@deepseek-ai/schemastery'], '3.19.0');
  assert.equal(rootManifest.engines?.dsh, `=${VERSION}`);
  assert.equal(rootManifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(rootManifest.dsh?.client, undefined, 'Composition root must not add a browser module row');

  const host = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
  const hostManifest = json(host.resolve('@deepseek-ai/dsh/package.json'));
  assert.equal(hostManifest.version, VERSION);
  const loadHost = name => import(pathToFileURL(host.resolve(name)).href);
  const [{ Context }, { Loader }, { ClientModuleRegistry }, boot, include] = await Promise.all([
    loadHost('@deepseek-ai/cordis'),
    loadHost('@deepseek-ai/cordis-plugin-loader'),
    loadHost('@deepseek-ai/dsh-client-modules'),
    loadHost('@deepseek-ai/dsh-app-boot'),
    loadHost('@deepseek-ai/cordis-plugin-include'),
  ]);
  assert.equal(boot.evaluatePluginCompatibility(rootManifest, {}, VERSION), undefined);

  const patchFile = inside(root, path.join(root, 'cordis.patch.yml'), 'patch');
  const authoredPatch = fs.readFileSync(patchFile, 'utf8');
  const patches = boot.loadOverlayPatches('portable-registry-smoke', patchFile);
  const inserted = flatten(patches.flatMap(patch => patch.insert ?? []));
  assert.equal(inserted.length, MODULES.length, 'Expected exactly three inserted replacement entries');

  // Use the real shipped rows as the baseline, and the real include patch engine.
  // Read the Web bundle patch, but never activate its server or other plugins.
  const webManifestPath = host.resolve('@deepseek-ai/dsh-web-app/package.json');
  const webManifest = json(webManifestPath);
  const webPatchPaths = boot.bundlePatchPaths(path.dirname(webManifestPath), webManifest.dsh.bundle);
  const webPatches = webPatchPaths.flatMap(file => boot.loadOverlayPatches('portable-registry-smoke', file));
  const officialRows = flatten(webPatches.flatMap(patch => patch.insert ?? []))
    .filter(row => MODULES.includes(row.id));
  assert.equal(officialRows.length, MODULES.length, 'Installed Web bundle lacks expected official rows');
  const patchDiagnostics = [];
  const composed = include.applyEntryPatches(officialRows, patches,
    (message, ...args) => patchDiagnostics.push({ message, args }));
  for (const id of MODULES) {
    assert.equal(composed.find(row => row.id === id)?.disabled, true, `Official ${id} is not disabled`);
  }
  const activeRows = flatten(composed).filter(row => !row.disabled);
  assert.deepEqual(activeRows.map(row => row.id).sort(), MODULES.map(id => `local-split-${id}`).sort());

  const expected = new Map();
  for (const module of MODULES) {
    const relative = `./modules/${module}/lib/index.js`;
    assert(authoredPatch.includes(relative), `Authored patch is missing ${relative}`);
    const moduleDir = inside(root, path.join(root, 'modules', module), `${module} directory`);
    const manifestPath = inside(root, path.join(moduleDir, 'package.json'), `${module} manifest`);
    const manifest = json(manifestPath);
    const id = `@deepseek-ai/dsh-client-${module}`;
    assert.equal(manifest.name, id);
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.dsh?.client?.platform, 'web');
    assert.equal(boot.evaluatePluginCompatibility(manifest, {}, VERSION), undefined);
    assert(!JSON.stringify(manifest).includes('workspace:'), `${id} retains workspace dependency ranges`);
    const hostPath = inside(root, path.join(moduleDir, 'lib', 'index.js'), `${module} host entry`);
    const clientPath = inside(root, path.join(moduleDir, 'lib', 'client.js'), `${module} client entry`);
    const clientExport = manifest.exports?.['./client'];
    assert.equal(typeof clientExport === 'string' ? clientExport : clientExport?.default, './lib/client.js');
    const row = activeRows.find(row => row.id === `local-split-${module}`);
    assert(row && row.name.startsWith('file:'), `Patch parser did not anchor ${module} to a file URL`);
    assert.equal(fs.realpathSync(fileURLToPath(row.name)), hostPath);
    const localRequire = createRequire(hostPath);
    if (module === 'ui-conversation') {
      const schemaManifestPath = localRequire.resolve('@deepseek-ai/schemastery/package.json');
      inside(root, schemaManifestPath, 'production schemastery dependency');
      assert.equal(json(schemaManifestPath).version, '3.19.0');
    }
    const code = fs.readFileSync(clientPath, 'utf8');
    const registrations = registersOnly(code, clientPath);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].id, id);
    assert.equal(typeof registrations[0].factory, 'function');
    assert(!code.includes('require.async('), `${id} gained a chunk: expand the payload audit`);
    assert(!code.includes('require.asset('), `${id} gained assets: expand the payload audit`);
    const requests = [...new Set([...code.matchAll(/\brequire\((?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`)/g)]
      .map(match => match[1] ?? match[2] ?? match[3]))];
    for (const request of requests) assert(PLATFORM.has(request), `${id}: non-baseline request ${request}`);
    expected.set(id, { module, hostPath, clientPath, requests });
  }

  const ctx = new Context();
  const rows = [];
  let registryFiber;
  let internalVersion;
  try {
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(`${root}${path.sep}`).href });
    assert(ctx.loader.internal && typeof ctx.loader.internal.resolveSync === 'function',
      'Real Node Loader internals missing; invoke runtime with --expose-internals');
    internalVersion = ctx.loader.internal.version;
    for (const options of activeRows) {
      const entryId = await ctx.loader.create(structuredClone(options));
      const entry = ctx.loader.resolve(entryId);
      assert(entry.fiber, `Loader did not create a fiber for ${entryId}`);
      assert.equal(entry.fiber.state, ACTIVE, `Host entry ${entryId} is not ACTIVE`);
    }
    await ctx.loader.await();
    registryFiber = await ctx.plugin(ClientModuleRegistry);
    assert.equal(registryFiber.state, ACTIVE, 'Registry fiber is not ACTIVE');
    const registry = ctx.clientModules;
    const graph = registry.graph();
    assert.deepEqual(graph.entries.map(row => row.id).sort(), [...expected.keys()].sort());
    for (const row of graph.entries) {
      const item = expected.get(row.id);
      assert.equal(fs.realpathSync(registry.clientPath(row.id)), item.clientPath);
      assert(row.url.startsWith(`plugins/??${row.id}/client.js&rev=`), `Unexpected route ${row.url}`);
      const response = await registry.fetchBundle(new Request(new URL(row.url, 'http://audit.invalid/')));
      assert.equal(response.status, 200);
      const registrations = registersOnly(await response.text(), row.url);
      assert.equal(registrations.length, 1);
      assert.equal(registrations[0].id, row.id);
      rows.push({ id: row.id, hostState: 'ACTIVE', clientPath: item.clientPath,
        url: row.url, status: response.status, registeredId: registrations[0].id, requests: item.requests });
    }
    // Negative control with real Loader entries: path aliases do not evade the
    // one-active-source-per-browser-package restriction.
    await registryFiber.dispose();
    const first = expected.values().next().value;
    await ctx.loader.create({ id: 'audit-duplicate-source',
      name: `./modules/${first.module}/lib/index.js` });
    assert.throws(() => new ClientModuleRegistry(ctx), /multiple active Loader sources/);
  } finally {
    await ctx.fiber.dispose();
  }
  console.log(JSON.stringify({ result: 'PASS', root, package: `${rootManifest.name}@${rootManifest.version}`,
    runtime: { dsh: hostManifest.version, electron: process.versions.electron,
      node: process.versions.node, loaderInternal: internalVersion },
    rows, duplicateSourceRejected: true, patchDiagnostics,
    scope: 'Host Loader + actual registry + served bundle registration; no browser factory materialization' }, null, 2));
}

main().catch(error => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
