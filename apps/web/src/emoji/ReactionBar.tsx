import type { MemberSummary, ReactionSummary } from '@backroom/protocol';
import { parseReactionCode } from '@backroom/emoji';
import { useEmoji } from './EmojiContext';
import { EmojiImg } from './EmojiImg';

const MAX_NAMES = 10;

/** "You" first, then the others in reaction order; at most 10 names, then "and N others". */
export function reactionTooltip(userIds: string[], me: string, members: MemberSummary[], emoji: string): string {
  const names: string[] = [];
  if (userIds.includes(me)) names.push('You');
  for (const id of userIds) {
    if (id !== me) names.push(members.find((m) => m.id === id)?.displayName ?? 'Unknown');
  }
  const shown = names.slice(0, MAX_NAMES);
  const rest = names.length - shown.length;
  if (rest > 0) shown.push(`${rest} ${rest === 1 ? 'other' : 'others'}`);
  const list = shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return `${list} reacted with :${emoji}:`;
}

export function ReactionBar({
  reactions,
  me,
  members,
  connected,
  onToggle,
}: {
  reactions: ReactionSummary[];
  me: string;
  members: MemberSummary[];
  connected: boolean;
  onToggle: (emoji: string, on: boolean) => boolean;
}) {
  const { resolve } = useEmoji();
  if (reactions.length === 0) return null;
  return (
    <div className="reactions">
      {reactions.map((r) => {
        const mine = r.userIds.includes(me);
        const tip = reactionTooltip(r.userIds, me, members, r.emoji);
        const p = parseReactionCode(r.emoji);
        const res = p ? resolve(p.name, p.tone) : null;
        return (
          <button
            key={r.emoji}
            type="button"
            className="reaction"
            aria-pressed={mine}
            title={tip}
            aria-label={tip}
            disabled={!connected}
            onClick={() => onToggle(r.emoji, !mine)}
          >
            {res ? <EmojiImg e={res} /> : `:${r.emoji}:`} <span className="reaction-count">{r.userIds.length}</span>
          </button>
        );
      })}
    </div>
  );
}
