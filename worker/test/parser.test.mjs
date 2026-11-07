import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseTikTokHtml, TikTokParseError } from '../src/parser.ts';

const fixtureUrl = new URL('../../tests/fixtures/public_video.html', import.meta.url);

test('公開動画ページの埋め込みJSONを解析する', async () => {
  const html = await readFile(fileURLToPath(fixtureUrl), 'utf8');
  const item = parseTikTokHtml(html);

  assert.equal(item.id, '7675708755559959821');
  assert.equal(item.author.uniqueId, 'muffindrama_us');
  assert.match(item.desc, /orange/i);
  assert.match(item.media.play, /^https:\/\/v16-webapp-prime\.us\.tiktok\.com\//);
  assert.match(item.media.download, /^https:\/\/v16-webapp-prime\.us\.tiktok\.com\//);
  assert.match(item.media.music, /^https:\/\/sf16-ies-music-va\.tiktokcdn\.com\//);
});

test('埋め込みJSONが無いHTMLを成功扱いしない', () => {
  assert.throws(
    () => parseTikTokHtml('<html><body>blocked</body></html>'),
    (error) => error instanceof TikTokParseError && error.code === 'PARSE_FAILED'
  );
});

