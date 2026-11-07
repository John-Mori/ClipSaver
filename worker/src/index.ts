import {
  parseTikTokEmbedHtml,
  parseTikTokAppJson,
  parseTikTokHtml,
  parseTikdownloaderJson,
  TikTokParseError,
  type MediaKind,
  type ParsedItem
} from './parser';

interface Env {
  ASSETS: Fetcher;
  PUBLIC_API_FALLBACK?: string;
  FILE_SIGNING_KEY?: string;
  RESOLVE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

interface ApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

const TIKTOK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIKTOK_APP_USER_AGENT = 'com.zhiliaoapp.musically/2023501030 (Linux; U; Android 13; en_US; Pixel 7; Build/TD1A.220804.031; Cronet/58.0.2991.0)';
const MEDIA_KINDS = new Set<MediaKind>(['play', 'music']);
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const CDN_SUFFIXES = [
  '.tiktokcdn.com',
  '.tiktokcdn-us.com',
  '.tiktokcdn-eu.com',
  '.tiktokv.com',
  '.byteoversea.com',
  '.ibytedtos.com',
  '.muscdn.com',
  '.bytecdn.cn'
];

const memoryRateLimits = new Map<string, { bucket: number; count: number }>();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, Content-Range'
};

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders,
      ...extraHeaders
    }
  });
}

function apiError(code: string, message: string, status = 400): Response {
  const body: ApiErrorBody = { ok: false, error: { code, message } };
  return json(body, status);
}

function isTikTokHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'tiktok.com' || host.endsWith('.tiktok.com');
}

function validateTikTokUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new TikTokParseError('INVALID_URL', 'URLが空か長すぎる');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TikTokParseError('INVALID_URL', 'URLの形式が違う');
  }
  if (url.protocol !== 'https:' || !isTikTokHost(url.hostname) || url.username || url.password) {
    throw new TikTokParseError('INVALID_URL', 'TikTokのHTTPS URLだけを受け付ける');
  }
  return url;
}

function randomHeaderValue(length: number): string {
  const letters = 'bcdfghjklmnpqrstvwxz';
  return Array.from({ length }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
}

function browserHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': TIKTOK_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1'
  };
  const randomCount = 2 + Math.floor(Math.random() * 3);
  for (let index = 0; index < randomCount; index += 1) {
    headers[randomHeaderValue(8 + Math.floor(Math.random() * 8))] = randomHeaderValue(16 + Math.floor(Math.random() * 8));
  }
  return headers;
}

function setCookieValues(headers: Headers): string[] {
  const cookieHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof cookieHeaders.getSetCookie === 'function') return cookieHeaders.getSetCookie();
  const combined = headers.get('Set-Cookie');
  return combined ? combined.split(/,(?=[^;,]+=)/) : [];
}

function collectCookies(cookieJar: Map<string, string>, response: Response): void {
  for (const value of setCookieValues(response.headers)) {
    const pair = /^\s*([^=;\s]+)=([^;]*)/.exec(value);
    if (pair) cookieJar.set(pair[1], pair[2]);
  }
}

function cookieHeader(cookieJar: Map<string, string>): string {
  return Array.from(cookieJar, ([name, value]) => `${name}=${value}`).join('; ');
}

async function bootstrapTikTokCookies(headers: Record<string, string>): Promise<Map<string, string>> {
  const cookieJar = new Map<string, string>();
  try {
    const response = await fetch('https://www.tiktok.com/', {
      method: 'GET',
      redirect: 'manual',
      headers
    });
    collectCookies(cookieJar, response);
    await response.body?.cancel();
  } catch {
    // The video and embed routes are still worth trying without bootstrap cookies.
  }
  return cookieJar;
}

async function fetchTikTokPage(input: URL): Promise<{ html: string; finalUrl: URL; status: number }> {
  let current = input;
  const headers = browserHeaders();
  const cookieJar = await bootstrapTikTokCookies(headers);
  for (let hop = 0; hop < 6; hop += 1) {
    const cookies = cookieHeader(cookieJar);
    const response = await fetch(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        ...headers,
        ...(cookies ? { Cookie: cookies } : {})
      }
    });
    collectCookies(cookieJar, response);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      if (!location) throw new TikTokParseError('UPSTREAM_FAILED', 'TikTokの転送先が空');
      const next = new URL(location, current);
      if (next.protocol !== 'https:' || !isTikTokHost(next.hostname)) {
        throw new TikTokParseError('UPSTREAM_FAILED', 'TikTok外の転送先を拒否した');
      }
      current = next;
      continue;
    }

    const html = await response.text();
    return { html, finalUrl: current, status: response.status };
  }
  throw new TikTokParseError('UPSTREAM_FAILED', '短縮URLの転送回数が多すぎる');
}

