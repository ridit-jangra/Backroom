import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  PICKER_CATEGORIES,
  emojiInCategory,
  formatShortcode,
  parseReactionCode,
  resolveBuiltin,
  twemojiSrc,
  type EmojiCategory,
  type SkinTone,
} from '@backroom/emoji';
import { useEmoji } from './EmojiContext';
import { EmojiImg } from './EmojiImg';
import { suggestEmoji } from './suggest';

export const PICKER_COLUMNS = 8;
const SEARCH_LIMIT = 120;
const TONES: SkinTone[] = [1, 2, 3, 4, 5, 6];

type Cell = { code: string; label: string; src: string | null; alt: string };
type TabId = 'frequent' | EmojiCategory | 'custom';

const TAB_ICON: Record<TabId, string> = {
  frequent: '🕘',
  'Smileys & Emotion': '😀',
  'People & Body': '👋',
  'Animals & Nature': '🐻',
  'Food & Drink': '🍔',
  'Travel & Places': '🚗',
  Activities: '⚽',
  Objects: '💡',
  Symbols: '❤',
  Flags: '🏁',
  Component: '',
  custom: '★',
};
const TAB_LABEL = (t: TabId) => (t === 'frequent' ? 'Frequently used' : t === 'custom' ? 'Custom' : t);

export function EmojiPicker({ label, onPick, onClose }: { label: string; onPick: (code: string) => void; onClose: () => void }) {
  const emoji = useEmoji();
  const { skinTone } = emoji;
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<TabId>('frequent');
  const [focusIdx, setFocusIdx] = useState(0);
  const close = useRef(onClose);
  close.current = onClose;

  const hasCustom = emoji.custom.size > 0;
  const tabs: TabId[] = useMemo(
    () => ['frequent', ...PICKER_CATEGORIES, ...(hasCustom ? (['custom'] as const) : [])],
    [hasCustom],
  );
  const activeTab = tab === 'custom' && !hasCustom ? 'frequent' : tab;

  const cells: Cell[] = useMemo(() => {
    const customCell = (name: string): Cell => {
      const r = emoji.resolve(name, null);
      return { code: name, label: `:${name}:`, src: r?.src ?? null, alt: `:${name}:` };
    };
    const q = query.trim();
    if (q !== '') {
      return suggestEmoji(q, emoji.custom, SEARCH_LIMIT).map((m) => {
        if (m.kind === 'custom') return customCell(m.name);
        const tone = m.record.skins ? skinTone : null;
        const b = resolveBuiltin(m.name, tone);
        return {
          code: formatShortcode(m.record.names[0]!, tone),
          label: `:${m.record.names[0]}:`,
          src: b ? twemojiSrc(b.img) : null,
          alt: m.record.char,
        };
      });
    }
    if (activeTab === 'frequent') {
      const out: Cell[] = [];
      for (const code of emoji.frequent) {
        const p = parseReactionCode(code);
        const r = p ? emoji.resolve(p.name, p.tone) : null;
        if (r) out.push({ code, label: `:${code}:`, src: r.src, alt: r.alt });
      }
      return out;
    }
    if (activeTab === 'custom') return [...emoji.custom.keys()].sort().map(customCell);
    return emojiInCategory(activeTab).map((rec) => {
      const tone = rec.skins ? skinTone : null;
      const b = resolveBuiltin(rec.names[0]!, tone);
      return {
        code: formatShortcode(rec.names[0]!, tone),
        label: `:${rec.names[0]}:`,
        src: b ? twemojiSrc(b.img) : null,
        alt: b?.char ?? rec.char,
      };
    });
  }, [query, activeTab, emoji, skinTone]);

  const focusCell = (i: number) => {
    setFocusIdx(i);
    gridRef.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus();
  };

  function pick(c: Cell) {
    emoji.recordUse(c.code);
    onPick(c.code);
  }

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    search.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node) || root.current?.contains(t)) return;
      // The opener's own toggle handles its click.
      if (t instanceof Element && t.closest('[data-emoji-trigger]')) return;
      close.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
    if (!el) return;
    const i = Number(el.dataset.index);
    const last = cells.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = Math.min(i + 1, last);
    else if (e.key === 'ArrowLeft') next = Math.max(i - 1, 0);
    else if (e.key === 'ArrowDown') next = Math.min(i + PICKER_COLUMNS, last);
    else if (e.key === 'ArrowUp') next = Math.max(i - PICKER_COLUMNS, 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const c = cells[i];
      if (c) pick(c);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      focusCell(next);
    }
  }

  const rows: Cell[][] = [];
  for (let i = 0; i < cells.length; i += PICKER_COLUMNS) rows.push(cells.slice(i, i + PICKER_COLUMNS));
  const searching = query.trim() !== '';

  return (
    <div ref={root} className="emoji-picker" role="dialog" aria-label={label}>
      <input
        ref={search}
        type="search"
        aria-label="Search emoji"
        placeholder="Search emoji"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setFocusIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && cells.length > 0) {
            e.preventDefault();
            focusCell(0);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const c = cells[0];
            if (c) pick(c);
          }
        }}
      />
      {!searching && (
        <div role="tablist" aria-label="Emoji categories" className="emoji-tabs">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === activeTab}
              aria-label={TAB_LABEL(t)}
              title={TAB_LABEL(t)}
              onClick={() => {
                setTab(t);
                setFocusIdx(0);
              }}
            >
              {TAB_ICON[t]}
            </button>
          ))}
        </div>
      )}
      <div role={searching ? undefined : 'tabpanel'} aria-label={searching ? undefined : TAB_LABEL(activeTab)}>
        {cells.length === 0 ? (
          <p className="emoji-empty">No emoji found</p>
        ) : (
          <div ref={gridRef} role="grid" aria-label="Emoji" className="emoji-grid" onKeyDown={onGridKey}>
            {rows.map((row, r) => (
              <div role="row" key={r} className="emoji-row">
                {row.map((c, j) => {
                  const i = r * PICKER_COLUMNS + j;
                  return (
                    <span role="gridcell" key={`${c.code}-${i}`}>
                      <button
                        type="button"
                        aria-label={c.label}
                        title={c.label}
                        data-index={i}
                        tabIndex={i === Math.min(focusIdx, cells.length - 1) ? 0 : -1}
                        onClick={() => pick(c)}
                        onFocus={() => setFocusIdx(i)}
                      >
                        {c.src ? <EmojiImg e={{ src: c.src, alt: c.alt, title: c.label }} /> : c.label}
                      </button>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      <div role="radiogroup" aria-label="Skin tone" className="emoji-tones">
        {TONES.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={skinTone === t}
            aria-label={t === 1 ? 'Default skin tone' : `Skin tone ${t}`}
            onClick={() => emoji.setSkinTone(t)}
          >
            {resolveBuiltin('wave', t)?.char}
          </button>
        ))}
      </div>
    </div>
  );
}
