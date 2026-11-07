# ClipSaver

TikTokの公開動画URLを解析し、取得できた形式だけを保存ボタンとして出す小さなWebアプリです。画面は`web/index.html`だけで動き、ビルドや外部CDNを必要としません。

自分が撮った動画・許諾を得た動画の保存用です。他人の動画の再配布は権利者の許可が要ります。

## ローカル版

必要なものはPython 3.11以降、yt-dlp、ffmpegです。TikTokは取得方式を頻繁に変えるため、yt-dlpは新しい版を使ってください。

```powershell
python local/server.py
```

起動後に`http://127.0.0.1:8790/`を開きます。ローカル版は`127.0.0.1`だけで待ち受け、`yt-dlp`で動画情報を抽出します。音声保存は要求時にyt-dlpとffmpegでMP3を作ります。

別のyt-dlp実行ファイルを使う場合だけ、`CLIPSAVER_YTDLP`にパスを設定できます。

```powershell
$env:CLIPSAVER_YTDLP = 'D:\tools\yt-dlp.exe'
python local/server.py
```

## Worker版

```powershell
cd worker
npm install
npx wrangler dev
```

Worker版はTikTok動画ページの埋め込みJSONを直接解析します。短縮URLを最大5回までTikTokドメイン内で展開します。`/api/file`はクライアントから生のCDN URLを受け取らず、動画IDからページを再解決します。中継先もTikTok系CDNの許可リストに限定しています。

TikTokがCloudflareの接続元を遮断した場合、`TIKTOK_BLOCKED`を返します。これは画面にも理由として表示されます。

静的画面はWorkers Static Assetsで同じWorkerから配ります。Pagesへ別置きする場合もAPIはCORS対応です。画面側のAPI接続先は`web/index.html`の次の1か所で切り替えます。

```html
<meta name="api-base" content="/api">
```

別オリジンなら`content="https://example.workers.dev/api"`、ローカルAPIを直接向けるなら`content="http://127.0.0.1:8790/api"`にします。

## API

### `POST /api/resolve`

```json
{"url":"https://www.tiktok.com/@user/video/1234567890123456789"}
```

成功時は投稿者、説明文、サムネイル、取得できた`play`、`music`だけを返します。失敗時は`error.code`と理由を返します。

### `GET /api/file?id=...&kind=play|music`

保存用レスポンスを返します。Worker版はTikTokページを再解決してから許可済みCDNへ接続します。ローカル版は直前の`resolve`結果を15分だけメモリに保持します。

## 検査

```powershell
npm install
npm --prefix worker install
npm test
npm run typecheck
npx playwright install chromium webkit
npm run test:ui
```

パーサ試験のHTMLは`tests/fixtures/public_video.html`です。公開動画ページから解析対象を縮約し、期限付きCDN URLの署名値だけを試験用文字列に置き換えています。PlaywrightはChromiumの1280x900とWebKitの390x844で、取得結果、JSエラー、横はみ出しを確認し、`_shots/`へ画像を保存します。

## 公開

このrepoは公開先を固定していません。GitHubへのpush、GitHub repo作成、Cloudflareへのデプロイは別途行ってください。`worker/wrangler.toml`のWorker名は`clipsaver`です。
