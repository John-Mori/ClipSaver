import { chromium } from '@playwright/test';

const id = process.argv[2];
if (!/^\d{10,21}$/.test(id || '')) {
  console.error('usage: node tools/probe-player.mjs <video-id>');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('request', (request) => {
  if (!request.url().includes('/player/api/v1/items')) return;
  const headers = request.headers();
  console.log(JSON.stringify({
    event: 'request',
    url: request.url(),
    headers: Object.keys(headers).sort(),
    headerLengths: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, value.length]))
  }));
});
page.on('response', async (response) => {
  if (!response.url().includes('/player/api/v1/items')) return;
  const body = await response.text().catch(() => '');
  console.log(JSON.stringify({
    event: 'response',
    status: response.status(),
    length: body.length,
    excerpt: body.replace(/\s+/g, ' ').slice(0, 200)
  }));
  try {
    const item = JSON.parse(body).items?.[0] || {};
    const urls = [];
    const walk = (value, path = '') => {
      if (typeof value === 'string' && value.startsWith('https://')) {
        urls.push({ path, host: new URL(value).hostname, length: value.length });
      } else if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      } else if (value && typeof value === 'object') {
        Object.entries(value).forEach(([key, entry]) => walk(entry, path ? `${path}.${key}` : key));
      }
    };
    walk(item.video_info || {});
    console.log(JSON.stringify({
      event: 'video-info',
      itemKeys: Object.keys(item).sort(),
      videoInfoKeys: Object.keys(item.video_info || {}).sort(),
      urls
    }));
  } catch {
    // The response summary above is enough when the endpoint does not return JSON.
  }
});

await page.goto(`https://www.tiktok.com/player/v1/${id}?autoplay=0&loop=0`, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForTimeout(2_000);
await browser.close();
