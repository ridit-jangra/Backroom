import type { MemberSummary } from '@backroom/protocol';

export function typingText(userIds: string[], members: MemberSummary[]): string {
  const names = userIds.map((id) => members.find((m) => m.id === id)?.displayName ?? 'Someone');
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}

export function TypingIndicator({ userIds, members }: { userIds: string[]; members: MemberSummary[] }) {
  const text = typingText(userIds, members);
  // The live region stays mounted so screen readers announce changes.
  return (
    <div className="typing" aria-live="polite">
      {text}
    </div>
  );
}
