import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { channelIdOf, makePng, signIn } from '../helpers';
import { OWNER_EMAIL, WORKSPACE } from '../paths';

// One workspace, one story: each step builds on the previous one, and the server starts from
// an empty state on every run, so the fixed texts below are unique.
test.describe.configure({ mode: 'serial' });

const BOB = 'bob@e2e.test';
const CAROL = 'carol@e2e.test';
const OWNER_HELLO = 'Morning all, the marmalade sandwich is in the fridge';
const BOB_HELLO = 'Thanks owner, bob here';
const THREAD_REPLY = 'Replying in the thread about the sandwich';
const FILES_NOTE = 'Here are the files';
const PRIVATE = 'secret-plans';
const PRIVATE_NOTE = 'Eyes only: the lighthouse plan';

let owner: Page;
let bob: Page;
const contexts: BrowserContext[] = [];
let inviteUrl = '';
let generalId = '';
let privateId = '';

async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  return ctx.newPage();
}

const log = (p: Page) => p.getByRole('log', { name: 'Messages' });
const row = (p: Page, text: string) => log(p).getByRole('listitem').filter({ hasText: text });
const composer = (p: Page, channel: string) => p.getByRole('textbox', { name: `Message #${channel}` });
const channelsNav = (p: Page) => p.getByRole('navigation', { name: 'Channels' });

async function send(p: Page, channel: string, text: string) {
  const box = composer(p, channel);
  await box.fill(text);
  await box.press('Enter');
  await expect(box).toHaveValue('');
  // The optimistic row is swapped for the stored one on ack; wait for that so later steps
  // never hold a row that is about to be replaced.
  await expect(log(p).locator('li.msg:not(.pending)').filter({ hasText: text })).toHaveCount(1);
}

test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
});

test('the owner signs in and creates an invite', async ({ browser }) => {
  owner = await newPage(browser);
  await signIn(owner, OWNER_EMAIL);
  await expect(channelsNav(owner).getByRole('button', { name: '#general' })).toBeVisible();
  generalId = channelIdOf(owner);

  await owner.getByRole('link', { name: 'Admin' }).click();
  await expect(owner).toHaveURL(new RegExp(`/client/${WORKSPACE}/admin$`));
  await owner.getByRole('button', { name: 'Create invite' }).click();
  const link = owner.getByRole('textbox', { name: 'Invite link' });
  await expect(link).toHaveValue(/\/invite\/\S+$/);
  inviteUrl = await link.inputValue();
  await owner.getByRole('link', { name: 'Back to chat' }).click();
  await expect(owner).toHaveURL(new RegExp(`/client/${WORKSPACE}/${generalId}$`));
});

test('user B signs in through the invite', async ({ browser }) => {
  bob = await newPage(browser);
  await signIn(bob, BOB, inviteUrl);
  expect(channelIdOf(bob)).toBe(generalId);
  await expect(bob.locator('.channel-title')).toContainText('#general');
  // The owner's open tab learns about the new member live.
  await expect(owner.getByRole('list', { name: 'Members' })).toContainText('bob');
});

test('#general: messages arrive in real time in both directions', async () => {
  await send(owner, 'general', OWNER_HELLO);
  await expect(row(bob, OWNER_HELLO)).toBeVisible();
  await expect(row(bob, OWNER_HELLO)).toContainText('owner');

  await send(bob, 'general', BOB_HELLO);
  await expect(row(owner, BOB_HELLO)).toBeVisible();
  await expect(row(owner, BOB_HELLO)).toContainText('bob');
});

test('#general: a thread reply reaches the other user', async () => {
  const parent = row(owner, OWNER_HELLO);
  await parent.hover();
  await parent.getByRole('button', { name: 'Reply in thread' }).click();
  const thread = owner.getByRole('complementary', { name: 'Thread' });
  await expect(thread).toContainText(OWNER_HELLO);
  const reply = thread.getByRole('textbox', { name: 'Reply…' });
  await reply.fill(THREAD_REPLY);
  await reply.press('Enter');
  await expect(thread.getByRole('list', { name: 'Replies' })).toContainText(THREAD_REPLY);
  await thread.getByRole('button', { name: 'Close' }).click();
  await expect(thread).toHaveCount(0);

  const bobParent = row(bob, OWNER_HELLO);
  await bobParent.getByRole('button', { name: '1 reply' }).click();
  const bobThread = bob.getByRole('complementary', { name: 'Thread' });
  await expect(bobThread.getByRole('list', { name: 'Replies' })).toContainText(THREAD_REPLY);
  await bobThread.getByRole('button', { name: 'Close' }).click();
  await expect(bobThread).toHaveCount(0);
});