async function fetchTikTokEmbed(videoId: string): Promise<{ html: string; status: number }> {
  let last = { html: '', status: 503 };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    const response = await fetch(`https://www.tiktok.com/embed/v2/${videoId}`, {
      method: 'GET',
      redirect: 'manual',
      headers: browserHeaders()
    });
    last = { html: await response.text(), status: response.status };
    if (response.status !== 429 && response.status !== 503) return last;
  }
  return last;
}

function randomHex(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').slice(0, length);
}

async function fetchTikTokAppDetail(videoId: string): Promise<{ text: string; status: number }> {
  const query = new URLSearchParams({
    aid: '0',
    app_name: 'musical_ly',
    device_platform: 'android',
    os: 'android',
    version_name: '35.1.3',
    version_code: '350103',
    device_type: 'Pixel 7',
    device_brand: 'Google',
    os_version: '13',
    os_api: '29',
    resolution: '1080*2400',
    dpi: '420',
    language: 'en',
    region: 'US'
  });
  let last = { text: '', status: 503 };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    const response = await fetch(
      `https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/multi/aweme/detail/?${query}`,
      {
        method: 'POST',
        headers: {
          'User-Agent': TIKTOK_APP_USER_AGENT,
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': `odin_tt=${randomHex(160)}`,
          'X-Argus': ''
        },
        body: new URLSearchParams({ aweme_ids: `[${videoId}]`, request_source: '0' })
      }
    );
    last = { text: await response.text(), status: response.status };
    if (last.text || (response.status !== 429 && response.status !== 503)) return last;
  }
  return last;
}

