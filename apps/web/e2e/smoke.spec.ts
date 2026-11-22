import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Loads every page at phone and desktop width in light and dark, checks it renders without
 * errors, and saves screenshots to e2e/__screenshots__ (gitignored) for visual review.
 */

const PAGES = [
  { path: '/', name: 'home', heading: /Good (morning|afternoon|evening|night)/ },
  { path: '/devices', name: 'devices', heading: 'Devices' },
  { path: '/schedule', name: 'schedule', heading: 'Schedule' },
  { path: '/analytics', name: 'analytics', heading: 'Analytics' },
  { path: '/network', name: 'network', heading: 'Network' },
  { path: '/settings', name: 'settings', heading: 'Settings' },
] as const;

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

const TZ = 'America/New_York';
const SCHEMES = ['light', 'dark'] as const;

// Mock LinkTap ids (apps/server/src/linktap/mock.ts).
const ID = {
  frontLawn: 'B1C2D3E4F5A60011',
  veggies: 'B1C2D3E4F5A60012',
  dripA: 'B1C2D3E4F5A60013_1',
  dripB: 'B1C2D3E4F5A60013_2',
  sideYard: 'B1C2D3E4F5A60021',
};

const pad = (n: number) => String(n).padStart(2, '0');
const wall = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Wall time `hh:mm` today in the test time zone (TZ is set for this process by the config). */
function todayAt(h: number, m = 0) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return wall(d);
}

