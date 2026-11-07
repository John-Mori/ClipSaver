# ClipSaver 検査結果

検査日時: 2026-11-08 JST

## できた物

- `web/index.html`: 単一HTML。URL入力、貼り付け、取得結果、サムネイル、投稿者、説明文、取得できた保存形式だけを表示する。
- `worker/`: Cloudflare Worker(TypeScript)。短縮URL展開、埋め込みJSON解析、動画IDからの再解決、TikTok系CDN許可リスト、Static Assets、CORSを実装した。
- `local/server.py`: Pythonとyt-dlpで動くローカル版。既定は`http://127.0.0.1:8790/`。API形はWorker版と同じ。
- `README.md`: ローカル版、Worker版、API、検査、権利上の注意を書いた。

## 実動画でのローカル版検査

対象URL:

```text
https://www.tiktok.com/@waffleskkw/video/7678161526284602644
```

環境の既定yt-dlp `2026.08.19`で検査した。

- `POST /api/resolve`: HTTP 200
- 取得した形式: `play`、`music`。ロゴあり形式は抽出結果に無かったため表示しない。
- `GET /api/file?id=7678161526284602644&kind=play`: HTTP 200
- 保存サイズ: `451137 bytes`
- ffprobe:

```text
format_name=mov,mp4,m4a,3gp,3g2,mj2
duration=7.081995
video=hevc 1080x1920
audio=aac
size=451137
```

サイズは0より大きく、ffprobeで動画と音声を読めた。

## Worker版の実動画検査

`wrangler 4.158.0`で`npx wrangler dev --port 18792`を起動し、同じ動画を検査した。TikTok側がWranglerの取得を遮断したため、Worker版は実動画を保存できなかった。

`POST /api/resolve`:

```text
HTTP 502
{"ok":false,"error":{"code":"TIKTOK_BLOCKED","message":"TikTokが取得を拒否した(status=200)"}}
```

`GET /api/file?id=7678161526284602644&kind=play`:

```text
HTTP 502
{"ok":false,"error":{"code":"TIKTOK_BLOCKED","message":"TikTokが取得を拒否した(status=200)"}}
```

TikTokのHTTP応答自体は200だったが、本文が動画ページではなく遮断用HTMLだった。アプリ側はこれを成功扱いせず`TIKTOK_BLOCKED`へ分類した。

## 自動検査

- パーサ単体テスト: 2件 PASS
  - 公開動画ページ由来fixtureの埋め込みJSON解析
  - 埋め込みJSONが無いHTMLの拒否
- must-fail確認: `__UNIVERSAL_DATA_FOR_REHYDRATION__`の識別子を意図的に壊した状態で1件 FAILを確認した。復元後は2件 PASS。
- TypeScript: `tsc --noEmit` PASS
- Python: `python -m py_compile local/server.py` PASS
- ボタン幅検査: `OK: ボタンを不当に引き伸ばす指定なし`
- Playwright: 2件 PASS
  - Chromium 1280x900
  - WebKit 390x844(iPhone相当)
  - URL入力、取得、保存ボタン3つ、JSエラー0、横はみ出し0を検査
- 画面画像:
  - `_shots/pc-chromium.png`
  - `_shots/iphone-webkit.png`

## 公開操作

GitHubへのpush、GitHub repo作成、Cloudflareへのデプロイは行っていない。

## Web版(2026-11-08 追記)

本番URL: https://clipsaver.trustsignalbot.workers.dev

### 取得経路ごとの本番での結果

| 経路 | 本番(workers.dev) |
|---|---|
| A. 動画ページ(yt-dlpに寄せたヘッダ・Cookie) | 動画によって通る。`vt.tiktok.com/ZSe4FqkKd` は通った(動画と音声)。`@waffleskkw/video/7678161526284602644` は HTTP 200 の遮断用ページで不可 |
| B. `embed/v2` | 投稿者名・説明文・サムネは取れる。動画アドレスは取れず、Aが落ちた時の補助情報にだけ使う |
| C. アプリAPI(`aweme/v1/multi/aweme/detail`) | 本番では通らなかった(waffleskkw の動画はここも抜けてDまで落ちた) |
| D. 外部の公開API(tikdownloader) | 通る。A〜Cが全部落ちた時だけ使う(`PUBLIC_API_FALLBACK`)。音声は取れない |

### 本番で保存したファイル(ffprobeで確認)

- 短縮URL `https://vt.tiktok.com/ZSe4FqkKd/`(経路A): 動画 3,199,351 bytes・h264 576x1024 + aac・33.1秒 / 音声 530,538 bytes・mp3・33.1秒
- `@waffleskkw/video/7678161526284602644`(経路D): 動画 505,581 bytes・h264 576x1024 + aac・7.1秒
- `@suhvargas02/video/7705538318078938376`(経路D): 動画 7,349,880 bytes・h264 576x1024 + aac・172.2秒

### 変更点

- 「動画を保存(ロゴあり)」はChamiの指示(使わない)で外した。`/api/file` も `kind=play|music` だけを受け付け、`download` は 400。
- 保存リンクに、取得時のCDNアドレスをHMAC署名つきで載せる(30分で期限切れ)。workers.dev では Cache API が効かず、保存のたびに取り直すと経路が変わって音声が404になったため。署名鍵は `wrangler secret` の `FILE_SIGNING_KEY`(repoには無い)。署名を書き換えたリンクは 400。中継先は従来どおりTikTok CDNの許可リストだけ。
- 回数制限: 取得(`/api/resolve`)を Cloudflare の Rate Limiting binding でIPごと1分10回。本番で30回連打して 429 が返ることを確認した。ただしCloudflare側の数え方がおおよそなので、ぴったり11回目からではなく7回目あたりから429が混ざる。

### 画面の検査(本番URL)

`CLIPSAVER_BASE_URL=https://clipsaver.trustsignalbot.workers.dev CLIPSAVER_TEST_URL=https://vt.tiktok.com/ZSe4FqkKd/ npx playwright test` → chromium 1280x900 / webkit 390x844 とも PASS(JSエラー0・横はみ出し0・保存ボタンは2つ)。

### 残る危うさ

- 経路AはTikTok側の判定しだいで、動画によって通ったり通らなかったりする。
- 経路Dは外部サイトに頼っている。止まる・仕様が変わる・規約が変わる可能性がある。外すなら `worker/wrangler.toml` の `PUBLIC_API_FALLBACK` を空にして配備する(その場合、Aで弾かれた動画は取れない)。