async function fetchTikdownloader(sourceUrl: URL): Promise<{ text: string; status: number }> {
  const response = await fetch('https://tikdownloader.io/api/ajaxSearch', {
    method: 'POST',
    headers: {
      'User-Agent': TIKTOK_USER_AGENT,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': 'https://tikdownloader.io',
      'Referer': 'https://tikdownloader.io/',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: new URLSearchParams({ q: sourceUrl.toString(), lang: 'en' })
  });
  return { text: await response.text(), status: response.status };
}

function responseExcerpt(value: string): string {
  return value.replace(/\s+/g, ' ').slice(0, 200);
}

function logStrategy(name: 'A-page' | 'B-embed-v2' | 'C-app-api' | 'D-tikdownloader', status: number, html: string, ok: boolean): void {
  console.log(JSON.stringify({
    event: 'clipsaver-strategy',
    strategy: name,
    status,
    ok,
    length: html.length,
    excerpt: ok ? undefined : responseExcerpt(html)
  }));
}

function videoIdFromUrl(url: URL): string {
  return /\/(?:video|embed\/v2|player\/v1)\/(\d{10,21})(?:\/|$)/.exec(url.pathname)?.[1] || '';
}

function classifyPageFailure(html: string, status: number): TikTokParseError {
  const lower = html.toLowerCase();
  if (status === 404 || lower.includes('couldn\'t find this video') || lower.includes('video unavailable')) {
    return new TikTokParseError('NOT_FOUND', '動画が見つからない');
  }
  if (lower.includes('private account') || lower.includes('this video is private')) {
    return new TikTokParseError('PRIVATE_VIDEO', '非公開動画は取得できない');
  }
  if (status === 403 || status === 429 || lower.includes('captcha') || lower.includes('verify to continue') || html.length < 3000) {
    return new TikTokParseError('TIKTOK_BLOCKED', `TikTokが取得を拒否した(status=${status})`);
  }
  return new TikTokParseError('PARSE_FAILED', 'TikTokのページ形式を解析できない');
}

async function resolveUrl(input: URL, env: Env): Promise<{ item: ParsedItem; finalUrl: URL; strategy: 'A-page' | 'C-app-api' | 'D-tikdownloader' }> {
  const page = await fetchTikTokPage(input);
  if (page.status >= 200 && page.status < 300) {
    try {
      const item = parseTikTokHtml(page.html);
      const reachable = item.media.play ? await mediaIsReachable(item.media.play) : false;
      logStrategy('A-page', page.status, page.html, reachable);
      if (reachable) return { item, finalUrl: page.finalUrl, strategy: 'A-page' };
    } catch (error) {
      if (error instanceof TikTokParseError && error.code !== 'PARSE_FAILED') throw error;
    }
  }
  logStrategy('A-page', page.status, page.html, false);

  const videoId = videoIdFromUrl(page.finalUrl) || videoIdFromUrl(input);
  if (!videoId) throw classifyPageFailure(page.html, page.status);

  let embedItem: ParsedItem | null = null;
  const embed = await fetchTikTokEmbed(videoId);
  if (embed.status >= 200 && embed.status < 300) {
    try {
      embedItem = parseTikTokEmbedHtml(embed.html);
      logStrategy('B-embed-v2', embed.status, embed.html, true);
    } catch {
      logStrategy('B-embed-v2', embed.status, embed.html, false);
    }
  } else {
    logStrategy('B-embed-v2', embed.status, embed.html, false);
  }

  const app = await fetchTikTokAppDetail(videoId);
  if (app.status >= 200 && app.status < 300 && app.text) {
    try {
      const item = parseTikTokAppJson(JSON.parse(app.text));
      const reachable = item.media.play ? await mediaIsReachable(item.media.play) : false;
      logStrategy('C-app-api', app.status, app.text, reachable);
      if (reachable) return { item, finalUrl: page.finalUrl, strategy: 'C-app-api' };
    } catch {
      logStrategy('C-app-api', app.status, app.text, false);
    }
  } else {
    logStrategy('C-app-api', app.status, app.text, false);
  }

  if (env.PUBLIC_API_FALLBACK !== 'tikdownloader') {
    throw new TikTokParseError('TIKTOK_BLOCKED', `TikTokの直接経路でロゴなし動画を取得できない(status=${app.status})`);
  }

  const fallback = await fetchTikdownloader(new URL(`https://www.tiktok.com/@_/video/${videoId}`));
  if (fallback.status < 200 || fallback.status >= 300 || !fallback.text) {
    logStrategy('D-tikdownloader', fallback.status, fallback.text, false);
    throw new TikTokParseError('UPSTREAM_FAILED', `tikdownloaderが取得を拒否した(status=${fallback.status})`);
  }
  try {
    const item = parseTikdownloaderJson(JSON.parse(fallback.text), videoId);
    if (embedItem) {
      item.author = embedItem.author;
      item.desc = embedItem.desc;
      item.cover = embedItem.cover;
    }
    const reachable = item.media.play ? await mediaIsReachable(item.media.play) : false;
    logStrategy('D-tikdownloader', fallback.status, fallback.text, reachable);
    if (!reachable) throw new TikTokParseError('UPSTREAM_FAILED', 'tikdownloaderの動画URLをTikTok CDNから取得できない');
    return { item, finalUrl: page.finalUrl, strategy: 'D-tikdownloader' };
  } catch (error) {
    logStrategy('D-tikdownloader', fallback.status, fallback.text, false);
    if (error instanceof TikTokParseError) throw error;
    throw new TikTokParseError('PARSE_FAILED', 'tikdownloaderのJSONを解析できない');
  }
}

const SIGNED_LINK_TTL_SECONDS = 1800;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

async function signPayload(key: string, payload: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(payload));
  return base64Url(new Uint8Array(signature));
}

// 取得時に得たCDNのURLを署名付きでリンクへ載せる。保存時にTikTokへ取り直しに行かない(workers.devではCache APIが効かないため)。
async function fileLinks(item: ParsedItem, env: Env): Promise<Partial<Record<MediaKind, string>>> {
  const files: Partial<Record<MediaKind, string>> = {};
  const expires = Math.floor(Date.now() / 1000) + SIGNED_LINK_TTL_SECONDS;
  const author = item.author.uniqueId || item.author.name || '';
  for (const kind of MEDIA_KINDS) {
    const mediaUrl = item.media[kind];
    if (!mediaUrl) continue;
    const params = new URLSearchParams({ id: item.id, kind });
    if (env.FILE_SIGNING_KEY) {
      const u = base64Url(new TextEncoder().encode(mediaUrl));
      const a = base64Url(new TextEncoder().encode(author));
      params.set('u', u);
      params.set('a', a);
      params.set('exp', String(expires));
      params.set('sig', await signPayload(env.FILE_SIGNING_KEY, `${item.id}|${kind}|${u}|${a}|${expires}`));
    }
    files[kind] = `/api/file?${params.toString()}`;
  }
  return files;
}

