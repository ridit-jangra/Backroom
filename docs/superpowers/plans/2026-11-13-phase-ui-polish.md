# UI Polish ("Backroom lounge") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Backroom web app (which the desktop app also loads) in the user-chosen "Backroom lounge" direction, with no change in behaviour.

**Architecture:** CSS-only redesign driven by a token layer in `apps/web/src/styles.css`, plus small markup changes where structure is missing (wrappers, class names, accessible labels). Fonts are self-hosted through `@fontsource`. The worker, protocol and desktop are untouched.

**Tech Stack:** React 19, Vite 8, plain CSS custom properties, `@fontsource/atkinson-hyperlegible` 5.3.0, `@fontsource-variable/bricolage-grotesque` 5.3.0.

**Spec:** docs/superpowers/specs/2026-11-11-backroom-design.md (UI behaviour unchanged). Direction chosen by the user on 2026-11-13 ("Backroom lounge (Recommended)"), ruling G3.

## Design system (binding)

Tokens. Light is the default and dark sits under `prefers-color-scheme: dark`; the sidebar is dark in both.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--room` | `#14201b` | `#0f1814` | sidebar background (deep green-black) |
| `--room-fg` | `#e7ede9` | `#e7ede9` | sidebar text |
| `--room-muted` | `#9fb0a7` | `#8fa197` | sidebar secondary text |
| `--room-hover` | `#1f2e27` | `#1a2620` | sidebar hover/active row |
| `--brass` | `#b8892b` | `#d4a64a` | accent: unread dot, mention badge, focus ring, primary button |
| `--on-brass` | `#1a1408` | `#1a1408` | text on brass |
| `--paper` | `#fafbf9` | `#171c19` | main/thread background |
| `--ink` | `#1b231f` | `#e4e9e6` | main text |
| `--ink-muted` | `#5d6b64` | `#9aa8a1` | timestamps, meta |
| `--rule` | `#dfe5e1` | `#2a332e` | dividers, input borders |
| `--wash` | `#eef2ef` | `#1f2622` | hover row, code, quoted, chips |
| `--danger` | `#b3261e` | `#ff8a80` | errors, destructive |
| `--presence` | `#3f9b6b` | `#5cc28c` | online dot |

Type:
- Body text, inputs and messages use **Atkinson Hyperlegible** at 400 and 700, 15px/1.5 in messages and 16px elsewhere.
- **Bricolage Grotesque** (variable) is used only for the workspace name (wght 700, 1.25rem), the channel title in the header (wght 650, 1.125rem) and auth page headings. Nowhere else.
- Scale: 0.8125 / 0.875 / 1 / 1.125 / 1.25 / 1.75 rem.
- Message line length is capped at 72ch.
- No all-caps labels anywhere. Sidebar section names ("Channels", "Direct messages") are sentence case, `--room-muted`, 0.8125rem, wght 700.

Layout: keep the existing grid (260px sidebar, fluid main, 360px thread or search panel).
- Sidebar rows are 30px tall with 8px horizontal padding and 6px radius.
- The active channel row gets `--room-hover` plus a 3px brass bar on its left edge. This bar is the one signature element; nothing else gets a bar.
- Unread channel names go bold and full `--room-fg`, and mention counts go in a brass pill.
- Messages: a compact author line (name 700, time `--ink-muted` 0.8125rem) and a body. Consecutive messages from the same author within 5 minutes collapse the author line, keeping the existing behaviour if present; only the style changes.
- The composer is a single bordered surface (`--rule`, 8px radius) that turns brass on focus-within.
- Radii are 6px for rows and controls and 8px for surfaces (composer, dialogs, panels); avatars and presence dots are round. No shadows except dialogs (`0 12px 32px rgba(10,20,15,.28)`).

Principles:
- The dark "back room" sidebar against a calm paper room is the personality; spend boldness only there and on the brass.
- No gradients, no decorative cards, no entrance animations. Motion only answers actions (dialog open 120ms, thread panel slide 160ms), and is disabled under `prefers-reduced-motion`.
- Visible focus on every control: a 2px brass outline with a 2px offset (inside the sidebar, offset against `--room`). Contrast is at least 4.5:1 for text (check brass on paper: buttons use `--on-brass` text on brass, and brass is never used for body text on paper).
- Copy stays as is unless it is wrong; sentence case everywhere.

