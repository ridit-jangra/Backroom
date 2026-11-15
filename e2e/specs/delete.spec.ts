import { expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test';
import { channelIdOf, signIn } from '../helpers';
import { OWNER_EMAIL, WORKSPACE } from '../paths';

// Deleted messages disappear completely: no placeholder, replies go with their starter, counters stay
// exact, and a client that was offline converges on reconnect. One ordered story in #general; every text
// below is unique so rows are found by their text.
test.describe.configure({ mode: 'serial' });

const DANA = 'dana@e2e.test';
const ERIN = 'erin@e2e.test';
const PLACEHOLDER = 'This message was deleted';

const PLAIN = 'plain-kiwi to be deleted';
const STARTER = 'starter-mango with two replies';
const STARTER_REPLY_A = 'mango reply from the owner';
const STARTER_REPLY_B = 'mango reply from dana';
const COUNT_STARTER = 'starter-papaya for counters';
const COUNT_REPLY_1 = 'papaya reply one';
const COUNT_REPLY_2 = 'papaya reply two';
const OFFLINE_PLAIN = 'offline-lychee plain';
const OFFLINE_STARTER = 'offline-guava starter';
const OFFLINE_REPLY = 'guava reply while online';

let owner: Page;
let dana: Page;
const contexts: BrowserContext[] = [];
let danaContext: BrowserContext;
// Dana's hub sockets, passed through to the server untouched until the offline test drops them.
const danaSockets: WebSocketRoute[] = [];
let danaBlocked = false;
let generalId = '';

async function newContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  return ctx;
}

const log = (p: Page) => p.getByRole('log', { name: 'Messages' });
const row = (p: Page, text: string) => log(p).getByRole('listitem').filter({ hasText: text });
const composer = (p: Page) => p.getByRole('textbox', { name: 'Message #general' });
const threadPanel = (p: Page) => p.getByRole('complementary', { name: 'Thread' });
const threadRow = (p: Page, text: string) => threadPanel(p).getByRole('list', { name: 'Replies' }).getByRole('listitem').filter({ hasText: text });
const replyButton = (r: ReturnType<typeof row>) => r.getByRole('button', { name: /^\d+ repl(y|ies)$/ });

async function send(p: Page, text: string) {
  const box = composer(p);
  await box.fill(text);
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect(log(p).locator('li.msg:not(.pending)').filter({ hasText: text })).toHaveCount(1);
}

/** Replies to the message with `parent` text; opens the thread through the toolbar (A) or the count button (B). */
async function reply(p: Page, parent: string, text: string) {
  if ((await threadPanel(p).count()) === 0) {
    const r = row(p, parent);
    const open = replyButton(r);
    if ((await open.count()) > 0) await open.click();
    else {
      await r.hover();
      await r.getByRole('button', { name: 'Reply in thread' }).click();
    }
  }
  await expect(threadPanel(p)).toContainText(parent);
  const box = threadPanel(p).getByRole('textbox', { name: 'Reply…' });
  await box.fill(text);
  await box.press('Enter');
  await expect(threadRow(p, text)).toHaveCount(1);
}

async function closeThread(p: Page) {
  await threadPanel(p).getByRole('button', { name: 'Close' }).click();
  await expect(threadPanel(p)).toHaveCount(0);
}

/** Plain messages and replies confirm through the browser's own dialog. */
async function deleteWithNativeConfirm(p: Page, target: ReturnType<typeof row>) {
  p.once('dialog', (d) => void d.accept());
  await target.hover();
  await target.getByRole('button', { name: 'Delete', exact: true }).click();
}

async function expectNoPlaceholder(...pages: Page[]) {
  for (const p of pages) await expect(p.getByText(PLACEHOLDER)).toHaveCount(0);
}

test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
});

