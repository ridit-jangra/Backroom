export type CodeRange = { start: number; end: number; kind: 'code' | 'codeblock'; text: string };

const FENCE = '```';
const LANG_RE = /^[A-Za-z0-9_+#.-]*\r?\n/;

/**
 * Code spans (`x`, one line) and fences (```lang\n...```) in `body`, in order, non-overlapping.
 * An unclosed fence or backtick is plain text. Shared by the client tokenizer and the server mention extractor.
 */
export function findCodeRanges(body: string): CodeRange[] {
  const out: CodeRange[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== '`') {
      i++;
    } else if (body.startsWith(FENCE, i)) {
      const close = body.indexOf(FENCE, i + 3);
      if (close <= i + 3) {
        i += 3; // unclosed (or empty) fence: plain text
        continue;
      }
      let text = body.slice(i + 3, close);
      const lang = LANG_RE.exec(text);
      if (lang) text = text.slice(lang[0].length);
      text = text.replace(/\r?\n$/, '');
      out.push({ start: i, end: close + 3, kind: 'codeblock', text });
      i = close + 3;
    } else {
      const close = body.indexOf('`', i + 1);
      const nl = body.indexOf('\n', i + 1);
      if (close > i + 1 && (nl === -1 || close < nl)) {
        out.push({ start: i, end: close + 1, kind: 'code', text: body.slice(i + 1, close) });
        i = close + 1;
      } else {
        i++;
      }
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
