import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseTikdownloaderJson, parseTikTokAppJson, parseTikTokEmbedHtml, parseTikTokHtml, TikTokParseError } from '../src/parser.ts';

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

test('embed/v2のFrontity JSONからロゴなし動画を解析する', () => {
  const state = {
    source: {
      data: {
        '/embed/v2/7705538318078938376': {
          videoData: {
            itemInfos: {
              id: '7705538318078938376',
              text: 'public test video',
              covers: ['https://p16-common-sign.tiktokcdn.com/cover.jpeg'],
              video: {
                urls: ['https://v45.tiktokcdn.com/video/test.mp4']
              }
            },
            authorInfos: {
              nickname: 'Public User',
              uniqueId: 'public_user'
            }
          }
        }
      }
    }
  };
  const html = `<script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify(state)}</script>`;
  const item = parseTikTokEmbedHtml(html);

  assert.equal(item.id, '7705538318078938376');
  assert.equal(item.author.uniqueId, 'public_user');
  assert.equal(item.desc, 'public test video');
  assert.equal(item.media.play, 'https://v45.tiktokcdn.com/video/test.mp4');
  assert.equal(item.media.download, undefined);
});

test('embed/v2のFrontity JSONが無いHTMLを成功扱いしない', () => {
  assert.throws(
    () => parseTikTokEmbedHtml('<html><body>blocked</body></html>'),
    (error) => error instanceof TikTokParseError && error.code === 'PARSE_FAILED'
  );
});

test('アプリAPIのaweme_detailsからロゴなしplay_addrを解析する', () => {
  const item = parseTikTokAppJson({
    aweme_details: [{
      aweme_id: '7678161526284602644',
      desc: '#shop',
      author: { nickname: 'Waffles', unique_id: 'waffleskkw' },
      video: {
        play_addr: { url_list: ['https://v16-webapp-prime.tiktok.com/play.mp4'] },
        download_addr: { url_list: ['https://v16-webapp-prime.tiktok.com/download.mp4'] },
        cover: { url_list: ['https://p16-common-sign.tiktokcdn.com/cover.jpeg'] }
      },
      music: {
        play_url: { url_list: ['https://sf16-ies-music-va.tiktokcdn.com/music.m4a'] }
      }
    }]
  });

  assert.equal(item.id, '7678161526284602644');
  assert.equal(item.author.uniqueId, 'waffleskkw');
  assert.equal(item.media.play, 'https://v16-webapp-prime.tiktok.com/play.mp4');
  assert.equal(item.media.download, 'https://v16-webapp-prime.tiktok.com/download.mp4');
  assert.equal(item.media.music, 'https://sf16-ies-music-va.tiktokcdn.com/music.m4a');
});

test('tikdownloaderのHTMLからTikTok CDNのロゴなしURLだけを解析する', () => {
  const item = parseTikdownloaderJson({
    status: 'ok',
    data: '<a href="https://dl.snapcdn.app/get?token=test">Download MP4 [1]</a>'
      + '<a href="https://v19.tiktokcdn-us.com/video/play.mp4?a=1233&amp;b=2">Download MP4 [2]</a>'
  }, '7678161526284602644');

  assert.equal(item.id, '7678161526284602644');
  assert.equal(item.media.play, 'https://v19.tiktokcdn-us.com/video/play.mp4?a=1233&b=2');
  assert.equal(item.media.download, undefined);
});

