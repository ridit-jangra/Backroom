// Network and write-phase tests for scripts/packaging-bump.mjs. They run the script in-process
// against a scratch copy of the repo and a local HTTP server on 127.0.0.1 (random port); the
// real network is never used. The script's policy (allowed hosts, http) is injected.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = '1'.repeat(64);
const HASHES = { deb: 'a', rpm: 'b', appimage: 'c', exe: 'd', msi: 'e', dmg: 'f' };
const sha = (b) => createHash('sha256').update(b).digest('hex');

let dir;
let mod;
let server;
let base; // http://127.0.0.1:<port>
let routes; // path -> (req, res) => void

before(async () => {
  server = createServer((req, res) => {
    const h = routes[new URL(req.url, 'http://x').pathname];
    if (!h) {
      res.writeHead(404).end();
      return;
    }
    h(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  routes = {};
  dir = mkdtempSync(join(tmpdir(), 'packaging-bump-net-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const rel of ['scripts/packaging-bump.mjs', 'scripts/packaging-lib.mjs', 'scripts/set-version.mjs']) {
    cpSync(join(REPO, rel), join(dir, rel));
  }
  cpSync(join(REPO, 'packaging'), join(dir, 'packaging'), { recursive: true });
  cpSync(join(REPO, 'LICENSE'), join(dir, 'LICENSE'));
  mod = await import(`${pathToFileURL(join(dir, 'scripts/packaging-bump.mjs')).href}?t=${Math.random()}`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const net = (extra = {}) => ({
  allowHttp: true,
  allowedHosts: ['127.0.0.1'],
  licenseBase: `${base}/lic`,
  ...extra,
});

function sumsFile(v = '1.2.3') {
  const rows = [
    ['rpm', `Backroom-${v}-1.x86_64.rpm`],
    ['appimage', `Backroom_${v}_amd64.AppImage`],
    ['deb', `Backroom_${v}_amd64.deb`],
    ['dmg', `Backroom_${v}_universal.dmg`],
    ['msi', `Backroom_${v}_x64_en-US.msi`],
    ['exe', `Backroom_${v}_x64-setup.exe`],
  ];
  const p = join(dir, 'SHA256SUMS');
  writeFileSync(p, rows.map(([k, n]) => `${HASHES[k].repeat(64)}  ${n}`).join('\n') + '\n');
  return p;
}

function snapshot() {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        out[`${relative(dir, p)}/`] = null;
        walk(p);
      } else out[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(join(dir, 'packaging'));
  return out;
}

const body = (text) => (req, res) => res.writeHead(200).end(text);
const redirect = (to, code = 302) => (req, res) => res.writeHead(code, { location: to }).end();
const opts = (extra = {}) => ({ sourceSha256: SOURCE, net: net(), ...extra, sums: extra.sums ?? sumsFile() });
const offlineOpts = (extra = {}) => ({ sourceSha256: SOURCE, licenseSha256: 'c'.repeat(64), ...extra, sums: extra.sums ?? sumsFile() });

// ---- LICENSE at the tag --------------------------------------------------------------------

test('bump writes the hash of the LICENSE downloaded for the tag, not the checkout one', async () => {
  routes['/lic/v1.2.3/LICENSE'] = body('the licence at the tag\n');
  const lines = await mod.bump(dir, '1.2.3', opts());
  const pk = readFileSync(join(dir, 'packaging/aur/backroom-bin/PKGBUILD'), 'utf8');
  assert.ok(pk.includes(`'${sha('the licence at the tag\n')}')`));
  assert.ok(!lines.some((l) => /warning/.test(l)));
  await mod.check(dir, '1.2.3', opts()); // match
  routes['/lic/v1.2.3/LICENSE'] = body('a different licence\n'); // mismatch
  await assert.rejects(mod.check(dir, '1.2.3', opts()), (e) => /LICENSE hash .* does not match .*LICENSE at v1\.2\.3.*checksum/.test(e.message));
});

test('a LICENSE equal to the checkout one passes --check', async () => {
  routes['/lic/v1.2.3/LICENSE'] = body(readFileSync(join(dir, 'LICENSE')));
  await mod.bump(dir, '1.2.3', opts());
  await mod.check(dir, '1.2.3', opts());
});

test('an oversized LICENSE (over 64 KiB) is refused and nothing is written', async () => {
  routes['/lic/v1.2.3/LICENSE'] = body('x'.repeat(64 * 1024 + 1));
  const before = snapshot();
  await assert.rejects(mod.bump(dir, '1.2.3', opts()), /larger than 65536 bytes/);
  assert.deepEqual(snapshot(), before);
});

test('a LICENSE download that does not answer in time is refused', async () => {
  routes['/lic/v1.2.3/LICENSE'] = () => {}; // never responds
  const before = snapshot();
  await assert.rejects(mod.bump(dir, '1.2.3', opts({ net: net({ licenseTimeoutMs: 300 }) })), /could not download/);
  assert.deepEqual(snapshot(), before);
});

test('a missing LICENSE at the tag (404) is refused', async () => {
  await assert.rejects(mod.bump(dir, '1.2.3', opts()), /HTTP 404/);
});

test('--license-sha256 overrides the download; offline without it warns and uses the checkout LICENSE', async () => {
  const override = 'c'.repeat(64);
  await mod.bump(dir, '1.2.3', offlineOpts());
  assert.ok(readFileSync(join(dir, 'packaging/aur/backroom-bin/PKGBUILD'), 'utf8').includes(`'${override}')`));
  await mod.check(dir, '1.2.3', offlineOpts());
  await assert.rejects(mod.check(dir, '1.2.3', offlineOpts({ licenseSha256: 'd'.repeat(64) })), /LICENSE hash/);
  await assert.rejects(mod.bump(dir, '1.2.4', offlineOpts({ sums: sumsFile('1.2.4'), licenseSha256: '0'.repeat(64) })), /--license-sha256/);
  const lines = await mod.bump(dir, '1.2.4', { sums: sumsFile('1.2.4'), sourceSha256: SOURCE });
  assert.ok(lines.some((l) => /warning: offline/.test(l)));
});

// ---- redirects -----------------------------------------------------------------------------

test('download follows an allowed redirect chain (3 hops) and returns the body', async () => {
  routes['/a'] = redirect(`${base}/b`);
  routes['/b'] = redirect(`${base}/c`, 301);
  routes['/c'] = redirect(`${base}/d`, 307);
  routes['/d'] = body('done');
  const out = await mod.download(`${base}/a`, 1024, net());
  assert.equal(out.toString(), 'done');
});

test('download refuses a redirect loop and a chain longer than 3 redirects', async () => {
  routes['/loop'] = redirect(`${base}/loop`);
  await assert.rejects(mod.download(`${base}/loop`, 1024, net()), /too many redirects/);
  routes['/1'] = redirect(`${base}/2`);
  routes['/2'] = redirect(`${base}/3`);
  routes['/3'] = redirect(`${base}/4`);
  routes['/4'] = redirect(`${base}/5`);
  routes['/5'] = body('x');
  await assert.rejects(mod.download(`${base}/1`, 1024, net()), /too many redirects/);
});

test('download refuses a redirect to another host', async () => {
  routes['/x'] = redirect('http://localhost:1/evil');
  await assert.rejects(mod.download(`${base}/x`, 1024, net()), /redirect target on host localhost/);
});

test('download refuses a redirect to http (https is required unless the test policy allows it)', async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://github.com/evil' } });
  await assert.rejects(mod.download('https://github.com/x', 1024, { fetchImpl }), /non-https redirect target/);
});

test('download refuses a non-https start URL and a start URL on another host by default', async () => {
  await assert.rejects(mod.download('http://github.com/x', 1024), /non-https/);
  await assert.rejects(mod.download('https://example.com/x', 1024), /host example\.com/);
});

test('the default allow-list is the four GitHub hosts', () => {
  assert.deepEqual(mod.ALLOWED_HOSTS, [
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'raw.githubusercontent.com',
  ]);
});

test('--sums URLs are restricted to https github.com release downloads', async () => {
  for (const u of [
    'http://github.com/ridit-jangra/Backroom/releases/download/v1.2.3/SHA256SUMS',
    'https://example.com/ridit-jangra/Backroom/releases/download/v1.2.3/SHA256SUMS',
    'https://github.com/someone/else/releases/download/v1.2.3/SHA256SUMS',
    'https://raw.githubusercontent.com/ridit-jangra/Backroom/v1.2.3/SHA256SUMS',
  ]) {
    await assert.rejects(mod.bump(dir, '1.2.3', { sums: u, sourceSha256: SOURCE }), /--sums URLs must be/, u);
  }
});

test('an online bump (sums from the server, license from the server) works end to end', async () => {
  routes['/sums'] = body(readFileSync(sumsFile(), 'utf8'));
  routes['/lic/v1.2.3/LICENSE'] = body('lic\n');
  const o = { sums: `${base}/sums`, sourceSha256: SOURCE, net: net({ sumsUnrestricted: true }) };
  await mod.bump(dir, '1.2.3', o);
  await mod.check(dir, '1.2.3', o);
});

// ---- write phase ---------------------------------------------------------------------------

test('an I/O failure on the 3rd staged write leaves the tree byte-identical', async () => {
  const before = snapshot();
  let n = 0;
  const failing = (...a) => {
    if (++n === 3) throw new Error('disk full');
    return writeFileSync(...a);
  };
  await assert.rejects(mod.bump(dir, '1.2.3', offlineOpts({ fs: { writeFileSync: failing } })), /disk full/);
  assert.deepEqual(snapshot(), before);
});

test('an I/O failure while staging the winget directory also leaves the tree identical', async () => {
  const before = snapshot();
  let n = 0;
  const failing = (...a) => {
    if (++n === 8) throw new Error('disk full'); // 6 plain files are staged first
    return writeFileSync(...a);
  };
  await assert.rejects(mod.bump(dir, '1.2.3', offlineOpts({ fs: { writeFileSync: failing } })), /disk full/);
  assert.deepEqual(snapshot(), before);
});

test('a failing rename restores the files already renamed', async () => {
  const before = snapshot();
  let n = 0;
  const failing = (...a) => {
    if (++n === 3) throw new Error('rename failed');
    return renameSync(...a);
  };
  await assert.rejects(mod.bump(dir, '1.2.3', offlineOpts({ fs: { renameSync: failing } })), /rename failed/);
  assert.deepEqual(snapshot(), before);
});

test('a successful bump leaves no staging files behind', async () => {
  await mod.bump(dir, '1.2.3', offlineOpts());
  assert.deepEqual(Object.keys(snapshot()).filter((k) => /\.tmp-|\.old/.test(k)), []);
});
