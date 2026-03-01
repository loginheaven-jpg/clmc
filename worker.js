/**
 * 예봄라디오 2.0 — Cloudflare Workers
 *
 * 바인딩 (wrangler.toml):
 *   R2 : RADIO_BUCKET  (coachdb-files)
 *   KV : RADIO_KV
 *   Secret : ADMIN_KEY
 *
 * 기반: prev-radio/worker.js 의 R2/KV 패턴 확장
 */

// ── R2 디렉토리 매핑 ──────────────────────────────────────────
const DIR_MAP = {
  list1:  'radio/channel-list1/',
  list2:  'radio/channel-list2/',
  stream: 'radio/channel-stream/',
};

// ── 캐시 (Workers 인스턴스 수명 동안 유지) ─────────────────────
let febcCache = { data: null, ts: 0 };
let kbsCache  = { data: null, ts: 0 };

export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;

    const cors = corsHeaders(request);

    // OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    try {

      // ── 트랙 목록 (_meta.json 기준) ───────────────────────────
      if (path === '/api/tracks' && request.method === 'GET') {
        const channel = url.searchParams.get('channel') || 'stream';
        const prefix  = DIR_MAP[channel] || DIR_MAP.stream;

        // R2 파일 목록
        const list = await env.RADIO_BUCKET.list({ prefix, limit: 1000 });
        const audioFiles = list.objects.filter(
          obj => /\.(mp3|m4a|ogg|wav|flac|aac)$/i.test(obj.key)
        );

        // _meta.json 읽기
        const metaKey = prefix + '_meta.json';
        const metaObj = await env.RADIO_BUCKET.get(metaKey);
        let meta = null;
        if (metaObj) {
          try { meta = JSON.parse(await metaObj.text()); } catch {}
        }

        let tracks;
        if (meta && Array.isArray(meta)) {
          // meta 기준 정렬, R2에 없는 항목 제거
          const r2Keys = new Set(audioFiles.map(o => o.key));
          tracks = meta
            .filter(m => r2Keys.has(m.key))
            .map((m, i) => ({
              key:   m.key,
              name:  m.name || decodeFileName(m.key.replace(prefix, '')),
              size:  audioFiles.find(o => o.key === m.key)?.size ?? 0,
              order: m.order ?? i,
            }));
        } else {
          // meta 없으면 R2 목록에서 생성
          tracks = audioFiles.map((obj, i) => ({
            key:   obj.key,
            name:  decodeFileName(obj.key.replace(prefix, '')),
            size:  obj.size,
            order: i,
          }));
        }

        return json(tracks, cors);
      }

      // ── 오디오 스트리밍 (Range Request) ────────────────────────
      if (path.startsWith('/api/stream/') && request.method === 'GET') {
        const key = decodeURIComponent(path.slice('/api/stream/'.length));
        const rangeHeader = request.headers.get('Range');

        // First get object head to know total size
        const headObj = await env.RADIO_BUCKET.head(key);
        if (!headObj) return new Response('Not Found', { status: 404, headers: cors });

        const totalSize = headObj.size;
        const ext = key.split('.').pop().toLowerCase();
        const contentTypeMap = {
          mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg',
          wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
        };

        const headers = {
          ...cors,
          'Content-Type': contentTypeMap[ext] || headObj.httpMetadata?.contentType || 'audio/mpeg',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=86400',
        };

        if (rangeHeader) {
          const parsed = parseRange(rangeHeader, totalSize);
          if (parsed) {
            const { offset, length, end } = parsed;
            const r2Range = length !== undefined ? { offset, length } : { offset };
            const object = await env.RADIO_BUCKET.get(key, { range: r2Range });
            const actualEnd = end !== undefined ? end : (totalSize - 1);
            headers['Content-Range'] = `bytes ${offset}-${actualEnd}/${totalSize}`;
            headers['Content-Length'] = String(actualEnd - offset + 1);
            return new Response(object.body, { status: 206, headers });
          }
        }

        const object = await env.RADIO_BUCKET.get(key);
        headers['Content-Length'] = String(totalSize);
        return new Response(object.body, { status: 200, headers });
      }

      // ── 채널5 상태 읽기 (KV) ──────────────────────────────────
      if (path === '/api/ch5/state' && request.method === 'GET') {
        const state = await env.RADIO_KV.get('ch5_state', 'json');
        return json(state || { trackKey: null, paused: true, currentTime: 0 }, cors);
      }

      // ── 채널5 상태 쓰기 (관리자) ──────────────────────────────
      if (path === '/api/ch5/state' && request.method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        const body = await request.json();
        const state = {
          trackKey:   body.trackKey,
          trackName:  body.trackName,
          duration:   body.duration || 0,
          paused:     body.paused ?? false,
          startEpoch: body.paused
            ? (body.startEpoch || Date.now())
            : Date.now() - ((body.currentTime || 0) * 1000),
          currentTime: body.currentTime || 0,
          updatedAt:  Date.now(),
        };
        await env.RADIO_KV.put('ch5_state', JSON.stringify(state));
        return json({ ok: true }, cors);
      }

      // ── 파일 업로드 (관리자) ───────────────────────────────────
      if (path === '/api/upload' && request.method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        const formData = await request.formData();
        const files   = formData.getAll('files');
        const channel = formData.get('channel') || 'stream';
        const name    = formData.get('name') || '';
        const prefix  = DIR_MAP[channel] || DIR_MAP.stream;

        const results = [];
        for (const file of files) {
          if (!file || typeof file === 'string') continue;
          const key = prefix + file.name;
          await env.RADIO_BUCKET.put(key, file.stream(), {
            httpMetadata: { contentType: file.type || 'audio/mpeg' },
          });

          // _meta.json 갱신
          const metaKey = prefix + '_meta.json';
          const metaObj = await env.RADIO_BUCKET.get(metaKey);
          let meta = [];
          if (metaObj) {
            try { meta = JSON.parse(await metaObj.text()); } catch {}
          }
          const trackName = (name || '').toString() || file.name.replace(/\.[^/.]+$/, '');
          const maxOrder  = meta.length > 0 ? Math.max(...meta.map(m => m.order ?? 0)) : -1;
          meta.push({ key, name: trackName, order: maxOrder + 1 });
          await env.RADIO_BUCKET.put(metaKey, JSON.stringify(meta), {
            httpMetadata: { contentType: 'application/json' },
          });

          results.push({ key, name: trackName, size: file.size });
        }

        return json({ ok: true, uploaded: results }, cors);
      }

      // ── 파일 삭제 (관리자) ─────────────────────────────────────
      if (path === '/api/delete' && request.method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        const { key, channel } = await request.json();
        await env.RADIO_BUCKET.delete(key);

        // _meta.json 갱신
        const ch = channel || guessChannel(key);
        const prefix  = DIR_MAP[ch] || DIR_MAP.stream;
        const metaKey = prefix + '_meta.json';
        const metaObj = await env.RADIO_BUCKET.get(metaKey);
        if (metaObj) {
          try {
            let meta = JSON.parse(await metaObj.text());
            meta = meta.filter(m => m.key !== key);
            meta.forEach((m, i) => m.order = i);
            await env.RADIO_BUCKET.put(metaKey, JSON.stringify(meta), {
              httpMetadata: { contentType: 'application/json' },
            });
          } catch {}
        }

        return json({ ok: true }, cors);
      }

      // ── _meta.json 전체 덮어쓰기 (관리자) ─────────────────────
      if (path === '/api/meta' && request.method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        const { channel, tracks } = await request.json();
        const prefix  = DIR_MAP[channel] || DIR_MAP.stream;
        const metaKey = prefix + '_meta.json';
        await env.RADIO_BUCKET.put(metaKey, JSON.stringify(tracks), {
          httpMetadata: { contentType: 'application/json' },
        });
        return json({ ok: true }, cors);
      }

      // ── 극동방송 편성표 프록시 ─────────────────────────────────
      if (path === '/api/febc-schedule' && request.method === 'GET') {
        const data = await getFebcSchedule();
        return json(data, cors);
      }

      // ── KBS 프록시 ─────────────────────────────────────────────
      if (path === '/api/kbs' && request.method === 'GET') {
        const data = await getKbsInfo();
        return json(data, cors);
      }

      // ── HLS 프록시 (CORS 우회) ─────────────────────────────────
      if (path === '/api/hls-proxy' && request.method === 'GET') {
        const target = url.searchParams.get('url');
        if (!target) return new Response('Missing url param', { status: 400, headers: cors });

        let parsed;
        try { parsed = new URL(target); } catch { return new Response('Invalid url', { status: 400, headers: cors }); }

        const allowed = ['gscdn.kbs.co.kr', 'kbs.co.kr', 'febc.net', 'mlive2.febc.net'];
        if (!allowed.some(d => parsed.hostname.endsWith(d))) {
          return new Response('Domain not allowed', { status: 403, headers: cors });
        }

        const resp = await fetch(target, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YebomRadio/2.0)' },
        });

        const proxyHeaders = { ...cors };
        const ct = resp.headers.get('content-type');
        if (ct) proxyHeaders['Content-Type'] = ct;

        return new Response(resp.body, { status: resp.status, headers: proxyHeaders });
      }

      return new Response('Not Found', { status: 404, headers: cors });

    } catch (e) {
      return json({ error: e.message }, cors, 500);
    }
  }
};

