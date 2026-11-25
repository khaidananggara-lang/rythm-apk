// RYTHM x InnerTube proxy - Cloudflare Worker
// Endpoint yang dipakai sama dengan klien YouTube Music (WEB_REMIX), seperti InnerTune.

const CTX = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250310.01.00', hl: 'id', gl: 'ID' } };
const HEAD = { 'content-type': 'application/json;charset=utf-8', 'access-control-allow-origin': '*' };

// parameter filter hasil pencarian YouTube Music
const FILTERS = {
  song: 'EgWKAQIIAWoKEAkQBRAKEAMQBA==',
  video: 'EgWKAQIQAWoKEAkQChAFEAMQBA==',
  album: 'EgWKAQIYAWoKEAkQChAFEAMQBA==',
  artist: 'EgWKAQIgAWoKEAkQChAFEAMQBA==',
};

const text = runs => (runs || []).map(r => r.text).join('');

// ganti ukuran thumbnail ke 360px
function pic(list) {
  const u = list && list.length ? list[list.length - 1].url : '';
  return u.replace(/=w\d+-h\d+[^"]*$/, '=w360-h360-l90-rj');
}

async function yt(path, body) {
  const r = await fetch('https://music.youtube.com/youtubei/v1/' + path + '?prettyPrint=false', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://music.youtube.com',
      referer: 'https://music.youtube.com/',
      'x-origin': 'https://music.youtube.com',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    },
    body: JSON.stringify({ context: CTX, ...body }),
  });
  if (!r.ok) throw new Error('InnerTube ' + r.status);
  return r.json();
}

/* ---------- audio langsung (pengganti pemutar iframe) ----------
   Endpoint /player dipanggil sebagai klien native yang memberi URL tanpa signature cipher.
   URL googlevideo terikat ke IP peminta, jadi worker yang mengambil audionya dan
   meneruskannya ke pemutar (/api/stream). Daftar klien diurutkan; yang gagal dilewati.
   PENTING: konstanta VISIONOS di bawah belum terverifikasi. Kalau /api/player?id=... gagal,
   cek tabel klien terbaru di yt-dlp dan sesuaikan di sini. */
const L10N = { hl: 'id', gl: 'ID' };
const PLAYER_CLIENTS = [
  {
    name: 'VISIONOS', id: '101',
    ua: 'com.google.ios.youtube/0.1 (RealityDevice14,1; U; CPU iOS 17_6 like Mac OS X)',
    ctx: { clientName: 'VISIONOS', clientVersion: '0.1', deviceMake: 'Apple', deviceModel: 'RealityDevice14,1', osName: 'visionOS', osVersion: '1.3.21O771', ...L10N },
  },
  {
    name: 'ANDROID_VR', id: '28',
    ua: 'com.google.android.apps.youtube.vr.oculus/1.58.0 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    ctx: { clientName: 'ANDROID_VR', clientVersion: '1.58.0', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L', ...L10N },
  },
];
const CHUNK = 1000000;            // googlevideo membatasi satu permintaan sekitar 1 MiB
const urlCache = new Map();       // videoId -> { url, mime, size, ua, name, exp }

function pickAudio(formats) {
  const list = (formats || []).filter(f => f.url && /^audio\//.test(f.mimeType || ''));
  const mp4 = list.filter(f => /^audio\/mp4/.test(f.mimeType)).sort((a, b) => b.bitrate - a.bitrate);
  return mp4[0] || list.sort((a, b) => b.bitrate - a.bitrate)[0];
}

async function resolve(id) {
  const hit = urlCache.get(id);
  if (hit && hit.exp > Date.now()) return hit;
  let err = 'tidak ada format audio';
  for (const c of PLAYER_CLIENTS) {
    try {
      const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': c.ua,
          'x-youtube-client-name': c.id,
          'x-youtube-client-version': c.ctx.clientVersion,
        },
        body: JSON.stringify({ context: { client: c.ctx }, videoId: id, contentCheckOk: true, racyCheckOk: true }),
      });
      if (!r.ok) { err = c.name + ' ' + r.status; continue; }
      const j = await r.json();
      const st = j.playabilityStatus;
      if (st && st.status && st.status !== 'OK') { err = c.name + ': ' + (st.reason || st.status); continue; }
      const f = pickAudio(j.streamingData?.adaptiveFormats);
      if (!f) { err = c.name + ': tanpa URL audio langsung'; continue; }
      if (urlCache.size > 200) urlCache.clear();
      const v = { url: f.url, mime: f.mimeType.split(';')[0], size: +f.contentLength || 0, ua: c.ua, name: c.name, exp: Date.now() + 30 * 60e3 };
      urlCache.set(id, v);
      return v;
    } catch (e) { err = c.name + ': ' + e.message; }
  }
  throw new Error(err);
}