async function seed(request: APIRequestContext) {
  // The poller's first getAllDevices lands right after boot.
  await expect
    .poll(async () => ((await (await request.get('/api/devices')).json()) as unknown[]).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  // One gateway gets a location, so weather and analytics have something to show.
  const located = await request.patch('/api/gateways/A1B2C3D4E5F60001', {
    data: { lat: 40.71, lon: -74.01, timezone: TZ },
  });
  expect(located.ok(), await located.text()).toBe(true);
  const existing = (await (await request.get('/api/schedules')).json()) as unknown[];
  if (existing.length) return;

  // Something later today, so Home has upcoming runs whatever time the test runs.
  const soon = new Date(Date.now() + 40 * 60_000);
  soon.setMinutes(Math.ceil(soon.getMinutes() / 5) * 5, 0, 0);
  const schedules = [
    {
      name: 'Front lawn mornings',
      color: '#40c057',
      rrule: 'FREQ=DAILY;INTERVAL=2',
      dtstart: todayAt(6),
      items: [
        { deviceId: ID.frontLawn, seconds: 20 * 60 },
        { deviceId: ID.sideYard, seconds: 15 * 60 },
      ],
      skipRules: { rainForecastMm: 5, freezeC: 2 },
    },
    {
      name: 'Garden drip',
      color: '#22b8cf',
      rrule: 'FREQ=DAILY',
      dtstart: todayAt(7, 30),
      items: [
        { deviceId: ID.dripA, seconds: 30 * 60 },
        { deviceId: ID.dripB, seconds: 25 * 60 },
      ],
    },
    {
      name: 'Deep soak',
      color: '#4c6ef5',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
      dtstart: todayAt(5, 0),
      items: [{ deviceId: ID.veggies, seconds: 30 * 60 }],
      cycleSoak: { cycles: 3, soakMinutes: 20 },
    },
    {
      name: 'Side yard top-up',
      color: '#f59f00',
      rrule: 'FREQ=WEEKLY;BYDAY=TU,TH,SA',
      dtstart: todayAt(6, 15),
      items: [{ deviceId: ID.sideYard, seconds: 10 * 60 }],
    },
    {
      name: 'Evening refresh',
      color: '#7950f2',
      rrule: 'FREQ=DAILY',
      dtstart: wall(soon),
      items: [
        { deviceId: ID.dripA, seconds: 10 * 60 },
        { deviceId: ID.dripB, seconds: 10 * 60 },
      ],
      skipRules: { etScaling: true },
    },
  ];
  for (const s of schedules) {
    const res = await request.post('/api/schedules', { data: s });
    expect(res.ok(), await res.text()).toBe(true);
  }
}

test.beforeAll(async ({ request }) => {
  await seed(request);
});

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`${vp.name} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme });

      for (const p of PAGES) {
        test(p.name, async ({ page }) => {
          const errors: string[] = [];
          page.on('pageerror', (e) => errors.push(e.message));
          page.on('console', (m) => {
            if (m.type() === 'error') errors.push(m.text());
          });

          await page.goto(p.path);
          await expect(page.getByRole('heading', { level: 1, name: p.heading })).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
          await page.waitForLoadState('networkidle');
          await page.evaluate(() => document.fonts.ready);
          // Let skeletons resolve and entry animations settle.
          await expect(page.locator('.animate-shimmer')).toHaveCount(0);
          await page.waitForTimeout(250);

          await page.screenshot({
            path: `e2e/__screenshots__/${p.name}-${vp.name}-${scheme}.png`,
            fullPage: true,
          });
          expect(errors).toEqual([]);
        });
      }
    });
  }
}

test.describe('interactions', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('drag on the week view opens a prefilled schedule sheet', async ({ page }) => {
    await page.goto('/schedule');
    // Wait for the seeded blocks, then drag at 9:00-10:30, which no seeded schedule uses.
    await expect(page.getByRole('button', { name: /Garden drip/ }).first()).toBeVisible();
    const column = page.getByLabel(/drag to add a schedule/).nth(3);
    const box = (await column.boundingBox())!;
    // 9:00-10:30, inside the scrolled-into-view part of the grid.
    await page.mouse.move(box.x + box.width / 2, box.y + 9 * 48 + 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 10.5 * 48 - 4, { steps: 6 });
    await page.mouse.up();
    const sheet = page.getByRole('dialog', { name: 'New schedule' });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(350);
    await page.screenshot({ path: 'e2e/__screenshots__/schedule-sheet-desktop-light.png' });
  });

  test('quick add previews the parse', async ({ page }) => {
    await page.goto('/schedule');
    await page
      .getByLabel('Quick add a schedule')
      .fill('mon wed fri 5:30am veggie beds 10 min x3 soak 20');
    await expect(page.getByText('3 cycles with 20 min soak')).toBeVisible();
    await page.screenshot({ path: 'e2e/__screenshots__/schedule-quickadd-desktop-light.png' });
  });

  test('list view shows every schedule', async ({ page }) => {
    await page.goto('/schedule');
    await page.getByRole('tab', { name: /List/ }).click();
    await expect(page.getByText('Front lawn mornings')).toBeVisible();
    await page.screenshot({
      path: 'e2e/__screenshots__/schedule-list-desktop-light.png',
      fullPage: true,
    });
  });

  test('gateway sheet opens from Devices', async ({ page }) => {
    await page.goto('/devices');
    await page
      .getByRole('button', { name: /Set location/ })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(350);
    await page.screenshot({ path: 'e2e/__screenshots__/devices-gateway-sheet-desktop-light.png' });
  });
});

test.describe('analytics', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('charts render against the weather and the range can change', async ({ page }) => {
    await page.goto('/analytics');
    await expect(page.getByText('Water used vs. rain and ET₀')).toBeVisible();
    // Recharts draws real SVG: water and rain bars plus the ET0 line.
    await expect(page.locator('.recharts-bar-rectangle').first()).toBeVisible();
    await expect(page.locator('.recharts-line-curve').first()).toBeVisible();
    await expect(page.getByText('Weather data by Open-Meteo.com (CC BY 4.0)')).toBeVisible();
    await page.getByRole('radio', { name: '1y' }).click();
    await expect(page.getByText('Calendar')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    await page.screenshot({
      path: 'e2e/__screenshots__/analytics-1y-desktop-light.png',
      fullPage: true,
    });
  });

  test('Home shows the forecast strip', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Weather data by Open-Meteo.com (CC BY 4.0)')).toBeVisible();
  });
});
