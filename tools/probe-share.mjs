// 本番で「写真に保存」が本物の動画ファイルを共有メニューへ渡すかを見る(共有メニューだけ偽物)
import { webkit } from '@playwright/test';
const base = process.env.CLIPSAVER_BASE_URL || 'https://clipsaver.trustsignalbot.workers.dev';
const target = process.argv[2] || 'https://vt.tiktok.com/ZSe4FqkKd/';
const shot = process.argv[3];
const browser = await webkit.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
});
await page.addInitScript(() => {
  window.__shared = [];
  navigator.canShare = (d) => Array.isArray(d?.files) && d.files.length > 0;
  navigator.share = async (d) => {
    for (const f of d.files) {
      const head = new Uint8Array(await f.slice(0, 12).arrayBuffer());
      window.__shared.push({ name: f.name, type: f.type, size: f.size, ftyp: String.fromCharCode(...head.slice(4, 8)) });
    }
  };
});
await page.goto(base);
await page.fill('#video-url', target);
await page.click('#resolve-button');
const share = page.getByRole('button', { name: '写真に保存' });
await share.waitFor({ state: 'visible', timeout: 60000 });
await page.waitForFunction(() => !document.querySelector('.share-button')?.disabled, null, { timeout: 60000 });
if (shot) {
  await page.locator('.download-row').scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot });
}
await share.click();
await page.waitForTimeout(500);
console.log(JSON.stringify({ status: await page.textContent('#status'), shared: await page.evaluate(() => window.__shared) }));
await browser.close();
