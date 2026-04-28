import { expect, test, type Page } from '@playwright/test';

const baseURL = process.env.BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || '3737'}`;
const routeFallbackPattern = /Failed to load (Library|Search|Dashboard|Settings|Artist|Album|Video)|Something went wrong/i;
const routeBoundaryConsolePattern = /PageErrorBoundary|ErrorBoundary caught an error|Rendered more hooks|Failed to load (Library|Search|Dashboard|Settings|Artist|Album|Video)/i;

function watchRouteFailures(page: Page) {
  const pageErrors: Error[] = [];
  const boundaryErrors: string[] = [];

  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (routeBoundaryConsolePattern.test(text)) {
      boundaryErrors.push(text);
    }
  });

  return {
    expectClean() {
      expect(pageErrors.map((error) => error.message)).toEqual([]);
      expect(boundaryErrors).toEqual([]);
    },
  };
}

async function expectNoRouteFallback(page: Page) {
  await expect(page.getByText(routeFallbackPattern)).toHaveCount(0);
}

async function expectLibraryRoot(page: Page) {
  await expect(page.locator('main')).toContainText(/Artists|Albums|Tracks|Videos|Your library is empty/i);
}

test.describe('App shell & navigation', () => {
  test('renders main layout with nav and search', async ({ page }) => {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth$/);

    // Layout should have nav with logo, search, and action buttons
    await expect(page.locator('nav')).toBeVisible();
    await expect(page.getByText(/mock provider auth mode|disconnected local-library mode/i).first()).toBeVisible();
    const searchBox = page.getByRole('searchbox', { name: /search/i });
    await expect(searchBox).toBeVisible();

    // Settings button should be accessible
    const settingsBtn = page.getByRole('button', { name: /settings/i }).first();
    await expect(settingsBtn).toBeVisible();

    // Dashboard button should be accessible
    const dashboardBtn = page.getByRole('button', { name: /dashboard/i }).first();
    await expect(dashboardBtn).toBeVisible();

    // Library button should be accessible in desktop nav
    const libraryBtn = page.getByRole('button', { name: /library/i }).first();
    await expect(libraryBtn).toBeVisible();
  });

  test('navigates to dashboard page', async ({ page }) => {
    const failures = watchRouteFailures(page);

    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth$/);

    const dashboardBtn = page.getByRole('button', { name: /dashboard/i }).first();
    await dashboardBtn.click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('main').getByText('Dashboard', { exact: true })).toBeVisible();
    await expectNoRouteFallback(page);
    failures.expectClean();
  });

  test('navigates to settings page', async ({ page }) => {
    const failures = watchRouteFailures(page);

    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth$/);

    const settingsBtn = page.getByRole('button', { name: /settings/i }).first();
    await settingsBtn.click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByRole('main').getByText('Settings', { exact: true })).toBeVisible();
    await expectNoRouteFallback(page);
    failures.expectClean();
  });

  test('logo click navigates back to library (root)', async ({ page }) => {
    const failures = watchRouteFailures(page);

    await page.goto(`${baseURL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth$/);

    // Click logo to go home
    const logo = page.locator('nav img[alt="Discogenius"]');
    await logo.click();
    await expect(page).toHaveURL(`${baseURL}/`);
    await expectLibraryRoot(page);
    await expectNoRouteFallback(page);
    failures.expectClean();
  });

  test('top-level app routes render content instead of error fallbacks', async ({ page }) => {
    const failures = watchRouteFailures(page);
    const routes: Array<{ path: string; text: string | RegExp }> = [
      { path: '/', text: /Artists|Albums|Tracks|Videos|Your library is empty/i },
      { path: '/dashboard', text: 'Dashboard' },
      { path: '/settings', text: 'Settings' },
      { path: '/search', text: 'Search' },
    ];

    for (const route of routes) {
      await page.goto(`${baseURL}${route.path}`, { waitUntil: 'domcontentloaded' });
      await expect(page).not.toHaveURL(/\/auth$/);
      await expect(page.locator('main')).toContainText(route.text);
      await expectNoRouteFallback(page);
    }

    failures.expectClean();
  });

  test('404 page shown for unknown routes', async ({ page }) => {
    await page.goto(`${baseURL}/nonexistent-route-12345`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/auth$/);

    // Should show some kind of not-found content
    await expect(page.locator('body')).toContainText(/not found|404|page/i);
  });
});