test('the owner and a second user are in #general', async ({ browser }) => {
  owner = await (await newContext(browser)).newPage();
  await signIn(owner, OWNER_EMAIL);
  generalId = channelIdOf(owner);
  await owner.getByRole('link', { name: 'Admin' }).click();
  await owner.getByRole('button', { name: 'Create invite' }).click();
  const link = owner.getByRole('textbox', { name: 'Invite link' });
  await expect(link).toHaveValue(/\/invite\/\S+$/);
  const inviteUrl = await link.inputValue();
  await owner.getByRole('link', { name: 'Back to chat' }).click();
  await expect(owner).toHaveURL(new RegExp(`/client/${WORKSPACE}/${generalId}$`));

  danaContext = await newContext(browser);
  dana = await danaContext.newPage();
  await dana.routeWebSocket(/\/ws\?/, (ws) => {
    if (danaBlocked) return void ws.close();
    ws.connectToServer();
    danaSockets.push(ws);
  });
  await signIn(dana, DANA, inviteUrl);
  expect(channelIdOf(dana)).toBe(generalId);
  await expect(composer(dana)).toBeVisible();
  await expect(composer(owner)).toBeVisible();
});

test('a deleted plain message disappears for both users, with no placeholder', async () => {
  await send(owner, PLAIN);
  await expect(row(dana, PLAIN)).toBeVisible();

  await deleteWithNativeConfirm(owner, row(owner, PLAIN));
  await expect(row(owner, PLAIN)).toHaveCount(0);
  await expect(row(dana, PLAIN)).toHaveCount(0);
  await expect(owner.getByText(PLAIN)).toHaveCount(0);
  await expect(dana.getByText(PLAIN)).toHaveCount(0);
  await expectNoPlaceholder(owner, dana);
});

test('deleting a thread starter asks first, then removes it and all its replies for everyone', async () => {
  await send(owner, STARTER);
  await expect(row(dana, STARTER)).toBeVisible();
  await reply(owner, STARTER, STARTER_REPLY_A);
  await closeThread(owner);

  // Dana joins the thread (and keeps it open).
  await expect(replyButton(row(dana, STARTER))).toHaveText('1 reply');
  await reply(dana, STARTER, STARTER_REPLY_B);
  await expect(replyButton(row(owner, STARTER))).toHaveText('2 replies');

  const target = row(owner, STARTER);
  await target.hover();
  await target.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = owner.getByRole('dialog', { name: 'Delete this message?' });
  await expect(dialog).toContainText("This also deletes 2 replies. This can't be undone.");
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

  // Cancel keeps everything.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(owner, STARTER)).toBeVisible();
  await expect(replyButton(row(owner, STARTER))).toHaveText('2 replies');
  await expect(threadRow(dana, STARTER_REPLY_A)).toBeVisible();

  // So does Escape.
  await target.hover();
  await target.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toBeVisible();
  await owner.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(row(owner, STARTER)).toBeVisible();
  await expect(row(dana, STARTER)).toBeVisible();

  // Delete confirms.
  await target.hover();
  await target.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(owner, STARTER)).toHaveCount(0);
  await expect(row(dana, STARTER)).toHaveCount(0);
  // Dana's open thread closes by itself, and no reply text remains anywhere.
  await expect(threadPanel(dana)).toHaveCount(0);
  for (const p of [owner, dana]) {
    for (const t of [STARTER, STARTER_REPLY_A, STARTER_REPLY_B]) await expect(p.getByText(t)).toHaveCount(0);
  }
  await expectNoPlaceholder(owner, dana);
});

test('deleting replies lowers the starter count live, and the summary goes away with the last one', async () => {
  await send(owner, COUNT_STARTER);
  await expect(row(dana, COUNT_STARTER)).toBeVisible();
  await reply(dana, COUNT_STARTER, COUNT_REPLY_1);
  await reply(dana, COUNT_STARTER, COUNT_REPLY_2);
  const ownerStarter = row(owner, COUNT_STARTER);
  await expect(replyButton(ownerStarter)).toHaveText('2 replies');

  await deleteWithNativeConfirm(dana, threadRow(dana, COUNT_REPLY_1));
  await expect(threadRow(dana, COUNT_REPLY_1)).toHaveCount(0);
  await expect(replyButton(ownerStarter)).toHaveText('1 reply');
  await expect(replyButton(row(dana, COUNT_STARTER))).toHaveText('1 reply');

  await deleteWithNativeConfirm(dana, threadRow(dana, COUNT_REPLY_2));
  await expect(threadRow(dana, COUNT_REPLY_2)).toHaveCount(0);
  await expect(replyButton(ownerStarter)).toHaveCount(0);
  await expect(replyButton(row(dana, COUNT_STARTER))).toHaveCount(0);
  await expect(ownerStarter).toBeVisible(); // the starter itself is not deleted
  await closeThread(dana);
  await expectNoPlaceholder(owner, dana);
});

