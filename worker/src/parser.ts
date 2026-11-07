export type MediaKind = 'play' | 'download' | 'music';

export interface ParsedItem {
  id: string;
  author: {
    name: string;
    uniqueId: string;
  };
  desc: string;
  cover: string;
  media: Partial<Record<MediaKind, string>>;
  isPhotoPost: boolean;
}

export class TikTokParseError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TikTokParseError';
    this.code = code;
  }
}

const SCRIPT_IDS = [
  '__UNIVERSAL_DATA_FOR_REHYDRATION__',
  'SIGI_STATE',
  '__NEXT_DATA__'
];

const EMBED_SCRIPT_ID = '__FRONTITY_CONNECT_STATE__';

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

export function extractEmbeddedJson(html: string): Array<{ id: string; data: unknown }> {
  const results: Array<{ id: string; data: unknown }> = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptPattern.exec(html)) !== null) {
    const attributes = match[1];
    const idMatch = /\bid\s*=\s*["']([^"']+)["']/i.exec(attributes);
    if (!idMatch || !SCRIPT_IDS.includes(idMatch[1])) continue;
    try {
      results.push({ id: idMatch[1], data: JSON.parse(decodeHtml(match[2].trim())) });
    } catch {
      // TikTok sometimes leaves an empty or non-JSON script beside the real payload.
    }
  }

  return results;
}

function extractScriptJson(html: string, scriptId: string): unknown {
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    const idMatch = /\bid\s*=\s*["']([^"']+)["']/i.exec(match[1]);
    if (idMatch?.[1] !== scriptId) continue;
    try {
      return JSON.parse(decodeHtml(match[2].trim()));
    } catch {
      throw new TikTokParseError('PARSE_FAILED', `${scriptId}をJSONとして読めない`);
    }
  }
  throw new TikTokParseError('PARSE_FAILED', `${scriptId}が見つからない`);
}

function firstUrl(value: unknown): string {
  if (typeof value === 'string' && /^https:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = firstUrl(entry);
      if (candidate) return candidate;
    }
    return '';
  }

  const record = asRecord(value);
  if (!record) return '';
  for (const key of ['urlList', 'UrlList', 'url_list', 'url', 'Url', 'src']) {
    const candidate = firstUrl(record[key]);
    if (candidate) return candidate;
  }
  return '';
}

function looksLikeItem(value: unknown): value is Record<string, any> {
  const record = asRecord(value);
  if (!record) return false;
  const id = record.id ?? record.itemId ?? record.aweme_id;
  return Boolean(id && (record.video || record.music || record.author || record.desc || record.imagePost));
}

function findItem(root: unknown): Record<string, any> | null {
  const record = asRecord(root);
  if (!record) return null;

  const scope = asRecord(record.__DEFAULT_SCOPE__) || record;
  const known = [
    scope['webapp.video-detail']?.itemInfo?.itemStruct,
    scope['webapp.video-detail']?.itemInfo,
    record.props?.pageProps?.itemInfo?.itemStruct,
    record.itemInfo?.itemStruct
  ];
  for (const candidate of known) {
    if (looksLikeItem(candidate)) return candidate;
  }

  const itemModule = asRecord(record.ItemModule) || asRecord(scope.ItemModule);
  if (itemModule) {
    for (const candidate of Object.values(itemModule)) {
      if (looksLikeItem(candidate)) return candidate;
    }
  }

  const queue: unknown[] = [root];
  let visited = 0;
  while (queue.length && visited < 12000) {
    const value = queue.shift();
    visited += 1;
    if (looksLikeItem(value)) return value;
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    const childRecord = asRecord(value);
    if (childRecord) queue.push(...Object.values(childRecord));
  }
  return null;
}

function findRecord(
  root: unknown,
  predicate: (value: Record<string, any>) => boolean
): Record<string, any> | null {
  const queue: unknown[] = [root];
  let visited = 0;
  while (queue.length && visited < 12000) {
    const value = queue.shift();
    visited += 1;
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    const record = asRecord(value);
    if (!record) continue;
    if (predicate(record)) return record;
    queue.push(...Object.values(record));
  }
  return null;
}

function selectPlay(video: Record<string, any>): string {
  const direct = firstUrl(video.playAddr ?? video.play_addr ?? video.PlayAddr);
  if (direct) return direct;

  const bitrate = video.bitrateInfo ?? video.bit_rate ?? video.bitRate;
  if (Array.isArray(bitrate)) {
    const ranked = [...bitrate].sort((a, b) => Number(b?.Bitrate ?? b?.bitrate ?? 0) - Number(a?.Bitrate ?? a?.bitrate ?? 0));
    for (const entry of ranked) {
      const candidate = firstUrl(entry?.PlayAddr ?? entry?.playAddr ?? entry?.play_addr);
      if (candidate) return candidate;
    }
  }
  return '';
}

