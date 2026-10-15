#!/usr/bin/env node
// Put every platform's native binary into node_modules, so one release zip
// runs on every platform the manifest declares.
//
//   node scripts/fetch-native-binaries.mjs
//   node scripts/fetch-native-binaries.mjs --dry-run
//
// Native npm packages ship their compiled code as optional dependencies, one
// per platform (`usb` -> `@node-usb/usb-darwin-arm64`, `…-win32-x64-msvc`, …),
// and npm installs only the one for the machine it runs on. The release zip
// carries node_modules as-is — nothing installs on the user's machine — so a
// zip packed on the Ubuntu release runner would hold only the Linux binary.
//
// This reads package-lock.json for every optional package whose `os`/`cpu`
// matches a platform in soundbase-plugin.json and is not installed, downloads
// the exact tarball the lockfile names, checks it against the lockfile's
// integrity hash, and unpacks it where npm would have. Nothing is resolved:
// the lockfile is the whole truth, so a release contains what was committed.
//
// Run it after `npm ci` / `npm prune` and before `npm run pack:release`.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dryRun = process.argv.includes('--dry-run');

const log = (msg) => process.stdout.write(`[native] ${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[native] ERROR: ${msg}\n`);
  process.exit(1);
};

const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
const manifest = readJson('soundbase-plugin.json');
if (!existsSync(join(ROOT, 'package-lock.json'))) {
  fail('package-lock.json is missing; it pins the binaries this fetches');
}
const lock = readJson('package-lock.json');

// "darwin-arm64" -> { os: 'darwin', cpu: 'arm64' }
const platforms = (manifest.platforms ?? []).map((p) => {
  const [os, cpu] = p.split('-');
  return { os, cpu };
});
if (!platforms.length) fail('soundbase-plugin.json declares no platforms');

// npm's own rule: a list of names, any of which may be negated with "!"
const allows = (list, value) => {
  if (!Array.isArray(list) || !list.length) return true;
  const denied = list.filter((v) => v.startsWith('!')).map((v) => v.slice(1));
  const allowed = list.filter((v) => !v.startsWith('!'));
  if (denied.includes(value)) return false;
  return !allowed.length || allowed.includes(value);
};

const wanted = Object.entries(lock.packages ?? {}).filter(
  ([path, entry]) =>
    path.startsWith('node_modules/') &&
    entry.optional &&
    !entry.dev &&
    (entry.os || entry.cpu) &&
    platforms.some((p) => allows(entry.os, p.os) && allows(entry.cpu, p.cpu))
);

if (!wanted.length) {
  log('no platform-specific packages in the lockfile; nothing to do');
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'native-binaries-'));
try {
  for (const [path, entry] of wanted) {
    const dest = join(ROOT, path);
    if (existsSync(join(dest, 'package.json'))) {
      log(`${path} ${entry.version} — already installed`);
      continue;
    }
    if (!entry.resolved || !entry.integrity) {
      fail(`${path} has no resolved URL or integrity in package-lock.json`);
    }
    if (dryRun) {
      log(`${path} ${entry.version} — would fetch ${entry.resolved}`);
      continue;
    }

    const res = await fetch(entry.resolved);
    if (!res.ok) fail(`${entry.resolved}: HTTP ${res.status}`);
    const tarball = Buffer.from(await res.arrayBuffer());

    // "sha512-<base64>" — the same check npm ci makes
    const [algorithm, expected] = entry.integrity.split(/-(.*)/s);
    const actual = createHash(algorithm).update(tarball).digest('base64');
    if (actual !== expected) {
      fail(`${path}: integrity mismatch — the registry served something else`);
    }

    const file = join(work, `${path.replaceAll('/', '_')}.tgz`);
    writeFileSync(file, tarball);
    mkdirSync(dest, { recursive: true });
    // npm tarballs keep everything under "package/"
    const tar = spawnSync(
      'tar',
      ['-xzf', file, '-C', dest, '--strip-components=1'],
      {
        stdio: 'inherit',
      }
    );
    if (tar.status !== 0) {
      rmSync(dest, { recursive: true, force: true });
      fail(`${path}: tar exited with ${tar.status}`);
    }
    log(`${path} ${entry.version} — fetched and verified`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
