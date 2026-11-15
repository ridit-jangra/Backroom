import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { anchorsOf, checkLinks, DOCS, slug } from './check-doc-links.mjs';

test('the repository documents have no broken relative links or anchors', () => {
  assert.deepEqual(checkLinks(DOCS), []);
});

test('slug follows the GitHub rules', () => {
  assert.equal(slug('Reverse proxy'), 'reverse-proxy');
  assert.equal(slug('Running it as a service'), 'running-it-as-a-service');
  assert.equal(slug('Troubleshooting and FAQ'), 'troubleshooting-and-faq');
  assert.equal(slug('`npm run dev`: it\'s fine'), 'npm-run-dev-its-fine');
});

test('duplicate headings get -1, -2 suffixes and code blocks are ignored', () => {
  const a = anchorsOf('# A\n\n## B\n\n## B\n\n```sh\n# not a heading\n```\n');
  assert.deepEqual([...a], ['a', 'b', 'b-1']);
});

test('reports a missing file, a missing heading, and accepts good links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doclinks-'));
  try {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'b.md'), '# Target\n\n## Sub heading\n');
    writeFileSync(
      join(dir, 'a.md'),
      [
        '[ok](docs/b.md) [ok2](docs/b.md#sub-heading) [self](#top) [ext](https://example.com/x) [mail](mailto:a@b.c)',
        '[gone](docs/nope.md) [badanchor](docs/b.md#missing)',
        '`[in code](docs/ignored.md)`',
        '# Top',
      ].join('\n'),
    );
    const problems = checkLinks(['a.md'], dir);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /docs\/nope\.md.*target not found/);
    assert.match(problems[1], /#missing.*no such heading/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