## Global Constraints

- No behaviour changes: every existing test must still pass. Tests that select by text or role must not need edits. If a test selects by a class name you rename, keep the old class alongside, or update the test only when it is purely a style hook (ruling recorded).
- Never run `vite build` into `apps/web/dist`, because the user's dev server on 8787 serves it live. For visual checks:
  - build with `npx vite build --outDir <scratch>/ui-dist` (scratch = /tmp/claude-1000/-home-ridit/65796474-8e29-42ed-bc90-085080fd8497/scratchpad)
  - serve it with `npx wrangler dev --port 8788 --assets <scratch>/ui-dist --var APP_ORIGIN:http://localhost:8788 --persist-to <scratch>/ui-state` from apps/worker
  - sign in via the dev log link and screenshot with Playwright (the MCP browser tools, if available to you, or `npx playwright` from a scratch dir)
  - kill only the processes you started
- Fonts are self-hosted via `@fontsource`, with exact pins. No third-party font CDN.
- Twemoji art and attribution are unchanged.

## Review Focus

1. Dark mode: every surface reads correctly, and none are left white or black.
2. Keyboard focus is visible on sidebar rows, message actions, the composer, dialogs, the emoji picker and the search panel.
3. Long content (very long channel names, unbroken URLs, big code blocks, many reactions) wraps without horizontal scroll.
4. Narrow windows down to 800px (the desktop minimum) keep the sidebar and the message area usable; the thread/search panel may overlay instead of squeezing.
5. Unread, mention and active states are distinguishable without colour alone (weight, pill, bar).

---

### Task 1: Tokens, fonts, base elements

**Files:** `apps/web/package.json` (+ lockfile), `apps/web/src/main.tsx` (font imports), `apps/web/src/styles.css`.
- [ ] Install the exact-pinned font packages and import `@fontsource/atkinson-hyperlegible/400.css`, `/700.css` and `@fontsource-variable/bricolage-grotesque` in main.tsx.
- [ ] Replace the `:root` tokens with the table above. Map the old variables (`--bg`, `--fg`, `--muted`, `--side`, `--line`, `--accent`, ...) to the new tokens so unstyled areas follow, then migrate usages.
- [ ] Base styles: body, buttons (secondary is a `--rule` border on transparent; primary is brass with `--on-brass`), inputs, links, `[role=alert]` using `--danger`, the focus ring, scrollbar colours (`scrollbar-color`), the reduced-motion block, and `.card` for auth pages (Bricolage heading, 26rem column).
- [ ] Run `npm test -w apps/web` (all pass) and `npx tsc -p apps/web`, then do a screenshot check of Login in light and dark (dark via Playwright `colorScheme: 'dark'`).
- [ ] Commit `style(web): lounge design tokens, fonts and base elements`.

### Task 2: Shell, sidebar, header

**Files:** `styles.css`, `components/Sidebar.tsx`, `pages/Workspace.tsx` (class names and wrappers only).
- [ ] Sidebar: the workspace name in Bricolage, the action buttons restyled as quiet rows, sentence-case section headings, 30px channel rows, the active brass bar, a bold unread state, brass mention pills, presence dots (`--presence` or a hollow ring for away), and the DM list.
- [ ] Header: the channel title in Bricolage with the topic in `--ink-muted`, truncated on one line with a title attribute; the search input as a quiet field with a brass focus. Restyle the banners (archived, notifications, connection) with `--wash` and a left rule, not yellow.
- [ ] Below 1000px the thread/search panel overlays the main area as an absolutely positioned right panel with a `--rule` left border, rather than squeezing it.
- [ ] Run the tests and tsc, then screenshot the workspace in light and dark at 1280 and 820 widths.
- [ ] Commit `style(web): lounge sidebar, header and shell`.

### Task 3: Messages, composer, threads, reactions, files