test('a user who was offline converges after reconnecting, without reloading', async () => {
  await send(owner, OFFLINE_PLAIN);
  await send(owner, OFFLINE_STARTER);
  await reply(owner, OFFLINE_STARTER, OFFLINE_REPLY);
  await closeThread(owner);
  await expect(row(dana, OFFLINE_PLAIN)).toBeVisible();
  await expect(replyButton(row(dana, OFFLINE_STARTER))).toHaveText('1 reply');

  // Dana goes offline. Chrome keeps an open WebSocket through offline emulation, so the socket is also
  // closed from the route (and new ones refused) while REST requests fail; the client says it is reconnecting.
  danaBlocked = true;
  await danaContext.setOffline(true);
  await Promise.all(danaSockets.splice(0).map((ws) => ws.close()));
  await expect(dana.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible({ timeout: 30_000 });

  // Meanwhile the owner deletes a plain message and a starter with a reply.
  await deleteWithNativeConfirm(owner, row(owner, OFFLINE_PLAIN));
  await expect(row(owner, OFFLINE_PLAIN)).toHaveCount(0);
  const ownerStarter = row(owner, OFFLINE_STARTER);
  await ownerStarter.hover();
  await ownerStarter.getByRole('button', { name: 'Delete', exact: true }).click();
  await owner.getByRole('dialog', { name: 'Delete this message?' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(owner, OFFLINE_STARTER)).toHaveCount(0);
  // Dana has not heard of either.
  await expect(row(dana, OFFLINE_PLAIN)).toHaveCount(1);
  await expect(row(dana, OFFLINE_STARTER)).toHaveCount(1);

  // Back online: the client reconnects (with backoff) and refetches the open channel.
  danaBlocked = false;
  await danaContext.setOffline(false);
  await expect(row(dana, OFFLINE_PLAIN)).toHaveCount(0, { timeout: 30_000 });
  await expect(row(dana, OFFLINE_STARTER)).toHaveCount(0, { timeout: 30_000 });
  await expect(dana.getByText(OFFLINE_REPLY)).toHaveCount(0);
  await expectNoPlaceholder(owner, dana);
});

test('a user who signs in after the deletions sees none of it', async ({ browser }) => {
  const erin = await (await newContext(browser)).newPage();
  // Erin joins through a second invite, after every deletion above.
  await owner.getByRole('link', { name: 'Admin' }).click();
  await owner.getByRole('button', { name: 'Create invite' }).click();
  const link = owner.getByRole('textbox', { name: 'Invite link' });
  await expect(link).toHaveValue(/\/invite\/\S+$/);
  const inviteUrl = await link.inputValue();
  await owner.getByRole('link', { name: 'Back to chat' }).click();

  await signIn(erin, ERIN, inviteUrl);
  // The surviving starter (all of whose replies were deleted) proves the channel has loaded.
  const survivor = row(erin, COUNT_STARTER);
  await expect(survivor).toBeVisible();
  await expect(replyButton(survivor)).toHaveCount(0);
  await expect(survivor).not.toContainText(/repl(y|ies)/);
  for (const t of [PLAIN, STARTER, STARTER_REPLY_A, STARTER_REPLY_B, COUNT_REPLY_1, COUNT_REPLY_2, OFFLINE_PLAIN, OFFLINE_STARTER, OFFLINE_REPLY]) {
    await expect(erin.getByText(t)).toHaveCount(0);
  }
  await expectNoPlaceholder(erin);
});
