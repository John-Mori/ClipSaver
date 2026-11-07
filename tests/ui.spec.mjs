import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const mockResult = {
  ok: true,
  item: {
    id: '7675708755559959821',
    author: { name: 'Muffin Drama', uniqueId: 'muffindrama_us' },
    desc: 'The orange girl twist - see the banana reveal and the red pulp twist',
    cover: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="720" height="960"%3E%3Crect width="720" height="960" fill="%23f3d4bc"/%3E%3Ccircle cx="360" cy="430" r="190" fill="%23fb6a19"/%3E%3C/svg%3E'
  },
  files: {
    play: '/api/file?id=7675708755559959821&kind=play',
    download: '/api/file?id=7675708755559959821&kind=download',
    music: '/api/file?id=7675708755559959821&kind=music'
  }
};

const liveRun = Boolean(process.env.CLIPSAVER_BASE_URL);
const testVideoUrl = process.env.CLIPSAVER_TEST_URL
  || 'https://www.tiktok.com/@muffindrama_us/video/7675708755559959821';

test('URL貼付から保存ボタン表示まで横にはみ出さない', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  if (!liveRun) {
    await page.route('**/api/resolve', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(mockResult)
      });
    });
  }

  await page.goto('/');
  await page.locator('#video-url').fill(testVideoUrl);
  await page.locator('#resolve-button').click();

  await expect(page.locator('#result')).toBeVisible();
  if (liveRun) {
    await expect(page.locator('.save-link').first()).toBeVisible();
    await expect(page.getByRole('link', { name: '動画を保存(ロゴなし)' })).toHaveCount(1);
  } else {
    await expect(page.locator('.save-link')).toHaveCount(2);
    await expect(page.getByRole('link', { name: '動画を保存(ロゴあり)' })).toHaveCount(0);
  }
  await expect(page.locator('#status')).toContainText('取得した');

  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(errors).toEqual([]);

  const shotDir = resolve(process.cwd(), '_shots');
  await mkdir(shotDir, { recursive: true });
  if (testInfo.project.name === 'iphone-webkit') {
    await page.locator('.download-row').scrollIntoViewIfNeeded();
  }
  await page.screenshot({ path: resolve(shotDir, `${testInfo.project.name}.png`), fullPage: false });
});