test('#general: a reaction shows for both users', async () => {
  const target = row(bob, OWNER_HELLO);
  await target.hover();
  await target.getByRole('button', { name: 'Add reaction' }).click();
  const picker = bob.getByRole('dialog', { name: 'Add reaction' });
  await picker.getByRole('searchbox', { name: 'Search emoji' }).fill('tada');
  await picker.getByRole('button', { name: ':tada:', exact: true }).click();
  await expect(picker).toHaveCount(0);

  await expect(target.getByRole('button', { name: 'You reacted with :tada:' })).toHaveAttribute('aria-pressed', 'true');
  await expect(row(owner, OWNER_HELLO).getByRole('button', { name: 'bob reacted with :tada:' })).toBeVisible();
});

test('#general: a PNG (with thumbnail) and a text file upload', async () => {
  await owner.getByTestId('file-input').setInputFiles([
    { name: 'gradient.png', mimeType: 'image/png', buffer: makePng() },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('plain text notes for the e2e run\n') },
  ]);
  const uploads = owner.locator('.upload-list');
  await expect(uploads).toContainText('gradient.png');
  await expect(uploads).toContainText('notes.txt');
  // The bar stays up until the upload and the client-made thumbnail are both stored.
  await expect(uploads.getByRole('progressbar')).toHaveCount(0);
  await expect(uploads.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await send(owner, 'general', FILES_NOTE);

  for (const p of [owner, bob]) {
    const msg = row(p, FILES_NOTE);
    const img = msg.getByRole('img', { name: 'gradient.png' });
    await expect(img).toHaveAttribute('src', /^\/files\/[0-9A-Z]{26}\/thumb$/);
    await expect(img).toBeInViewport();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
    await expect(msg.getByRole('link', { name: 'Download notes.txt' })).toBeVisible();
  }
});

test('the owner creates a private channel', async () => {
  await owner.getByRole('button', { name: 'Browse channels' }).click();
  const dialog = owner.getByRole('dialog', { name: 'Browse channels' });
  const form = dialog.getByRole('form', { name: 'Create channel' });
  await form.getByLabel('Name', { exact: true }).fill(PRIVATE);
  await form.getByRole('checkbox', { name: 'Private' }).check();
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(owner.locator('.channel-title')).toContainText(`#${PRIVATE}`);
  privateId = channelIdOf(owner);
  expect(privateId).not.toBe(generalId);
  await expect(channelsNav(owner).getByRole('button', { name: `#${PRIVATE}` })).toBeVisible();
  await send(owner, PRIVATE, PRIVATE_NOTE);
  await expect(row(owner, PRIVATE_NOTE)).toBeVisible();
});

test('search finds a #general message and jumps to it', async () => {
  // From the private channel, so the jump has to switch channels.
  const search = owner.getByRole('searchbox', { name: 'Search messages' });
  await search.fill('marmalade');
  await search.press('Enter');
  const results = owner.getByRole('complementary', { name: 'Search results' });
  const hit = results.getByRole('button').filter({ hasText: 'marmalade' });
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText('#general');
  await hit.click();

  await expect(owner).toHaveURL(new RegExp(`/client/${WORKSPACE}/${generalId}$`));
  await expect(owner.locator('.channel-title')).toContainText('#general');
  const target = row(owner, OWNER_HELLO);
  await expect(target).toHaveClass(/\bhighlighted\b/);
  await expect(target).toBeInViewport();
});

test('a third user cannot see the private channel or open its URL', async ({ browser }) => {
  const carol = await newPage(browser);
  await signIn(carol, CAROL, inviteUrl);
  await expect(channelsNav(carol).getByRole('button', { name: '#general' })).toBeVisible();
  await expect(channelsNav(carol).getByRole('button', { name: `#${PRIVATE}` })).toHaveCount(0);

  await carol.getByRole('button', { name: 'Browse channels' }).click();
  const dialog = carol.getByRole('dialog', { name: 'Browse channels' });
  const list = dialog.getByRole('list', { name: 'Channels' });
  await expect(list).toContainText('#general');
  await expect(list).not.toContainText(PRIVATE);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);

  // Search does not leak it either.
  const search = carol.getByRole('searchbox', { name: 'Search messages' });
  await search.fill('lighthouse');
  await search.press('Enter');
  await expect(carol.getByRole('complementary', { name: 'Search results' })).toContainText('No results');

  // Direct navigation: the history request is a 404 and the page shows nothing of the channel.
  const history = carol.waitForResponse((r) => new URL(r.url()).pathname === `/channels/${privateId}/messages`);
  await carol.goto(`/client/${WORKSPACE}/${privateId}`);
  expect((await history).status()).toBe(404);
  await expect(carol.getByText(/This channel isn.t available\./)).toBeVisible();
  await expect(carol.getByText(PRIVATE_NOTE)).toHaveCount(0);
  await expect(carol.locator('.channel-title')).not.toContainText(PRIVATE);

  const direct = await carol.request.get(`/channels/${privateId}/messages`);
  expect(direct.status()).toBe(404);
});