async function signedFileTarget(url: URL, env: Env, id: string, kind: MediaKind): Promise<{ mediaUrl: string; author: string } | null> {
  const u = url.searchParams.get('u');
  const a = url.searchParams.get('a') ?? '';
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  if (!env.FILE_SIGNING_KEY || !u || !exp || !sig) return null;
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) {
    throw new TikTokParseError('FILE_EXPIRED', '保存URLの期限が切れた');
  }
  const expected = await signPayload(env.FILE_SIGNING_KEY, `${id}|${kind}|${u}|${a}|${exp}`);
  if (expected !== sig) throw new TikTokParseError('INVALID_URL', '保存URLの署名が合わない');
  return { mediaUrl: fromBase64Url(u), author: fromBase64Url(a) };
}

function safeName(value: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 60);
  return cleaned || 'tiktok';
}

function isAllowedCdnHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (CDN_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return /^(?:v\d+|v\d+-webapp|api\d*-normal)[a-z0-9.-]*\.tiktok\.com$/.test(host);
}

async function fetchAllowedMedia(rawUrl: string, request: Request): Promise<Response> {
  let current = new URL(rawUrl);
  for (let hop = 0; hop < 5; hop += 1) {
    if (current.protocol !== 'https:' || !isAllowedCdnHost(current.hostname) || current.username || current.password) {
      throw new TikTokParseError('CDN_NOT_ALLOWED', '許可されていない中継先を拒否した');
    }
    const headers: Record<string, string> = {
      'User-Agent': TIKTOK_USER_AGENT,
      'Referer': 'https://www.tiktok.com/'
    };
    const range = request.headers.get('Range');
    headers.Range = range || 'bytes=0-';
    const response = await fetch(current.toString(), { redirect: 'manual', headers });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      if (!location) throw new TikTokParseError('UPSTREAM_FAILED', 'CDNの転送先が空');
      current = new URL(location, current);
      continue;
    }
    return response;
  }
  throw new TikTokParseError('UPSTREAM_FAILED', 'CDNの転送回数が多すぎる');
}

async function mediaIsReachable(rawUrl: string): Promise<boolean> {
  try {
    const response = await fetchAllowedMedia(rawUrl, new Request('https://clipsaver.invalid/probe', {
      headers: { Range: 'bytes=0-0' }
    }));
    const ok = response.ok || response.status === 206;
    console.log(JSON.stringify({ event: 'clipsaver-media-probe', status: response.status, ok }));
    await response.body?.cancel();
    return ok;
  } catch (error) {
    console.log(JSON.stringify({
      event: 'clipsaver-media-probe',
      status: 0,
      ok: false,
      error: error instanceof TikTokParseError ? error.code : 'UPSTREAM_FAILED'
    }));
    return false;
  }
}

function mediaCacheRequest(request: Request, id: string): Request {
  const origin = new URL(request.url).origin;
  return new Request(`${origin}/.clipsaver-media/${id}`, { method: 'GET' });
}

async function getCachedItem(request: Request, id: string): Promise<ParsedItem | null> {
  const mediaCache = (caches as unknown as { default: Cache }).default;
  const cached = await mediaCache.match(mediaCacheRequest(request, id));
  if (!cached) return null;
  try {
    const item = await cached.json() as ParsedItem;
    return item.id === id ? item : null;
  } catch {
    return null;
  }
}

async function putCachedItem(request: Request, item: ParsedItem): Promise<void> {
  const mediaCache = (caches as unknown as { default: Cache }).default;
  await mediaCache.put(mediaCacheRequest(request, item.id), new Response(JSON.stringify(item), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=600'
    }
  }));
}

async function rateLimitKey(request: Request, bucket: number): Promise<string> {
  const clientIp = request.headers.get('CF-Connecting-IP') || 'local';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientIp));
  const hash = Array.from(new Uint8Array(digest).slice(0, 12), (value) => value.toString(16).padStart(2, '0')).join('');
  const origin = new URL(request.url).origin;
  return `${origin}/.clipsaver-rate/${bucket}/${hash}`;
}