**Files:** `styles.css`, `components/MessageList.tsx`, `MessageText.tsx`, `Composer.tsx`, `ThreadPanel.tsx`, `TypingIndicator.tsx`, `files/MessageFiles.tsx` and the emoji picker/reaction components (class names and wrappers only).
- [ ] Message rows:
  - a hover `--wash`
  - an author line and a 72ch body
  - mentions of me highlighted with a brass-tinted background (`color-mix(in srgb, var(--brass) 18%, transparent)`) and others with `--wash`
  - code and pre in `--wash` with a mono stack (`ui-monospace, "JetBrains Mono", monospace`), allowed here because it is real code
  - links underlined
  - edited/deleted markers in `--ink-muted`
  - the thread reply summary as a brass text button
- [ ] Message action toolbar (react, reply, edit, delete): a small floating `--paper` bar with a `--rule` border, shown on hover and focus-within, so it is keyboard reachable.
- [ ] Reactions: `--wash` chips; my reaction gets a brass border.
- [ ] File cards: `--rule` border, 8px radius, a thumbnail at most 360px wide, a name and size line, and download as a secondary button.
- [ ] Composer: one surface with a brass focus-within, attachment chips matching file cards, the upload progress bar in brass, and the blocked notice as `--danger` text.
- [ ] Fix ruling P4-R28: the stale "Wait for uploads to finish." notice clears when no item is pending or failed, and `retry` clears the failed notice. Add tests.
- [ ] Thread panel: header with the parent message, a `--rule` divider and its own composer.
- [ ] Typing indicator in `--ink-muted` italic, 0.8125rem.
- [ ] Run the tests and tsc, then screenshot a seeded conversation: mentions, code, a long URL, reactions, an image and a PDF file, an open thread, light and dark.
- [ ] Commit `style(web): lounge messages, composer and threads`.

### Task 4: Dialogs, search panel, emoji picker, admin, custom emoji and auth pages

**Files:** `styles.css`, `components/Dialog.tsx`, `ChannelBrowser.tsx`, `NewDmDialog.tsx`, `ChannelSettings.tsx`, `search/SearchPanel.tsx`, the emoji picker files, `pages/Admin.tsx`, `CustomEmoji.tsx`, `Login.tsx`, `Verify.tsx`, `Invite.tsx`, `DesktopAuth.tsx`, `About.tsx`, `ErrorBoundary.tsx`.
- [ ] Dialogs: `--paper` surface, 8px radius, the dialog shadow, a Bricolage title, a 120ms open motion (none under reduced motion), and a backdrop of `rgba(10,20,15,.45)`.
- [ ] Search panel: query chips and result rows with the channel and time meta; `<mark>` in snippets is a brass tint, not yellow.
- [ ] Emoji picker: the category tabs get a brass underline on the active tab, the grid hover is `--wash`, and the skin-tone control is restyled.
- [ ] Admin and custom emoji pages: tables with `--rule` row dividers and quiet buttons; destructive buttons use `--danger`.
- [ ] Auth pages: the 26rem column, the "Backroom" wordmark in Bricolage above the form (text only, no logo art), and success and error states.
- [ ] Run the tests and tsc, then screenshot each page in light and dark.
- [ ] Commit `style(web): lounge dialogs, search, picker, admin and auth pages`.

### Task 5: Visual QA pass

- [ ] Walk the Review Focus list against fresh screenshots (light and dark, at 1280 and 820): long channel name, unbroken URL, 30 reactions, big code block, every dialog, and keyboard-only navigation through the sidebar, a message action and the composer. Fix what fails, CSS first.
- [ ] Run a contrast check: compute ratios for `--ink`/`--paper`, `--ink-muted`/`--paper`, `--room-fg`/`--room`, `--room-muted`/`--room` and `--on-brass`/`--brass` in both modes, and record them in the report. All must be at least 4.5:1, except `--room-muted` used only at 0.8125rem bold, which must be at least 4.5:1 anyway.
- [ ] Run all the suites: worker, web, desktop, protocol and emoji.
- [ ] Add a README "Look and feel" note of two lines: the fonts and the token location.
- [ ] Commit `style(web): lounge visual QA fixes`.
