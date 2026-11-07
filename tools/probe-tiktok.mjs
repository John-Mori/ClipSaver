const ids = process.argv.slice(2);

if (!ids.length) {
  console.error('usage: node tools/probe-tiktok.mjs <video-id> [...]');
  process.exit(2);
}

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const appUserAgent = 'com.zhiliaoapp.musically/2023501030 (Linux; U; Android 13; en_US; Pixel 7; Build/TD1A.220804.031; Cronet/58.0.2991.0)';

function appQuery(id) {
  const now = Date.now();
  return new URLSearchParams({
    aweme_id: id,
    device_platform: 'android',
    os: 'android',
    ssmix: 'a',
    _rticket: String(now),
    channel: 'googleplay',
    aid: '1233',
    app_name: 'musical_ly',
    version_code: '350103',
    version_name: '35.1.3',
    manifest_version_code: '2023501030',
    update_version_code: '2023501030',
    ab_version: '35.1.3',
    resolution: '1080*2400',
    dpi: '420',
    device_type: 'Pixel 7',
    device_brand: 'Google',
    language: 'en',
    os_api: '29',
    os_version: '13',
    ac: 'wifi',
    current_region: 'US',
    sys_region: 'US',
    app_language: 'en',
    timezone_name: 'America/New_York',
    timezone_offset: '-14400',
    region: 'US',
    ts: String(Math.floor(now / 1000)),
    device_id: '7291234567890123456',
    iid: '7291234567890123456',
    openudid: '0123456789abcdef'
  });
}

function excerpt(value) {
  return value.replace(/\s+/g, ' ').slice(0, 200);
}

async function probe(label, url, init = {}) {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      ...init,
      headers: {
        'User-Agent': userAgent,
        'Accept-Language': 'en-US,en;q=0.9',
        ...(init.headers || {})
      }
    });
    const text = await response.text();
    console.log(JSON.stringify({
      label,
      status: response.status,
      location: response.headers.get('location'),
      contentType: response.headers.get('content-type'),
      length: text.length,
      excerpt: excerpt(text)
    }));
  } catch (error) {
    console.log(JSON.stringify({ label, error: error instanceof Error ? error.message : String(error) }));
  }
}

for (const id of ids) {
  await probe(`page:${id}`, `https://www.tiktok.com/@_/video/${id}`, {
    headers: { Accept: 'text/html,application/xhtml+xml' }
  });
  await probe(`embed-v2:${id}`, `https://www.tiktok.com/embed/v2/${id}`, {
    headers: { Accept: 'text/html,application/xhtml+xml' }
  });
  await probe(`player-v1:${id}`, `https://www.tiktok.com/player/v1/${id}?autoplay=0&loop=0`, {
    headers: { Accept: 'text/html,application/xhtml+xml' }
  });
  await probe(`app-api:${id}`, 'https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/multi/aweme/detail/?aid=0&app_name=musical_ly&device_platform=android&os=android&version_name=35.1.3&version_code=350103&device_type=Pixel%207&device_brand=Google&os_version=13&os_api=29&resolution=1080*2400&dpi=420&language=en&region=US', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': appUserAgent,
      'X-Argus': ''
    },
    body: new URLSearchParams({ aweme_ids: `[${id}]`, request_source: '0' })
  });
  for (const host of [
    'api16-normal-c-useast1a.tiktokv.com',
    'api22-normal-c-alisg.tiktokv.com',
    'api16-normal-useast5.us.tiktokv.com'
  ]) {
    await probe(`app-feed:${host}:${id}`, `https://${host}/aweme/v1/feed/?${appQuery(id)}`, {
      headers: { Accept: 'application/json', 'User-Agent': appUserAgent }
    });
  }
}
