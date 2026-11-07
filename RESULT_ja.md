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