function parseItem(item: Record<string, any>): ParsedItem {
  const video = asRecord(item.video) || {};
  const music = asRecord(item.music) || {};
  const author = asRecord(item.author) || {};
  const media: Partial<Record<MediaKind, string>> = {};
  const play = selectPlay(video);
  const download = firstUrl(video.downloadAddr ?? video.download_addr ?? video.DownloadAddr);
  const musicUrl = firstUrl(music.playUrl ?? music.play_url ?? music.playAddr ?? music.play_addr);
  if (play) media.play = play;
  if (download) media.download = download;
  if (musicUrl) media.music = musicUrl;

  const isPhotoPost = Boolean(item.imagePost || item.image_post || item.images?.length) && !play && !download;
  if (isPhotoPost) {
    throw new TikTokParseError('PHOTO_POST_NO_VIDEO', '写真投稿に動画が無い');
  }
  if (!Object.keys(media).length) {
    throw new TikTokParseError('NO_MEDIA', '保存できるメディアURLが無い');
  }

  return {
    id: String(item.id ?? item.itemId ?? item.aweme_id ?? ''),
    author: {
      name: String(author.nickname ?? author.nickName ?? author.uniqueId ?? author.unique_id ?? ''),
      uniqueId: String(author.uniqueId ?? author.unique_id ?? author.secUid ?? '')
    },
    desc: String(item.desc ?? item.description ?? ''),
    cover: firstUrl(video.cover ?? video.dynamicCover ?? video.originCover ?? item.cover),
    media,
    isPhotoPost: false
  };
}

export function parseTikTokHtml(html: string): ParsedItem {
  const payloads = extractEmbeddedJson(html);
  if (!payloads.length) {
    throw new TikTokParseError('PARSE_FAILED', 'TikTokの埋め込みJSONが見つからない');
  }

  let item: Record<string, any> | null = null;
  for (const payload of payloads) {
    item = findItem(payload.data);
    if (item) break;
  }
  if (!item) {
    throw new TikTokParseError('PARSE_FAILED', '埋め込みJSONに動画情報が無い');
  }
  return parseItem(item);
}

export function parseTikTokAppJson(data: unknown): ParsedItem {
  const root = asRecord(data);
  const item = asRecord(root?.aweme_details?.[0]) || findItem(data);
  if (!item) {
    throw new TikTokParseError('PARSE_FAILED', 'アプリAPIに動画情報が無い');
  }
  return parseItem(item);
}

export function parseTikdownloaderJson(data: unknown, videoId: string): ParsedItem {
  const root = asRecord(data);
  if (root?.status !== 'ok' || typeof root.data !== 'string') {
    throw new TikTokParseError('PARSE_FAILED', 'tikdownloaderの応答に動画情報が無い');
  }
  const hrefPattern = /\bhref\s*=\s*["']([^"']+)["']/gi;
  let play = '';
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(root.data)) !== null) {
    const candidate = decodeHtml(match[1]);
    try {
      const host = new URL(candidate).hostname.toLowerCase();
      if (host.endsWith('.tiktokcdn.com') || host.endsWith('.tiktokcdn-us.com') || host.endsWith('.tiktokcdn-eu.com')) {
        play = candidate;
        break;
      }
    } catch {
      // Ignore relative links and third-party proxy URLs.
    }
  }
  if (!play) {
    throw new TikTokParseError('NO_MEDIA', 'tikdownloaderの応答にTikTok CDNのロゴなし動画URLが無い');
  }
  return {
    id: videoId,
    author: { name: '', uniqueId: '' },
    desc: '',
    cover: '',
    media: { play },
    isPhotoPost: false
  };
}

export function parseTikTokEmbedHtml(html: string): ParsedItem {
  const state = extractScriptJson(html, EMBED_SCRIPT_ID);
  const videoData = findRecord(state, (value) => {
    const itemInfos = asRecord(value.itemInfos);
    return Boolean(itemInfos?.id && asRecord(itemInfos.video));
  });
  const item = asRecord(videoData?.itemInfos);
  if (!item) {
    throw new TikTokParseError('PARSE_FAILED', '埋め込みページに動画情報が無い');
  }

  const video = asRecord(item.video) || {};
  const author = findRecord(videoData, (value) => Boolean(value.uniqueId || value.unique_id)) || {};
  const play = firstUrl(video.urls ?? video.urlList ?? video.playAddr);
  if (!play) {
    const isPhotoPost = Boolean(item.images || item.imagePost || item.image_post);
    throw new TikTokParseError(
      isPhotoPost ? 'PHOTO_POST_NO_VIDEO' : 'NO_MEDIA',
      isPhotoPost ? '写真投稿に動画が無い' : '埋め込みページに動画URLが無い'
    );
  }

  return {
    id: String(item.id),
    author: {
      name: String(author.nickname ?? author.nickName ?? author.uniqueId ?? author.unique_id ?? ''),
      uniqueId: String(author.uniqueId ?? author.unique_id ?? '')
    },
    desc: String(item.text ?? item.desc ?? item.description ?? ''),
    cover: firstUrl(item.covers ?? item.coversOrigin ?? item.cover),
    media: { play },
    isPhotoPost: false
  };
}