// ── 극동방송 편성표 ─────────────────────────────────────────────
async function getFebcSchedule() {
  if (febcCache.data && Date.now() - febcCache.ts < 60000) {
    return febcCache.data;
  }
  try {
    const res = await fetch('https://seoul.febc.net/radio/schedule/live/1', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; YebomRadio/2.0)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(8000),
    });
    const html = await res.text();
    const match = html.match(/<p\s+class="tit">([^<]+)<\/p>/);
    const data = { programTitle: match ? match[1].trim() : null };
    febcCache = { data, ts: Date.now() };
    return data;
  } catch {
    return { programTitle: null };
  }
}

// ── KBS 클래식 FM ───────────────────────────────────────────────
async function getKbsInfo() {
  if (kbsCache.data && Date.now() - kbsCache.ts < 60000) {
    return kbsCache.data;
  }
  try {
    // ① 스트리밍 URL 획득
    const streamRes = await fetch(
      'https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/24',
      { headers: { Referer: 'https://onair.kbs.co.kr/' } }
    );
    const streamData = await streamRes.json();
    const radio = streamData.channel_item?.find(i => i.media_type === 'radio');
    const streamUrl = radio?.service_url
      ?? 'https://1fm.gscdn.kbs.co.kr/1fm_192_2.m3u8';

    // ② 현재 방송명 조회
    const schedRes = await fetch(
      'https://static.api.kbs.co.kr/mediafactory/v1/schedule/onair_now' +
      '?rtype=json&local_station_code=00&channel_code=24'
    );
    const schedData = await schedRes.json();
    const schedules = schedData[0]?.schedules ?? [];
    const now = new Date();
    const nowTime = now.getHours() * 10000 + now.getMinutes() * 100 + now.getSeconds();
    const current = schedules.find(s =>
      parseInt(s.service_start_time) <= nowTime &&
      nowTime < parseInt(s.service_end_time)
    ) ?? schedules[0];
    const programTitle = current?.program_title ?? null;

    const data = { streamUrl, programTitle };
    kbsCache = { data, ts: Date.now() };
    return data;
  } catch {
    return {
      streamUrl: 'https://1fm.gscdn.kbs.co.kr/1fm_192_2.m3u8',
      programTitle: null,
    };
  }
}

// ── 유틸리티 ────────────────────────────────────────────────────

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${env.ADMIN_KEY}`;
}

function parseRange(header, totalSize) {
  const m = header.match(/bytes=(\d*)-(\d*)/);
  if (!m) return null;
  const offset = m[1] ? parseInt(m[1]) : 0;
  const end    = m[2] ? parseInt(m[2]) : (totalSize ? totalSize - 1 : undefined);
  const length = end !== undefined ? (end - offset + 1) : undefined;
  return { offset, length, end };
}

function decodeFileName(filename) {
  try {
    return decodeURIComponent(filename).replace(/\.[^/.]+$/, '');
  } catch {
    return filename.replace(/\.[^/.]+$/, '');
  }
}

function guessChannel(key) {
  if (key.includes('channel-list1')) return 'list1';
  if (key.includes('channel-list2')) return 'list2';
  if (key.includes('channel-stream')) return 'stream';
  return 'stream';
}