// teruskan audio ke pemutar, dengan dukungan Range (seek) per potongan ~1 MiB
async function stream(req, id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await resolve(id);
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
    let start = m && m[1] ? +m[1] : 0;
    let end = m && m[2] ? +m[2] : Infinity;
    if (m && !m[1] && m[2] && s.size) { start = Math.max(0, s.size - +m[2]); end = s.size - 1; }
    end = Math.min(end, start + CHUNK - 1);
    if (s.size) end = Math.min(end, s.size - 1);
    const up = await fetch(s.url, { headers: { range: `bytes=${start}-${end}`, 'user-agent': s.ua } });
    if (up.status === 403 || up.status === 410) { urlCache.delete(id); continue; }
    if (!up.ok) throw new Error('googlevideo ' + up.status);
    const h = new Headers({ 'access-control-allow-origin': '*', 'accept-ranges': 'bytes', 'content-type': s.mime, 'cache-control': 'private, max-age=3600' });
    for (const k of ['content-length', 'content-range']) if (up.headers.get(k)) h.set(k, up.headers.get(k));
    return new Response(up.body, { status: up.status, headers: h });
  }
  throw new Error('URL audio ditolak (403)');
}

function walk(o, fn) {
  if (Array.isArray(o)) o.forEach(x => walk(x, fn));
  else if (o && typeof o === 'object') {
    fn(o);
    for (const k in o) walk(o[k], fn);
  }
}

