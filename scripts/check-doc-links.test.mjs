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

function withDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'doclinks-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('fences indented up to 3 spaces or nested in list items hide their # comments', () => {
  const doc = [
    '# A',
    '   ```sh',
    '# three-space comment',
    '   ```',
    '- item',
    '  ```sh',
    '  # list comment',
    '  ```',
    '1. step',
    '\t~~~',
    '\t# tab comment',
    '\t~~~',
    '````',
    '```',
    '# inside longer fence',
    '```',
    '````',
    '## B',
  ].join('\n');
  assert.deepEqual([...anchorsOf(doc)], ['a', 'b']);
});

test('a fence only closes with the same character and at least the same length', () => {
  const doc = '# A\n~~~~\n~~~\n# still inside\n```\n# still inside\n~~~~\n## B\n';
  assert.deepEqual([...anchorsOf(doc)], ['a', 'b']);
});

test('a target that only shares a string prefix with the root is outside the root', () => {
  withDir({ 'repo/a.md': '[x](../repo-evil/b.md)\n', 'repo-evil/b.md': '# B\n' }, (dir) => {
    const problems = checkLinks(['a.md'], join(dir, 'repo'));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /repo-evil\/b\.md.*target not found/);
  });
});

test('a malformed percent-escape is reported, not thrown', () => {
  withDir({ 'a.md': '[x](docs/%zz.md) [y](#bad%zz)\n# Top\n' }, (dir) => {
    let problems;
    assert.doesNotThrow(() => { problems = checkLinks(['a.md'], dir); });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /%zz\.md.*invalid percent-encoding/);
    assert.match(problems[1], /#bad%zz.*invalid percent-encoding/);
  });
});

test('balanced parentheses are allowed inside link destinations', () => {
  withDir({ 'a.md': '[ok](docs/b_(1).md) [ext](https://x.test/a_(b)) [gone](docs/c_(2).md) (see [plain](docs/b_(1).md#t))\n', 'docs/b_(1).md': '# T\n' }, (dir) => {
    const problems = checkLinks(['a.md'], dir);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /docs\/c_\(2\)\.md.*target not found/);
  });
});

test('reference-style link definitions are checked', () => {
  withDir(
    {
      'a.md': ['[ok]: docs/b.md', '[ok2]: <docs/b.md#sub>  "Title"', '[ext]: https://example.com/x', '[gone]: docs/nope.md', '[bad]: docs/b.md#missing', '    [code]: docs/ignored.md'].join('\n') + '\n',
      'docs/b.md': '# Target\n\n## Sub\n',
    },
    (dir) => {
      const problems = checkLinks(['a.md'], dir);
      assert.equal(problems.length, 2);
      assert.match(problems[0], /docs\/nope\.md.*target not found/);
      assert.match(problems[1], /#missing.*no such heading/);
    },
  );
});
