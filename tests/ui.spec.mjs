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

test('共有メニュー対応の端末では「写真に保存」から動画ファイルを渡す', async ({ page }) => {
  test.skip(liveRun, '共有メニューは偽物で差し替えるためローカルだけ');
  await page.addInitScript(() => {
    window.__shared = [];
    navigator.canShare = (data) => Array.isArray(data?.files) && data.files.length > 0;
    navigator.share = async (data) => {
      window.__shared.push(data.files.map((f) => ({ name: f.name, type: f.type, size: f.size })));
    };
  });
  await page.route('**/api/resolve', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(mockResult)
  }));
  await page.route('**/api/file?*kind=play*', (route) => route.fulfill({
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="muffindrama_us_7675708755559959821.mp4"'
    },
    body: Buffer.alloc(4096, 1)
  }));

  await page.goto('/');
  await page.locator('#video-url').fill(testVideoUrl);
  await page.locator('#resolve-button').click();
  const share = page.getByRole('button', { name: '写真に保存' });
  await expect(share).toBeEnabled();
  await expect(page.getByRole('link', { name: '動画を保存(ロゴなし)' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '音声を保存' })).toHaveCount(1);
  await expect(page.locator('#ios-note')).toContainText('ビデオを保存');
  await share.click();
  const shared = await page.evaluate(() => window.__shared);
  expect(shared).toEqual([[{ name: 'muffindrama_us_7675708755559959821.mp4', type: 'video/mp4', size: 4096 }]]);
});

test('動画の読み込みに失敗したら保存リンクへ切り替える', async ({ page }) => {
  test.skip(liveRun, 'ローカルだけ');
  await page.addInitScript(() => {
    navigator.canShare = () => true;
    navigator.share = async () => {};
  });
  await page.route('**/api/resolve', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(mockResult)
  }));
  await page.route('**/api/file?*kind=play*', (route) => route.fulfill({
    status: 410,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ ok: false, error: { code: 'FILE_EXPIRED' } })
  }));
  await page.goto('/');
  await page.locator('#video-url').fill(testVideoUrl);
  await page.locator('#resolve-button').click();
  await expect(page.getByRole('link', { name: '動画を保存(ロゴなし)' })).toHaveCount(1);
  await expect(page.locator('.share-button')).toHaveCount(0);
  await expect(page.locator('#status')).toContainText('期限が切れた');
});

for (const width of [320, 375, 390, 430, 820, 1280]) {
  test(`見出しは幅${width}pxで1行に収まる`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    const box = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      const range = document.createRange();
      range.selectNodeContents(h1);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      const rect = range.getBoundingClientRect();
      return { text: h1.textContent, lines: lines.size, right: rect.right, vw: document.documentElement.clientWidth, fontSize: parseFloat(getComputedStyle(h1).fontSize) };
    });
    expect(box.text).toBe('TikTokの動画を、手元へ。');
    expect(box.lines).toBe(1);
    expect(box.right).toBeLessThanOrEqual(box.vw - 12);
    console.log(`h1 width=${width} fontSize=${box.fontSize} right=${Math.round(box.right)}`);
  });
}

for (const width of [320, 390, 1280]) {
  test(`貼り付けと取得は幅${width}pxで同じ行に並ぶ`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    const paste = await page.locator('#paste-button').boundingBox();
    const resolveBox = await page.locator('#resolve-button').boundingBox();
    expect(Math.abs(paste.y - resolveBox.y)).toBeLessThan(2);
    expect(resolveBox.x).toBeGreaterThan(paste.x + paste.width);
    expect(resolveBox.x + resolveBox.width).toBeLessThanOrEqual(width);
  });
}
