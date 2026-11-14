import { expect, test } from '@playwright/test';

// Regression for the blank-page bug: `/` redirects to the workspace, whose 401 must reach /login.
test('a signed-out visit to / lands on /login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in to Backroom' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
});