// satu item (lagu / album / playlist / artis) dari renderer manapun
function item(n) {
  if (n.musicTwoRowItemRenderer) {
    const x = n.musicTwoRowItemRenderer, nav = x.navigationEndpoint || {};
    return {
      id: nav.watchEndpoint?.videoId,
      bid: nav.browseEndpoint?.browseId,
      title: text(x.title?.runs),
      sub: text(x.subtitle?.runs),
      img: pic(x.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails),
    };
  }
  const x = n.musicResponsiveListItemRenderer;
  if (!x) return null;
  const cols = x.flexColumns || [];
  const col = i => text(cols[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
  const id = x.playlistItemData?.videoId
    || x.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  return {
    id,
    bid: id ? undefined : x.navigationEndpoint?.browseEndpoint?.browseId,
    title: col(0),
    sub: col(1),
    img: pic(x.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails),
  };
}

// semua baris daftar (hasil pencarian, isi album, lagu artis)
function listItems(j, onlySongs) {
  const out = [], seen = new Set();
  walk(j, n => {
    if (!n.musicResponsiveListItemRenderer) return;
    const it = item(n);
    const key = it && (it.id || it.bid);
    if (!key || seen.has(key) || (onlySongs && !it.id)) return;
    seen.add(key);
    out.push(it);
  });
  return out;
}

// rak horizontal (beranda, album/single di halaman artis)
function shelves(j) {
  const out = [];
  walk(j, n => {
    const c = n.musicCarouselShelfRenderer;
    if (!c) return;
    const items = (c.contents || []).map(x => item(x)).filter(i => i && (i.id || i.bid));
    if (items.length) out.push({ title: text(c.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs), items });
  });
  return out;
}

// antrean "berikutnya" untuk sebuah lagu
function upNext(j) {
  const out = [], seen = new Set();
  walk(j, n => {
    const p = n.playlistPanelVideoRenderer;
    if (!p || !p.videoId || seen.has(p.videoId)) return;
    seen.add(p.videoId);
    out.push({
      id: p.videoId,
      title: text(p.title?.runs),
      sub: text(p.longBylineText?.runs).split(' • ')[0],
      img: pic(p.thumbnail?.thumbnails),
    });
  });
  return out;
}

function header(j) {
  let h = null;
  walk(j, n => {
    if (h) return;
    const x = n.musicResponsiveHeaderRenderer || n.musicDetailHeaderRenderer || n.musicImmersiveHeaderRenderer;
    if (x) h = x;
  });
  if (!h) return { title: '', sub: '', img: '' };
  const thumbs = h.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
    || h.thumbnail?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails;
  return { title: text(h.title?.runs), sub: text(h.subtitle?.runs), img: pic(thumbs) };
}

async function route(u, q) {
  const id = u.searchParams.get('id') || '';
  switch (u.pathname) {
    case '/api/ping':
      return { ok: 1 };

    case '/api/home':
      return { sections: shelves(await yt('browse', { browseId: 'FEmusic_home' })) };

    case '/api/search': {
      const type = u.searchParams.get('type') || 'song';
      const j = await yt('search', { query: q, params: FILTERS[type] || FILTERS.song });
      return { items: listItems(j, type === 'song' || type === 'video') };
    }

    case '/api/suggest': {
      const j = await yt('music/get_search_suggestions', { input: q }), s = [];
      walk(j, n => {
        const e = n.searchSuggestionRenderer?.navigationEndpoint?.searchEndpoint?.query;
        if (e) s.push(e);
      });
      return { items: s.slice(0, 8) };
    }

    case '/api/browse': {
      if (!id) throw Object.assign(new Error('id kosong'), { status: 400 });
      const j = await yt('browse', { browseId: id });
      return { ...header(j), items: listItems(j, false).filter(i => i.id), sections: shelves(j) };
    }

    case '/api/next': {
      if (!id) throw Object.assign(new Error('id kosong'), { status: 400 });
      const j = await yt('next', { videoId: id, playlistId: 'RDAMVM' + id, isAudioOnly: true });
      return { items: upNext(j).filter(i => i.id !== id) };
    }

    case '/api/player': {   // diagnosis: klien mana yang berhasil, tanpa membocorkan URL
      if (!id) throw Object.assign(new Error('id kosong'), { status: 400 });
      const s = await resolve(id);
      return { client: s.name, mime: s.mime, size: s.size };
    }

    case '/api/lyrics': {
      if (!id) throw Object.assign(new Error('id kosong'), { status: 400 });
      const nx = await yt('next', { videoId: id });
      let bid = '';
      walk(nx, n => {
        const e = n.browseEndpoint;
        if (!bid && e?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS') bid = e.browseId;
      });
      if (!bid) return { text: '' };
      const b = await yt('browse', { browseId: bid });
      let t = '';
      walk(b, n => { if (!t && n.musicDescriptionShelfRenderer) t = text(n.musicDescriptionShelfRenderer.description?.runs); });
      return { text: t };
    }
  }
  return null;
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url), q = u.searchParams.get('q') || '';
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { ...HEAD, 'access-control-allow-headers': '*' } });
    }
    if (!u.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('RYTHM API', { headers: HEAD });
    }
    try {
      if (u.pathname === '/api/stream') {
        const id = u.searchParams.get('id') || '';
        if (!/^[\w-]{11}$/.test(id)) return new Response(JSON.stringify({ error: 'id tidak valid' }), { status: 400, headers: HEAD });
        return await stream(req, id);
      }
      const out = await route(u, q);
      if (!out) return new Response(JSON.stringify({ error: 'tidak ditemukan' }), { status: 404, headers: HEAD });
      const cache = u.pathname === '/api/ping' ? 'no-store' : 'public, max-age=300';
      return new Response(JSON.stringify(out), { headers: { ...HEAD, 'cache-control': cache } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e) }), { status: e.status || 502, headers: HEAD });
    }
  },
};