async function enforceRateLimit(request: Request): Promise<Response | null> {
  const bucket = Math.floor(Date.now() / RATE_WINDOW_MS);
  const key = await rateLimitKey(request, bucket);
  const memory = memoryRateLimits.get(key);
  const cacheRequest = new Request(key, { method: 'GET' });
  const rateLimitCache = (caches as unknown as { default: Cache }).default;
  const cached = await rateLimitCache.match(cacheRequest);
  const cachedCount = cached ? Number(await cached.text()) || 0 : 0;
  const count = Math.max(memory?.bucket === bucket ? memory.count : 0, cachedCount);

  if (count >= RATE_LIMIT) {
    return json(
      { ok: false, error: { code: 'RATE_LIMITED', message: '1分あたりの回数上限に達した' } },
      429,
      { 'Retry-After': '60', 'X-RateLimit-Limit': String(RATE_LIMIT), 'X-RateLimit-Remaining': '0' }
    );
  }

  const nextCount = count + 1;
  memoryRateLimits.set(key, { bucket, count: nextCount });
  await rateLimitCache.put(cacheRequest, new Response(String(nextCount), {
    headers: { 'Cache-Control': 'public, max-age=70' }
  }));
  return null;
}

async function handleResolve(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_URL', 'JSON本文を読めない', 400);
  }

  const input = validateTikTokUrl(body?.url);
  const { item, finalUrl, strategy } = await resolveUrl(input, env);
  await putCachedItem(request, item);
  return json({
    ok: true,
    strategy,
    item: {
      id: item.id,
      author: item.author,
      desc: item.desc,
      cover: item.cover,
      sourceUrl: finalUrl.toString()
    },
    files: await fileLinks(item, env)
  });
}

async function handleFile(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  const kind = (url.searchParams.get('kind') || '') as MediaKind;
  if (!/^\d{10,21}$/.test(id) || !MEDIA_KINDS.has(kind)) {
    return apiError('INVALID_URL', 'idまたはkindが不正', 400);
  }

  let mediaUrl: string | undefined;
  let author: string;
  const signed = await signedFileTarget(url, env, id, kind);
  if (signed) {
    mediaUrl = signed.mediaUrl;
    author = signed.author;
  } else {
    let item = await getCachedItem(request, id);
    if (!item) {
      const canonical = validateTikTokUrl(`https://www.tiktok.com/@_/video/${id}`);
      item = (await resolveUrl(canonical, env)).item;
      await putCachedItem(request, item);
    }
    mediaUrl = item.media[kind];
    author = item.author.uniqueId || item.author.name;
  }
  if (!mediaUrl) return apiError('NO_MEDIA', '指定された形式は取得できない', 404);

  const upstream = await fetchAllowedMedia(mediaUrl, request);
  if (!upstream.ok && upstream.status !== 206) {
    return apiError('UPSTREAM_FAILED', `CDN取得失敗(status=${upstream.status})`, 502);
  }

  const contentType = upstream.headers.get('Content-Type') || (kind === 'music' ? 'audio/mp4' : 'video/mp4');
  const extension = kind === 'music'
    ? (contentType.includes('mpeg') ? 'mp3' : 'm4a')
    : 'mp4';
  const headers = new Headers(corsHeaders);
  headers.set('Content-Type', contentType);
  headers.set('Content-Disposition', `attachment; filename="${safeName(author)}_${id}.${extension}"`);
  headers.set('Cache-Control', 'private, no-store');
  const clientRange = request.headers.get('Range');
  for (const name of ['Content-Length', 'Accept-Ranges', 'ETag']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (clientRange) {
    const contentRange = upstream.headers.get('Content-Range');
    if (contentRange) headers.set('Content-Range', contentRange);
  }
  return new Response(upstream.body, { status: clientRange ? upstream.status : 200, headers });
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  const url = new URL(request.url);
  try {
    const limited = await enforceRateLimit(request);
    if (limited) return limited;
    // workers.devではCache APIが効かず上のメモリ判定はisolate単位なので、取得はCloudflareのRate Limitingでも数える。
    if (request.method === 'POST' && url.pathname === '/api/resolve' && env.RESOLVE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.RESOLVE_LIMITER.limit({ key: ip });
      if (!success) return json({ ok: false, error: { code: 'RATE_LIMITED', message: '1分あたりの回数上限に達した' } }, 429);
    }
    if (request.method === 'POST' && url.pathname === '/api/resolve') return await handleResolve(request, env);
    if (request.method === 'GET' && url.pathname === '/api/file') return await handleFile(request, env);
    return apiError('NOT_FOUND', 'APIが見つからない', 404);
  } catch (error) {
    if (error instanceof TikTokParseError) {
      const status = error.code === 'INVALID_URL' ? 400
        : error.code === 'NOT_FOUND' ? 404
          : error.code === 'PRIVATE_VIDEO' ? 403
            : error.code === 'FILE_EXPIRED' ? 410
            : 502;
      return apiError(error.code, error.message, status);
    }
    return apiError('UPSTREAM_FAILED', error instanceof Error ? error.message : '不明なエラー', 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;

