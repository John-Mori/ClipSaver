import { parseTikTokHtml, TikTokParseError, type MediaKind, type ParsedItem } from './parser';

interface Env {
  ASSETS: Fetcher;
}

interface ApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

const TIKTOK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MEDIA_KINDS = new Set<MediaKind>(['play', 'download', 'music']);
const CDN_SUFFIXES = [
  '.tiktokcdn.com',
  '.tiktokv.com',
  '.byteoversea.com',
  '.ibytedtos.com',
  '.muscdn.com',
  '.bytecdn.cn'
];

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

async function fetchTikTokPage(input: URL): Promise<{ html: string; finalUrl: URL; status: number }> {
  let current = input;
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await fetch(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': TIKTOK_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

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

async function resolveUrl(input: URL): Promise<{ item: ParsedItem; finalUrl: URL }> {
  const page = await fetchTikTokPage(input);
  if (page.status < 200 || page.status >= 300) throw classifyPageFailure(page.html, page.status);
  try {
    return { item: parseTikTokHtml(page.html), finalUrl: page.finalUrl };
  } catch (error) {
    if (error instanceof TikTokParseError && error.code !== 'PARSE_FAILED') throw error;
    throw classifyPageFailure(page.html, page.status);
  }
}

function fileLinks(item: ParsedItem): Partial<Record<MediaKind, string>> {
  const files: Partial<Record<MediaKind, string>> = {};
  for (const kind of MEDIA_KINDS) {
    if (item.media[kind]) files[kind] = `/api/file?id=${encodeURIComponent(item.id)}&kind=${kind}`;
  }
  return files;
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
    if (range) headers.Range = range;
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

async function handleResolve(request: Request): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_URL', 'JSON本文を読めない', 400);
  }

  const input = validateTikTokUrl(body?.url);
  const { item, finalUrl } = await resolveUrl(input);
  return json({
    ok: true,
    item: {
      id: item.id,
      author: item.author,
      desc: item.desc,
      cover: item.cover,
      sourceUrl: finalUrl.toString()
    },
    files: fileLinks(item)
  });
}

async function handleFile(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  const kind = (url.searchParams.get('kind') || '') as MediaKind;
  if (!/^\d{10,21}$/.test(id) || !MEDIA_KINDS.has(kind)) {
    return apiError('INVALID_URL', 'idまたはkindが不正', 400);
  }

  const canonical = validateTikTokUrl(`https://www.tiktok.com/@_/video/${id}`);
  const { item } = await resolveUrl(canonical);
  const mediaUrl = item.media[kind];
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
  headers.set('Content-Disposition', `attachment; filename="${safeName(item.author.uniqueId || item.author.name)}_${id}.${extension}"`);
  headers.set('Cache-Control', 'private, no-store');
  for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function handleApi(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  const url = new URL(request.url);
  try {
    if (request.method === 'POST' && url.pathname === '/api/resolve') return await handleResolve(request);
    if (request.method === 'GET' && url.pathname === '/api/file') return await handleFile(request);
    return apiError('NOT_FOUND', 'APIが見つからない', 404);
  } catch (error) {
    if (error instanceof TikTokParseError) {
      const status = error.code === 'INVALID_URL' ? 400
        : error.code === 'NOT_FOUND' ? 404
          : error.code === 'PRIVATE_VIDEO' ? 403
            : 502;
      return apiError(error.code, error.message, status);
    }
    return apiError('UPSTREAM_FAILED', error instanceof Error ? error.message : '不明なエラー', 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request);
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;

