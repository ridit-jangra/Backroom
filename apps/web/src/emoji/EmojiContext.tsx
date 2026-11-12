import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CustomEmoji } from '@backroom/protocol';
import { DEFAULT_FREQUENT, formatShortcode, resolveBuiltin, twemojiSrc, type SkinTone } from '@backroom/emoji';
import { addUse, loadPrefs, savePrefs, topFrequent, type EmojiPrefs } from './prefs';

export type ResolvedEmoji = { src: string; alt: string; title: string };

export type EmojiApi = {
  custom: ReadonlyMap<string, CustomEmoji>;
  resolve(name: string, tone: SkinTone | null): ResolvedEmoji | null;
  isKnown(name: string, tone: SkinTone | null): boolean;
  /** P3-R9: the canonical reaction code, mirroring the server's canonicalReaction. */
  canonical(name: string, tone: SkinTone | null): string | null;
  skinTone: SkinTone;
  setSkinTone(t: SkinTone): void;
  frequent: string[];
  recordUse(code: string): void;
};

function builtin(name: string, tone: SkinTone | null): ResolvedEmoji | null {
  const b = resolveBuiltin(name, tone);
  return b ? { src: twemojiSrc(b.img), alt: b.char, title: `:${formatShortcode(name, tone)}:` } : null;
}

function makeResolvers(custom: ReadonlyMap<string, CustomEmoji>) {
  /** A custom emoji's image src: its own url, or its alias target's (built-in or custom). */
  function customSrc(c: CustomEmoji): string | null {
    if (c.aliasFor === null) return c.url;
    const b = resolveBuiltin(c.aliasFor, null);
    if (b) return twemojiSrc(b.img);
    const target = custom.get(c.aliasFor);
    return target && target.aliasFor === null ? target.url : null;
  }
  function resolve(name: string, tone: SkinTone | null): ResolvedEmoji | null {
    const b = builtin(name, tone);
    if (b) return b;
    const c = custom.get(name);
    if (!c || (tone !== null && tone !== 1)) return null;
    const src = customSrc(c);
    return src ? { src, alt: `:${name}:`, title: `:${name}:` } : null;
  }
  function canonical(name: string, tone: SkinTone | null): string | null {
    const b = resolveBuiltin(name, tone);
    if (b) return b.canonical;
    const c = custom.get(name);
    if (!c || (tone !== null && tone !== 1)) return null;
    if (c.aliasFor === null) return c.name;
    const tb = resolveBuiltin(c.aliasFor, null);
    if (tb) return tb.canonical;
    const target = custom.get(c.aliasFor);
    return target && target.aliasFor === null ? target.name : null;
  }
  return { resolve, canonical, isKnown: (name: string, tone: SkinTone | null) => resolve(name, tone) !== null };
}

const EMPTY: ReadonlyMap<string, CustomEmoji> = new Map();
const builtinResolvers = makeResolvers(EMPTY);

/** Without a provider: built-ins only, default tone, default frequent list, nothing persisted. */
const FALLBACK: EmojiApi = {
  custom: EMPTY,
  ...builtinResolvers,
  skinTone: 1,
  setSkinTone: () => undefined,
  frequent: DEFAULT_FREQUENT,
  recordUse: () => undefined,
};

const EmojiCtx = createContext<EmojiApi>(FALLBACK);

export function EmojiProvider({ userId, custom, children }: { userId: string; custom: CustomEmoji[]; children: ReactNode }) {
  const [prefs, setPrefs] = useState<EmojiPrefs>(() => loadPrefs(userId));
  useEffect(() => setPrefs(loadPrefs(userId)), [userId]);

  const update = useCallback(
    (f: (p: EmojiPrefs) => EmojiPrefs) =>
      setPrefs((p) => {
        const next = f(p);
        savePrefs(userId, next);
        return next;
      }),
    [userId],
  );
  const setSkinTone = useCallback((t: SkinTone) => update((p) => ({ ...p, skinTone: t })), [update]);
  const recordUse = useCallback((code: string) => update((p) => addUse(p, code, Date.now())), [update]);

  const map = useMemo(() => new Map(custom.map((c) => [c.name, c])), [custom]);
  // Resolvers change identity only when the custom set does, so MessageText re-tokenizes only then.
  const resolvers = useMemo(() => makeResolvers(map), [map]);
  const frequent = useMemo(() => topFrequent(prefs), [prefs]);

  const value = useMemo<EmojiApi>(
    () => ({ custom: map, ...resolvers, skinTone: prefs.skinTone, setSkinTone, frequent, recordUse }),
    [map, resolvers, prefs.skinTone, setSkinTone, frequent, recordUse],
  );
  return <EmojiCtx.Provider value={value}>{children}</EmojiCtx.Provider>;
}

export function useEmoji(): EmojiApi {
  return useContext(EmojiCtx);
}
