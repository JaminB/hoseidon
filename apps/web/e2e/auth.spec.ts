import { expect, test } from '@playwright/test';
import { ADMIN_PASSWORD } from './auth';

test.describe('signed out', () => {
  // No cookie: this is what a stranger sees.
  test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 } });

  test('API refuses, the app shows the login page, and a wrong password is rejected', async ({
    page,
    request,
  }) => {
    expect((await request.get('/api/devices')).status()).toBe(401);

    await page.goto('/devices');
    await expect(page.getByRole('heading', { name: 'Hoseidon' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    await page.screenshot({ path: 'e2e/__screenshots__/login-desktop-light.png' });

    await page.getByLabel('Password').fill('not it');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Wrong password');
    // Still on the login page; nothing from the app leaked through.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  });

  test('login page on a phone, dark', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await page.screenshot({ path: 'e2e/__screenshots__/login-phone-dark.png' });
  });

  test('signing in lands in the app, and signing out comes back', async ({ page }) => {
    await page.goto('/settings');
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

    await page.getByTestId('security-card').getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect((await page.request.get('/api/devices')).status()).toBe(401);
  });
});

test.describe('settings', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('connection test uses the mock, and the webhook cannot be registered in mock mode', async ({
    page,
  }) => {
    await page.goto('/settings');
    const card = page.getByTestId('linktap-card');
    await card.getByRole('button', { name: 'Test' }).click();
    await expect(
      // The poller has usually spent LinkTap's 5-minute slot already, so either answer is fine.
      card.getByRole('status').filter({ hasText: /Mock LinkTap answered|Reusing the last poll/ }),
    ).toBeVisible();
    await expect(card.getByTestId('webhook-url')).toContainText('/hooks/linktap/');
    await expect(card.getByRole('button', { name: 'Register' })).toBeDisabled();
    await expect(card.getByText(/Mock mode is on/)).toBeVisible();
  });

  test('units switch the whole app, and notifications explain themselves', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('radio', { name: 'Imperial' }).click();
    await expect(page.getByRole('radio', { name: 'Imperial' })).toBeChecked();
    // Notifications: no service worker in the test browser, so the device switch stays off.
    const notifications = page.getByTestId('notifications-card');
    await expect(notifications.getByRole('switch', { name: 'Notify for alarms' })).toBeChecked();
    await expect(
      notifications.getByRole('switch', { name: 'Notify for skipped runs' }),
    ).not.toBeChecked();
    await page.screenshot({
      path: 'e2e/__screenshots__/settings-full-desktop.png',
      fullPage: true,
    });

    await page.goto('/analytics');
    await expect(page.getByText(/\bgal\b/).first()).toBeVisible();
    await page.goto('/settings');
    await page.getByRole('radio', { name: 'Metric' }).click();
  });

  test('the time zone saves and says a restart is needed', async ({ page }) => {
    await page.goto('/settings');
    await page.getByLabel('Server time zone').fill('Pacific/Auckland');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Restart Hoseidon to switch from/)).toBeVisible();
  });
});
