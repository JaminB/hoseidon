import { expect, test as setup } from '@playwright/test';
import { ADMIN_PASSWORD, AUTH_FILE } from './auth';

/** Signs in once through the real login endpoint; every other test reuses the cookie. */
setup('sign in', async ({ request }) => {
  const res = await request.post('/api/auth/login', {
    data: { password: ADMIN_PASSWORD },
    headers: { 'x-hoseidon-csrf': '1' },
  });
  expect(res.ok(), await res.text()).toBe(true);
  await request.storageState({ path: AUTH_FILE });
});
