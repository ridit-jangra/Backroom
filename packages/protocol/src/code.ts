export type CodeRange = { start: number; end: number; kind: 'code' | 'codeblock'; text: string };

const LANG_RE = /^[A-Za-z0-9_+#.-]*\r?\n/;

/**
 * Code spans and fences, in order, non-overlapping. One rule for all lengths: a run of N backticks
 * opens code that closes at the next run of exactly N backticks (shorter or longer runs inside are
 * content). N = 1 or 2 must close on the same line; N >= 3 is a fence and may span lines, with an
 * optional language word (only when a newline follows it) ignored. An unclosed run, or code that is
 * empty after trimming, is plain text and the whole opening run is skipped (no stray backticks).
 * Shared by the client tokenizer and the server mention extractor.
 */
export function findCodeRanges(body: string): CodeRange[] {
  const out: CodeRange[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== '`') {
      i++;
      continue;
    }
    let n = 0;
    while (body[i + n] === '`') n++;
    const fence = n >= 3;
    const limit = fence ? body.length : (body.indexOf('\n', i + n) === -1 ? body.length : body.indexOf('\n', i + n));
    let close = -1;
    for (let j = i + n; j < limit; ) {
      if (body[j] !== '`') {
        j++;
        continue;
      }
      let m = 0;
      while (body[j + m] === '`') m++;
      if (m === n) {
        close = j;
        break;
      }
      j += m;
    }
    let text = close === -1 ? '' : body.slice(i + n, close);
    if (fence) {
      const lang = LANG_RE.exec(text);
      if (lang) text = text.slice(lang[0].length);
      text = text.replace(/\r?\n$/, '');
    }
    if (close !== -1 && text.trim() !== '') {
      out.push({ start: i, end: close + n, kind: fence ? 'codeblock' : 'code', text });
      i = close + n;
    } else {
      i += n;
    }
  }
  return out;
}

/** `body` with every code range replaced by spaces (same length, so offsets stay valid). */
export function maskCode(body: string): string {
  let out = body;
  for (const r of findCodeRanges(body)) out = out.slice(0, r.start) + ' '.repeat(r.end - r.start) + out.slice(r.end);
  return out;
}
