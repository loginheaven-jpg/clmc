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
let rscCache  = { data: null, ts: 0 };

export default {
  async scheduled(event, env, ctx) {
    await openRoomCron(env);
  },

  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const cors = corsHeaders(request);

    // OPTIONS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    try {

      // ── 트랙 목록 (_meta.json 기준) ───────────────────────────
      if (path === '/api/tracks' && method === 'GET') {
        const channel = url.searchParams.get('channel') || 'stream';
        const prefix  = DIR_MAP[channel] || DIR_MAP.stream;

        let allObjects = [];
        let cursor = undefined;
        do {
          const list = await env.RADIO_BUCKET.list({ prefix, limit: 1000, cursor });
          allObjects = allObjects.concat(list.objects);
          cursor = list.truncated ? list.cursor : undefined;
        } while (cursor);
        const audioFiles = allObjects.filter(
          obj => /\.(mp3|m4a|ogg|wav|flac|aac|opus|webm)$/i.test(obj.key)
        );

        const metaKey = prefix + '_meta.json';
        const metaObj = await env.RADIO_BUCKET.get(metaKey);
        let meta = null;
        if (metaObj) {
          try { meta = JSON.parse(await metaObj.text()); } catch {}
        }

        let tracks;
        if (meta && Array.isArray(meta)) {
          const r2Keys = new Set(audioFiles.map(o => o.key));
          tracks = meta
            .filter(m => r2Keys.has(m.key) || m.crossRef)
            .map((m, i) => ({
              key:   m.key,
              name:  m.name || decodeFileName(m.key.replace(prefix, '')),
              size:  m.crossRef ? (m.size || 0) : (audioFiles.find(o => o.key === m.key)?.size ?? 0),
              order: m.order ?? i,
            }));
        } else {
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
      if (path.startsWith('/api/stream/') && method === 'GET') {
        const key = decodeURIComponent(path.slice('/api/stream/'.length));
        const rangeHeader = request.headers.get('Range');

        const headObj = await env.RADIO_BUCKET.head(key);
        if (!headObj) return new Response('Not Found', { status: 404, headers: cors });

        const totalSize = headObj.size;
        const ext = key.split('.').pop().toLowerCase();
        const contentTypeMap = {
          mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg; codecs=opus',
          wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', webm: 'audio/webm',
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
      if (path === '/api/ch5/state' && method === 'GET') {
        const state = await env.RADIO_KV.get('ch5_state', 'json');
        return json(state || { mode: 'file', trackKey: null, paused: true, currentTime: 0 }, cors);
      }

      // ── 채널5 상태 쓰기 (관리자) — 라이브 잠금 추가 ─────────
      if (path === '/api/ch5/state' && method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });

        // ★ 라이브 활성 시 거부
        const liveRaw = await env.RADIO_KV.get('live_state');
        if (liveRaw) {
          const live = JSON.parse(liveRaw);
          if (live.active) {
            return json({ error: 'live_active',
              message: '라이브 방송 중에는 파일 ON AIR를 사용할 수 없습니다.' }, cors, 409);
          }
        }

        const body = await request.json();
        const state = {
          mode:       'file',
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
      if (path === '/api/upload' && method === 'POST') {
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

      // ── 멀티파트 업로드: 시작 ─────────────────────────────────
      if (path === '/api/upload/multipart/create' && method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        const { key, contentType } = await request.json();
        const mpu = await env.RADIO_BUCKET.createMultipartUpload(key, {
          httpMetadata: { contentType: contentType || 'audio/mpeg' },
        });
        return json({ uploadId: mpu.uploadId, key }, cors);
      }

      // ── 멀티파트 업로드: 파트 전송 ───────────────────────────
      if (path === '/api/upload/multipart/part' && method === 'PUT') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        const key = decodeURIComponent(request.headers.get('X-Upload-Key'));
        const uploadId = request.headers.get('X-Upload-Id');
        const partNum = parseInt(request.headers.get('X-Part-Number'));
        const mpu = env.RADIO_BUCKET.resumeMultipartUpload(key, uploadId);
        const part = await mpu.uploadPart(partNum, request.body);
        return json({ partNumber: part.partNumber, etag: part.etag }, cors);
      }

      // ── 멀티파트 업로드: 완료 ─────────────────────────────────
      if (path === '/api/upload/multipart/complete' && method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        const { key, uploadId, parts, channel, name } = await request.json();
        const mpu = env.RADIO_BUCKET.resumeMultipartUpload(key, uploadId);
        await mpu.complete(parts);

        // _meta.json 업데이트
        const prefix = DIR_MAP[channel] || DIR_MAP.stream;
        const metaKey = prefix + '_meta.json';
        const metaObj = await env.RADIO_BUCKET.get(metaKey);
        let meta = [];
        if (metaObj) { try { meta = JSON.parse(await metaObj.text()); } catch {} }
        const trackName = (name || '').toString() || key.split('/').pop().replace(/\.[^/.]+$/, '');
        const maxOrder = meta.length > 0 ? Math.max(...meta.map(m => m.order ?? 0)) : -1;
        meta.push({ key, name: trackName, order: maxOrder + 1 });
        await env.RADIO_BUCKET.put(metaKey, JSON.stringify(meta), {
          httpMetadata: { contentType: 'application/json' },
        });
        return json({ ok: true, key, name: trackName }, cors);
      }

      // ── 파일 삭제 (관리자) ─────────────────────────────────────
      if (path === '/api/delete' && method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        const { key, channel } = await request.json();
        await env.RADIO_BUCKET.delete(key);

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
      if (path === '/api/meta' && method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        const { channel, tracks } = await request.json();
        const prefix  = DIR_MAP[channel] || DIR_MAP.stream;
        const metaKey = prefix + '_meta.json';
        await env.RADIO_BUCKET.put(metaKey, JSON.stringify(tracks), {
          httpMetadata: { contentType: 'application/json' },
        });
        return json({ ok: true }, cors);
      }

      // ══════════════════════════════════════════════════════════
      // ── 라이브 방송 API ────────────────────────────────────────
      // ══════════════════════════════════════════════════════════

      // ── 라이브 청크 업로드 ─────────────────────────────────────
      if (path === '/api/live/chunk' && method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        return handleLiveChunk(request, env, cors);
      }

      // ── 라이브 청크 다운로드 ───────────────────────────────────
      if (method === 'GET' && path.match(/^\/api\/live\/chunk\/[\w-]+\/\d+$/)) {
        const parts = path.split('/');
        return handleGetLiveChunk(env, cors, parts[4], parseInt(parts[5]));
      }

      // ── 라이브 상태 읽기 (Cache API 1초) ──────────────────────
      if (path === '/api/live/state' && method === 'GET') {
        return handleGetLiveState(request, env, cors);
      }

      // ── 라이브 상태 쓰기 (시작/종료/메시지) ───────────────────
      if (path === '/api/live/state' && method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        return handlePostLiveState(request, env, cors);
      }

      // ── 라이브 보존 설정 읽기 ──────────────────────────────────
      if (path === '/api/live/config' && method === 'GET') {
        return handleGetLiveConfig(env, cors);
      }

      // ── 라이브 보존 설정 변경 ──────────────────────────────────
      if (path === '/api/live/config' && method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        return handlePostLiveConfig(request, env, cors);
      }

      // ── 저장된 방송 세션 목록 ──────────────────────────────────
      if (path === '/api/live/sessions' && method === 'GET') {
        return handleGetSessions(env, cors);
      }

      // ── 세션 수동 삭제 ─────────────────────────────────────────
      if (path === '/api/live/sessions/delete' && method === 'POST') {
        if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401, headers: cors });
        return handleDeleteSession(request, env, cors);
      }

      // ── 극동방송 편성표 프록시 ─────────────────────────────────
      if (path === '/api/febc-schedule' && method === 'GET') {
        const data = await getFebcSchedule();
        return json(data, cors);
      }

      // ── KBS 프록시 ─────────────────────────────────────────────
      if (path === '/api/kbs' && method === 'GET') {
        const data = await getKbsInfo();
        return json(data, cors);
      }

      // ── Radio Swiss Classic Now Playing ──────────────────────────
      if (path === '/api/rsc-nowplaying' && method === 'GET') {
        const data = await getRscNowPlaying();
        return json(data, cors);
      }

      // ── HLS 프록시 (CORS 우회) ─────────────────────────────────
      if (path === '/api/hls-proxy' && method === 'GET') {
        const target = url.searchParams.get('url');
        if (!target) return new Response('Missing url param', { status: 400, headers: cors });

        let parsed;
        try { parsed = new URL(target); } catch { return new Response('Invalid url', { status: 400, headers: cors }); }

        const allowed = ['gscdn.kbs.co.kr', 'kbs.co.kr', 'febc.net', 'mlive2.febc.net', 'stream.srg-ssr.ch'];
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

      // ── 곡명 인식 (ACRCloud) ─────────────────────────────────
      if (path === '/api/identify' && method === 'POST') {
        return handleIdentify(request, env, cors);
      }

      // ── Channel Config (서버 기반 채널 설정) ──
      if (path === '/api/channel-config' && method === 'GET') {
        const raw = await env.RADIO_KV.get('channel-config');
        return json(raw ? JSON.parse(raw) : null, cors);
      }
      if (path === '/api/channel-config' && method === 'PUT') {
        if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
        const body = await request.json();
        await env.RADIO_KV.put('channel-config', JSON.stringify(body));
        return json({ ok: true }, cors);
      }

      // ── 이메일+비밀번호 로그인 ──
      if (path === '/api/auth/email-login' && method === 'POST') {
        return handleEmailLogin(request, env, cors);
      }

      // ── 트랙별 재생위치 동기화 (로그인 사용자 전용) ──
      if (path === '/api/user/trackpos' && method === 'GET') {
        const userId = request.headers.get('X-User-Id');
        if (!userId) return json({ error: 'Login required' }, cors, 401);
        const raw = await env.RADIO_KV.get('user:trackpos:' + userId);
        return json({ positions: raw ? JSON.parse(raw) : {} }, cors);
      }
      if (path === '/api/user/trackpos' && (method === 'PUT' || method === 'POST')) {
        // sendBeacon은 POST + Content-Type text/plain이므로 userId를 쿼리에서도 수용
        const userId = request.headers.get('X-User-Id') || url.searchParams.get('userId');
        if (!userId) return json({ error: 'Login required' }, cors, 401);
        const body = await request.json();
        if (!body || typeof body.positions !== 'object') return json({ error: 'Invalid data' }, cors, 400);
        // 클라이언트가 보낸 positions를 기존 데이터와 병합 (더 최신 ts 우선)
        const kvKey = 'user:trackpos:' + userId;
        const existing = JSON.parse(await env.RADIO_KV.get(kvKey) || '{}');
        const merged = { ...existing };
        for (const [trackKey, entry] of Object.entries(body.positions)) {
          if (!existing[trackKey] || entry.ts > existing[trackKey].ts) {
            merged[trackKey] = entry;
          }
        }
        // 30일 만료 항목 정리
        const now = Date.now();
        const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
        for (const k in merged) { if (now - merged[k].ts > MAX_AGE) delete merged[k]; }
        await env.RADIO_KV.put(kvKey, JSON.stringify(merged));
        return json({ ok: true, positions: merged }, cors);
      }

      // ── 40주년 축하 메시지 ────────────────────────────────────
      if (path === '/api/anniversary/messages' && method === 'GET') {
        const raw = await env.RADIO_KV.get('anniversary:messages');
        return json({ messages: raw ? JSON.parse(raw) : [] }, cors);
      }
      if (path === '/api/anniversary/messages' && method === 'POST') {
        const body = await request.json();
        const text = (body.text || '').trim().slice(0, 200);
        const name = (body.name || '').trim().slice(0, 10) || '익명';
        if (!text) return json({ error: '메시지를 입력해주세요' }, cors, 400);
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rlKey = 'anniversary:ratelimit:' + ip;
        if (await env.RADIO_KV.get(rlKey)) {
          return json({ error: '잠시 후 다시 시도해주세요' }, cors, 429);
        }
        await env.RADIO_KV.put(rlKey, '1', { expirationTtl: 600 });
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const msg = { id, name, text, createdAt: Date.now() };
        const raw = await env.RADIO_KV.get('anniversary:messages');
        const messages = raw ? JSON.parse(raw) : [];
        messages.unshift(msg);
        if (messages.length > 500) messages.length = 500;
        await env.RADIO_KV.put('anniversary:messages', JSON.stringify(messages));
        return json({ ok: true, message: msg }, cors);
      }
      // 축하 메시지 임시저장 (draft upsert)
      if (path === '/api/anniversary/draft' && method === 'PATCH') {
        const body = await request.json();
        const text = (body.text || '').trim().slice(0, 200);
        const sid = (body.sid || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
        if (!sid) return json({ error: 'sid 필수' }, cors, 400);
        if (text) {
          await env.RADIO_KV.put('anniversary:draft:' + sid, text, { expirationTtl: 86400 * 7 });
        } else {
          await env.RADIO_KV.delete('anniversary:draft:' + sid);
        }
        return json({ ok: true }, cors);
      }
      // 축하 메시지 수정 (관리자 전용)
      if (path === '/api/anniversary/messages' && method === 'PUT') {
        if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
        const body = await request.json();
        const { id, text } = body;
        if (!id || !text) return json({ error: 'id, text 필수' }, cors, 400);
        const raw = await env.RADIO_KV.get('anniversary:messages');
        const messages = raw ? JSON.parse(raw) : [];
        const msg = messages.find(m => m.id === id);
        if (!msg) return json({ error: '메시지 없음' }, cors, 404);
        msg.text = text.trim().slice(0, 200);
        await env.RADIO_KV.put('anniversary:messages', JSON.stringify(messages));
        return json({ ok: true }, cors);
      }
      // 축하 메시지 삭제 (관리자 전용)
      if (path === '/api/anniversary/messages' && method === 'DELETE') {
        if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
        const body = await request.json();
        const { id } = body;
        if (!id) return json({ error: 'id 필수' }, cors, 400);
        const raw = await env.RADIO_KV.get('anniversary:messages');
        let messages = raw ? JSON.parse(raw) : [];
        messages = messages.filter(m => m.id !== id);
        await env.RADIO_KV.put('anniversary:messages', JSON.stringify(messages));
        return json({ ok: true }, cors);
      }

      // ── 열린 음악방 (Open Room) ────────────────────────────────
      if (path.startsWith('/api/openroom')) {
        return handleOpenRoom(request, env, cors, path, method, url);
      }

      return new Response('Not Found', { status: 404, headers: cors });

    } catch (e) {
      return json({ error: e.message }, cors, 500);
    }
  }
};

// ══════════════════════════════════════════════════════════════════
// ── 라이브 방송 핸들러 ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

async function handleLiveChunk(request, env, cors) {
  const chunkIndex = parseInt(request.headers.get('X-Chunk-Index'));
  const chunkDuration = parseFloat(request.headers.get('X-Chunk-Duration') || '2.0');
  const body = await request.arrayBuffer();
  const chunkSize = body.byteLength;

  const stateRaw = await env.RADIO_KV.get('live_state');
  if (!stateRaw) return json({ error: 'no_session' }, cors, 400);
  const state = JSON.parse(stateRaw);
  if (!state.active || !state.sessionId) return json({ error: 'not_active' }, cors, 400);

  const key = `radio/live/${state.sessionId}/chunk-${String(chunkIndex).padStart(8, '0')}.ogg`;
  await env.RADIO_BUCKET.put(key, body, {
    httpMetadata: { contentType: 'audio/ogg' }
  });

  // Cache API에 매 청크마다 latestChunk 기록 (쓰기 제한 없음)
  const latestCacheKey = new Request('https://cache.internal/live-latest-chunk');
  await caches.default.put(latestCacheKey, new Response(
    JSON.stringify({ latestChunk: chunkIndex, updatedAt: Date.now() }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3' } }
  ));

  // KV 갱신 (10청크마다 — 쓰기 한도 절약, 영속 용도)
  if (chunkIndex % 10 === 0) {
    state.latestChunk = chunkIndex;
    state.updatedAt = Date.now();
    await env.RADIO_KV.put('live_state', JSON.stringify(state));
  }

  // sessions.json 갱신 + 보존 정책 (10청크마다)
  if (chunkIndex % 10 === 0) {
    await updateSessionAndEnforceLimit(env, state.sessionId, chunkIndex, chunkSize * 10, chunkDuration);
  }

  return json({ ok: true, index: chunkIndex }, cors);
}

async function handleGetLiveChunk(env, cors, sessionId, index) {
  const key = `radio/live/${sessionId}/chunk-${String(index).padStart(8, '0')}.ogg`;
  const obj = await env.RADIO_BUCKET.get(key);
  if (!obj) return new Response('Not found', { status: 404, headers: cors });
  return new Response(obj.body, {
    headers: {
      ...cors,
      'Content-Type': 'audio/ogg',
      'Cache-Control': 'public, max-age=86400',
    }
  });
}

async function handleGetLiveState(request, env, cors) {
  // KV에서 기본 상태 읽기 (Cache API로 1초 캐싱)
  const kvCacheKey = new Request('https://cache.internal/live-state-kv');
  const cache = caches.default;
  let state;
  const kvCached = await cache.match(kvCacheKey);
  if (kvCached) {
    state = await kvCached.json();
  } else {
    const raw = await env.RADIO_KV.get('live_state');
    state = raw ? JSON.parse(raw) : { active: false };
    await cache.put(kvCacheKey, new Response(JSON.stringify(state), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1' }
    }));
  }

  // Cache API에서 더 최신 latestChunk 반영
  if (state.active) {
    const latestCached = await cache.match(new Request('https://cache.internal/live-latest-chunk'));
    if (latestCached) {
      const latest = await latestCached.json();
      if (latest.latestChunk > (state.latestChunk || -1)) {
        state.latestChunk = latest.latestChunk;
      }
    }
  }

  return new Response(JSON.stringify(state), {
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
  });
}

async function handlePostLiveState(request, env, cors) {
  const data = await request.json();

  if (data.action === 'start') {
    // 상호 잠금: 파일 ON AIR 활성 시 거부
    const ch5Raw = await env.RADIO_KV.get('ch5_state');
    if (ch5Raw) {
      const ch5 = JSON.parse(ch5Raw);
      if (ch5.trackKey && !ch5.paused) {
        return json({ error: 'file_active',
          message: '파일 ON AIR 중에는 라이브를 시작할 수 없습니다. 먼저 종료하세요.' }, cors, 409);
      }
    }

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const sessionId = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;

    await env.RADIO_KV.put('live_state', JSON.stringify({
      active: true, sessionId, latestChunk: -1,
      chunkDuration: data.chunkDuration || 2.0,
      startedAt: Date.now(), message: '', updatedAt: Date.now()
    }));

    await env.RADIO_KV.put('ch5_state', JSON.stringify({
      mode: 'live', trackKey: null, trackName: '\uD83D\uDD34 라이브 방송',
      paused: false, startEpoch: Date.now(), updatedAt: Date.now()
    }));

    // sessions.json에 추가
    const sessionsObj = await env.RADIO_BUCKET.get('radio/live/sessions.json');
    const sessions = sessionsObj ? JSON.parse(await sessionsObj.text()) : { sessions: [], totalSize: 0 };
    sessions.sessions.push({
      id: sessionId, startedAt: Date.now(), endedAt: null,
      chunkCount: 0, chunkDuration: data.chunkDuration || 2.0,
      totalSize: 0, title: data.title || ''
    });
    await env.RADIO_BUCKET.put('radio/live/sessions.json', JSON.stringify(sessions),
      { httpMetadata: { contentType: 'application/json' } });

    return json({ ok: true, sessionId }, cors);
  }

  if (data.action === 'stop') {
    const stateRaw = await env.RADIO_KV.get('live_state');
    const state = stateRaw ? JSON.parse(stateRaw) : {};
    const sessionId = state.sessionId;

    await env.RADIO_KV.put('live_state', JSON.stringify({ active: false }));
    await env.RADIO_KV.put('ch5_state', JSON.stringify({
      mode: 'file', trackKey: null, paused: true, currentTime: 0, updatedAt: Date.now()
    }));

    if (sessionId) {
      const sessionsObj = await env.RADIO_BUCKET.get('radio/live/sessions.json');
      if (sessionsObj) {
        const sessions = JSON.parse(await sessionsObj.text());
        const s = sessions.sessions.find(x => x.id === sessionId);
        if (s) {
          s.endedAt = Date.now();
          // totalSize는 청크 업로드 시 누적된 실제값 사용 (추정값 덮어쓰기 제거)
          sessions.totalSize = sessions.sessions.reduce((sum, x) => sum + x.totalSize, 0);
        }
        await env.RADIO_BUCKET.put('radio/live/sessions.json', JSON.stringify(sessions),
          { httpMetadata: { contentType: 'application/json' } });
      }
    }
    return json({ ok: true }, cors);
  }

  if (data.action === 'message') {
    const stateRaw = await env.RADIO_KV.get('live_state');
    if (stateRaw) {
      const state = JSON.parse(stateRaw);
      if (state.active) {
        state.message = data.message || '';
        state.updatedAt = Date.now();
        await env.RADIO_KV.put('live_state', JSON.stringify(state));
        return json({ ok: true }, cors);
      }
    }
    return json({ error: 'not_active' }, cors, 400);
  }

  return json({ error: 'invalid action' }, cors, 400);
}

async function handleGetLiveConfig(env, cors) {
  const configRaw = await env.RADIO_KV.get('live_config');
  const config = configRaw ? JSON.parse(configRaw) : { storageLimit: 2147483648, chunkDuration: 2.0 };

  const sessionsObj = await env.RADIO_BUCKET.get('radio/live/sessions.json');
  let currentUsage = 0, sessionCount = 0, totalDurationSec = 0;
  if (sessionsObj) {
    const data = JSON.parse(await sessionsObj.text());
    currentUsage = data.totalSize || 0;
    sessionCount = data.sessions.length;
    totalDurationSec = data.sessions.reduce((sum, s) => sum + s.chunkCount * s.chunkDuration, 0);
  }

  return json({
    storageLimit: config.storageLimit,
    storageLimitLabel: formatBytes(config.storageLimit),
    chunkDuration: config.chunkDuration,
    currentUsage, sessionCount, totalDurationSec
  }, cors);
}

async function handlePostLiveConfig(request, env, cors) {
  const data = await request.json();
  const ALLOWED = [524288000, 1073741824, 2147483648, 3221225472, 5368709120];
  if (!data.storageLimit || !ALLOWED.includes(data.storageLimit)) {
    return json({ error: 'invalid limit' }, cors, 400);
  }
  const configRaw = await env.RADIO_KV.get('live_config');
  const config = configRaw ? JSON.parse(configRaw) : { chunkDuration: 2.0 };
  config.storageLimit = data.storageLimit;
  await env.RADIO_KV.put('live_config', JSON.stringify(config));
  await enforceStorageLimit(env, config.storageLimit);
  return json({ ok: true }, cors);
}

async function handleGetSessions(env, cors) {
  const sessionsObj = await env.RADIO_BUCKET.get('radio/live/sessions.json');
  if (!sessionsObj) return json({ sessions: [] }, cors);
  const data = JSON.parse(await sessionsObj.text());
  const list = data.sessions
    .filter(s => s.endedAt !== null)
    .map(s => ({
      id: s.id, startedAt: s.startedAt, endedAt: s.endedAt,
      durationSec: s.chunkCount * s.chunkDuration,
      chunkCount: s.chunkCount, chunkDuration: s.chunkDuration, title: s.title
    }))
    .reverse();
  return json({ sessions: list }, cors);
}

async function handleDeleteSession(request, env, cors) {
  const { sessionId } = await request.json();
  const stateRaw = await env.RADIO_KV.get('live_state');
  if (stateRaw) {
    const state = JSON.parse(stateRaw);
    if (state.active && state.sessionId === sessionId) {
      return json({ error: 'cannot delete active session' }, cors, 409);
    }
  }
  await deleteSessionChunks(env, sessionId);
  const sessionsObj = await env.RADIO_BUCKET.get('radio/live/sessions.json');
  if (sessionsObj) {
    const data = JSON.parse(await sessionsObj.text());
    data.sessions = data.sessions.filter(s => s.id !== sessionId);
    data.totalSize = data.sessions.reduce((sum, s) => sum + s.totalSize, 0);
    await env.RADIO_BUCKET.put('radio/live/sessions.json', JSON.stringify(data),
      { httpMetadata: { contentType: 'application/json' } });
  }
  return json({ ok: true }, cors);
}

// ── 보존 정책 유틸리티 ─────────────────────────────────────────

async function updateSessionAndEnforceLimit(env, sessionId, chunkIndex, addedSize, chunkDuration) {
  const sessionsObj = await env.RADIO_BUCKET.get('radio/live/sessions.json');
  let data = sessionsObj ? JSON.parse(await sessionsObj.text()) : { sessions: [], totalSize: 0 };

  const session = data.sessions.find(s => s.id === sessionId);
  if (session) {
    session.chunkCount = chunkIndex + 1;
    session.totalSize += addedSize;
  }
  data.totalSize = data.sessions.reduce((sum, s) => sum + s.totalSize, 0);

  const configRaw = await env.RADIO_KV.get('live_config');
  const limit = configRaw ? JSON.parse(configRaw).storageLimit : 2147483648;

  while (data.totalSize > limit) {
    const oldest = data.sessions.find(s => s.endedAt !== null && s.id !== sessionId);
    if (!oldest) break;
    await deleteSessionChunks(env, oldest.id);
    data.sessions = data.sessions.filter(s => s.id !== oldest.id);
    data.totalSize = data.sessions.reduce((sum, s) => sum + s.totalSize, 0);
  }

  await env.RADIO_BUCKET.put('radio/live/sessions.json', JSON.stringify(data),
    { httpMetadata: { contentType: 'application/json' } });
}

async function enforceStorageLimit(env, limit) {
  const sessionsObj = await env.RADIO_BUCKET.get('radio/live/sessions.json');
  if (!sessionsObj) return;
  const data = JSON.parse(await sessionsObj.text());
  const liveRaw = await env.RADIO_KV.get('live_state');
  const activeId = liveRaw ? JSON.parse(liveRaw).sessionId : null;
  let changed = false;
  while (data.totalSize > limit) {
    const oldest = data.sessions.find(s => s.endedAt !== null && s.id !== activeId);
    if (!oldest) break;
    await deleteSessionChunks(env, oldest.id);
    data.sessions = data.sessions.filter(s => s.id !== oldest.id);
    data.totalSize = data.sessions.reduce((sum, s) => sum + s.totalSize, 0);
    changed = true;
  }
  if (changed) {
    await env.RADIO_BUCKET.put('radio/live/sessions.json', JSON.stringify(data),
      { httpMetadata: { contentType: 'application/json' } });
  }
}

async function deleteSessionChunks(env, sessionId) {
  const prefix = `radio/live/${sessionId}/`;
  let cursor = undefined;
  do {
    const listed = await env.RADIO_BUCKET.list({ prefix, limit: 1000, cursor });
    for (const obj of listed.objects) await env.RADIO_BUCKET.delete(obj.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

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

// ── Radio Swiss Classic Now Playing ─────────────────────────────
async function getRscNowPlaying() {
  if (rscCache.data && Date.now() - rscCache.ts < 30000) return rscCache.data;
  try {
    const res = await fetch('https://www.radioswissclassic.ch/de/musikprogramm', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(8000),
    });
    const html = await res.text();

    // __NUXT__ IIFE 파싱: (function(a,b,...){return {...}}("v1","v2",...))
    // 1) 파라미터 이름 추출
    const paramMatch = html.match(/window\.__NUXT__=\(function\(([^)]+)\)/);
    if (!paramMatch) throw new Error('NUXT params not found');
    const params = paramMatch[1].split(',').map(s => s.trim());

    // 2) metadata 필드→변수 매핑 (title:VAR, composer:VAR, coverId:VAR)
    // current[0].metadata 블록 내에서 탐색
    const metaMatch = html.match(/current:\[?\{[\s\S]*?metadata:\{([^}]+)\}/);
    if (!metaMatch) throw new Error('metadata not found');
    const meta = metaMatch[1];
    // [\w$]+ : $, _ 등 특수 식별자도 포함
    const getVar = f => { const m = meta.match(new RegExp(f + ':([\\w$]+)')); return m ? m[1] : null; };
    const titleVar = getVar('title');
    const composerVar = getVar('composer');
    const coverIdVar = getVar('coverId');

    // 3) IIFE 호출 인자 파싱 — __NUXT__ 스크립트 블록 내에서만 탐색
    const nuxtStart = html.indexOf('window.__NUXT__=');
    const scriptEnd = html.indexOf('</script>', nuxtStart);
    const nuxtBlock = nuxtStart >= 0 ? html.substring(nuxtStart, scriptEnd > 0 ? scriptEnd : undefined) : '';
    const argsStart = nuxtBlock.lastIndexOf('}(');
    const argsEnd = nuxtBlock.lastIndexOf('))');
    if (argsStart < 0 || argsEnd < 0) throw new Error('args not found');
    const argsRaw = nuxtBlock.substring(argsStart + 2, argsEnd);

    // 인자 목록 파싱 (문자열 리터럴 + 기타 리터럴)
    const values = [];
    let i = 0;
    while (i < argsRaw.length) {
      const ch = argsRaw[i];
      if (ch === '"') {
        let s = ''; i++;
        while (i < argsRaw.length) {
          if (argsRaw[i] === '\\') { s += argsRaw[i + 1] || ''; i += 2; }
          else if (argsRaw[i] === '"') { i++; break; }
          else { s += argsRaw[i]; i++; }
        }
        values.push(s);
      } else if (ch === ',' || ch === ' ') { i++; }
      else {
        let lit = '';
        while (i < argsRaw.length && argsRaw[i] !== ',') { lit += argsRaw[i]; i++; }
        const t = lit.trim();
        if (t === 'true') values.push(true);
        else if (t === 'false') values.push(false);
        else if (t === 'null') values.push(null);
        else if (t.startsWith('void')) values.push(undefined);
        else values.push(t);
      }
    }

    // 4) 변수 → 값 매핑
    const lookup = {};
    params.forEach((p, idx) => { if (idx < values.length) lookup[p] = values[idx]; });

    const title = titleVar ? (lookup[titleVar] ?? null) : null;
    const composer = composerVar ? (lookup[composerVar] ?? null) : null;
    const coverId = coverIdVar ? lookup[coverIdVar] : null;

    const data = {
      title: typeof title === 'string' ? title : null,
      composer: typeof composer === 'string' ? composer : null,
      coverUrl: coverId ? `https://cdne-satr-prd-rsc-covers.azureedge.net/200/${coverId}.jpg` : null,
    };
    rscCache = { data, ts: Date.now() };
    return data;
  } catch {
    return { title: null, composer: null, coverUrl: null };
  }
}

// ── 곡명 인식 (ACRCloud) ────────────────────────────────────────
async function handleIdentify(request, env, cors) {
  try {
    const { channel } = await request.json();
    if (channel !== 1 && channel !== 2) {
      return json({ error: '라이브 채널(1, 2)만 지원합니다' }, cors, 400);
    }

    // 1) m3u8 URL 결정
    let m3u8Url;
    if (channel === 1) {
      try { m3u8Url = (await getKbsInfo()).streamUrl; } catch {}
      if (!m3u8Url) m3u8Url = 'https://1fm.gscdn.kbs.co.kr/1fm_192_2.m3u8';
    } else {
      m3u8Url = 'https://mlive2.febc.net/live/seoulfm/playlist.m3u8';
    }

    // 2) m3u8 fetch + 세그먼트 URL 추출 (마지막 3개, ~12초)
    const ua = { 'User-Agent': 'Mozilla/5.0 (compatible; YebomRadio/2.0)' };
    const segUrls = await resolveSegmentUrls(m3u8Url, ua, 3);
    if (!segUrls || segUrls.length === 0) return json({ found: false, message: '세그먼트를 찾을 수 없습니다' }, cors);

    // 3) 세그먼트 fetch + 병합
    const buffers = [];
    for (const sUrl of segUrls) {
      const segRes = await fetch(sUrl, { headers: ua });
      if (segRes.ok) buffers.push(await segRes.arrayBuffer());
    }
    const totalSize = buffers.reduce((s, b) => s + b.byteLength, 0);
    if (totalSize < 1000) return json({ found: false, message: '오디오 데이터가 너무 짧습니다' }, cors);

    // 병합
    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const buf of buffers) { merged.set(new Uint8Array(buf), offset); offset += buf.byteLength; }

    // 4) ACRCloud API 호출
    return json(await callACRCloud(env, merged.buffer), cors);
  } catch (e) {
    return json({ found: false, message: '인식 실패: ' + e.message }, cors, 500);
  }
}

async function resolveSegmentUrls(m3u8Url, headers, count = 3) {
  const res = await fetch(m3u8Url, { headers });
  const text = await res.text();
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length === 0) return null;

  // variant 플레이리스트면 첫 번째 variant의 세그먼트 URL 재귀 추출
  const first = lines[0];
  if (first.endsWith('.m3u8') || first.includes('.m3u8?')) {
    return resolveSegmentUrls(toAbsoluteUrl(first, m3u8Url), headers, count);
  }

  // 마지막 N개 세그먼트 반환
  return lines.slice(-count).map(l => toAbsoluteUrl(l, m3u8Url));
}

function toAbsoluteUrl(relative, baseUrl) {
  if (relative.startsWith('http')) return relative;
  const base = new URL(baseUrl);
  if (relative.startsWith('/')) return base.origin + relative;
  const parts = base.pathname.split('/'); parts.pop();
  return base.origin + parts.join('/') + '/' + relative;
}

async function callACRCloud(env, audioBuffer) {
  const host = env.ACRCLOUD_HOST;
  const accessKey = env.ACRCLOUD_KEY;
  const accessSecret = env.ACRCLOUD_SECRET;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = ['POST', '/v1/identify', accessKey, 'audio', '1', timestamp].join('\n');

  // HMAC-SHA1 서명
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(accessSecret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(stringToSign));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  // multipart/form-data
  const fd = new FormData();
  fd.append('sample', new Blob([audioBuffer]), 'sample.aac');
  fd.append('access_key', accessKey);
  fd.append('data_type', 'audio');
  fd.append('signature_version', '1');
  fd.append('signature', signature);
  fd.append('timestamp', timestamp);
  fd.append('sample_bytes', audioBuffer.byteLength.toString());

  const res = await fetch(`https://${host}/v1/identify`, { method: 'POST', body: fd });
  const data = await res.json();

  if (data.status?.code === 0 && data.metadata?.music?.length > 0) {
    const m = data.metadata.music[0];
    return {
      found: true,
      title: m.title || '',
      artist: m.artists?.map(a => a.name).join(', ') || '',
      album: m.album?.name || '',
      composers: m.external_metadata?.works?.map(w => w.composers)?.flat()?.map(c => c.name)?.join(', ') || '',
      score: m.score || 0,
    };
  }
  return { found: false, message: data.status?.msg || '인식할 수 없습니다' };
}

// ── KBS 클래식 FM ───────────────────────────────────────────────
async function getKbsInfo() {
  if (kbsCache.data && Date.now() - kbsCache.ts < 60000) {
    return kbsCache.data;
  }
  try {
    const streamRes = await fetch(
      'https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/24',
      { headers: { Referer: 'https://onair.kbs.co.kr/' } }
    );
    const streamData = await streamRes.json();
    const radio = streamData.channel_item?.find(i => i.media_type === 'radio');
    const streamUrl = radio?.service_url
      ?? 'https://1fm.gscdn.kbs.co.kr/1fm_192_2.m3u8';

    const schedRes = await fetch(
      'https://static.api.kbs.co.kr/mediafactory/v1/schedule/onair_now' +
      '?rtype=json&local_station_code=00&channel_code=24'
    );
    const schedData = await schedRes.json();
    const schedules = schedData[0]?.schedules ?? [];
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC → KST(+9h)
    const nowTime = kst.getUTCHours() * 10000 + kst.getUTCMinutes() * 100 + kst.getUTCSeconds();
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
  const origin = request.headers.get('Origin') || '';
  // 허용 도메인: radio.yebom.org, yebomradio(workers.dev), localhost
  const allowed = /yebom\.org|yebomradio|localhost/.test(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, X-Chunk-Index, X-Chunk-Duration, X-Upload-Key, X-Upload-Id, X-Part-Number, X-User-Id, X-User-Name, X-Admin-Key',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
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

async function handleEmailLogin(request, env, cors) {
  try {
    const { email, password } = await request.json();

    if (!email?.trim()) {
      return json({ error: '이메일을 입력해 주세요.' }, cors, 400);
    }
    if (!password) {
      return json({ error: '비밀번호를 입력해 주세요.' }, cors, 400);
    }

    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return json({ error: '서버 설정 오류입니다.' }, cors, 500);
    }

    // users 테이블에서 이메일로 조회
    const res = await fetch(
      `${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(email.trim())}&select=user_id,email,password_hash,name,member_id,is_approved`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!res.ok) {
      return json({ error: '서버 오류가 발생했습니다.' }, cors, 500);
    }

    const users = await res.json();
    if (!users || users.length === 0) {
      return json({ error: '등록되지 않은 이메일입니다.' }, cors, 401);
    }

    const user = users[0];

    // bcrypt 비교 (Cloudflare Workers에서는 직접 구현 필요)
    // Workers 환경에서 bcryptjs를 사용할 수 없으므로 교적부 API에 위임
    const loginRes = await fetch(`https://saint.yebom.org/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
    });

    if (!loginRes.ok) {
      const errData = await loginRes.json().catch(() => ({}));
      return json({ error: errData.error || '이메일 또는 비밀번호가 일치하지 않습니다.' }, cors, 401);
    }

    // 교적부 로그인 성공 → 라디오용 user 정보 반환
    return json({
      success: true,
      user: { id: user.member_id || user.user_id, name: user.name },
    }, cors);
  } catch (e) {
    return json({ error: '서버 오류가 발생했습니다.' }, cors, 500);
  }
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

function formatBytes(bytes) {
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(0) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}

// ══════════════════════════════════════════════════════════════════
// ── 열린 음악방 (Open Room) ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const OR_DEFAULT_FOLDERS = [
  { name: '졸음운전방지', icon: '☀️', isDefault: true, createdBy: 'system' },
  { name: '온화한BGM',   icon: '🌿', isDefault: true, createdBy: 'system' },
  { name: '묵상기도',    icon: '🕯️', isDefault: true, createdBy: 'system' },
  { name: '성령충만',    icon: '🔥', isDefault: true, createdBy: 'system' },
  { name: '자유곡',      icon: '🎵', isDefault: true, createdBy: 'system' },
];

const OR_DEFAULT_SETTINGS = {
  maxFolders: 15,
  maxFileSizeMB: 50,
  maxTotalStorageGB: 2,
  emptyFolderCleanupDays: 30,
  allowedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/mp3', 'audio/ogg', 'audio/opus', 'audio/webm'],
  maxUploadsPerUser: 20,
  currentStorageUsed: 0,
};

function getRequestUser(request) {
  const userId = (request.headers.get('X-User-Id') || '').trim().slice(0, 100);
  const userName = decodeURIComponent((request.headers.get('X-User-Name') || '%EC%9D%B5%EB%AA%85').trim()).slice(0, 50);
  return userId ? { id: userId, name: userName } : null;
}

async function orGetFolders(env) {
  const raw = await env.RADIO_KV.get('openroom:folders');
  if (raw) return JSON.parse(raw);
  // 최초 초기화
  await env.RADIO_KV.put('openroom:folders', JSON.stringify(OR_DEFAULT_FOLDERS));
  return OR_DEFAULT_FOLDERS.map(f => ({ ...f }));
}

async function orGetSettings(env) {
  const raw = await env.RADIO_KV.get('openroom:settings');
  if (raw) return { ...OR_DEFAULT_SETTINGS, ...JSON.parse(raw) };
  return { ...OR_DEFAULT_SETTINGS };
}

async function orGetFolderTracks(env, folderName) {
  const raw = await env.RADIO_KV.get(`openroom:folder:${folderName}`);
  return raw ? JSON.parse(raw) : [];
}

async function orSaveFolderTracks(env, folderName, tracks) {
  await env.RADIO_KV.put(`openroom:folder:${folderName}`, JSON.stringify(tracks));
}

async function orGetFileMaster(env, r2Key) {
  const raw = await env.RADIO_KV.get(`openroom:file:${r2Key}`);
  return raw ? JSON.parse(raw) : null;
}

async function orSaveFileMaster(env, master) {
  await env.RADIO_KV.put(`openroom:file:${master.r2Key}`, JSON.stringify(master));
}

async function handleOpenRoom(request, env, cors, path, method, url) {
  // GET /api/openroom/folders
  if (path === '/api/openroom/folders' && method === 'GET') {
    const folders = await orGetFolders(env);
    const result = await Promise.all(folders.map(async f => {
      const tracks = await orGetFolderTracks(env, f.name);
      return { ...f, trackCount: tracks.length };
    }));
    return json(result, cors);
  }

  // POST /api/openroom/folders — 폴더 생성
  if (path === '/api/openroom/folders' && method === 'POST') {
    const user = getRequestUser(request);
    if (!user) return json({ error: '로그인이 필요합니다' }, cors, 401);
    const { name } = await request.json();
    if (!name || name.length < 2 || name.length > 10)
      return json({ error: '폴더 이름은 2~10자여야 합니다' }, cors, 400);
    const folders = await orGetFolders(env);
    if (folders.some(f => f.name === name))
      return json({ error: '이미 같은 이름의 폴더가 있습니다' }, cors, 409);
    const settings = await orGetSettings(env);
    if (folders.length >= settings.maxFolders)
      return json({ error: `폴더는 최대 ${settings.maxFolders}개까지 만들 수 있습니다` }, cors, 400);
    const newFolder = { name, icon: '✨', isDefault: false, createdBy: user.id, createdAt: new Date().toISOString() };
    folders.push(newFolder);
    await env.RADIO_KV.put('openroom:folders', JSON.stringify(folders));
    return json({ ok: true, folder: newFolder }, cors);
  }

  // PUT /api/openroom/folders/:name — 폴더 이름·아이콘 변경 (관리자)
  const folderEditMatch = path.match(/^\/api\/openroom\/folders\/([^/]+)$/) && method === 'PUT';
  if (folderEditMatch) {
    if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
    const folderName = decodeURIComponent(path.split('/')[4]);
    const { newName, icon } = await request.json();
    const folders = await orGetFolders(env);
    const idx = folders.findIndex(f => f.name === folderName);
    if (idx < 0) return json({ error: '폴더를 찾을 수 없습니다' }, cors, 404);
    if (newName && newName !== folderName) {
      if (folders.some(f => f.name === newName)) return json({ error: '이미 같은 이름의 폴더가 있습니다' }, cors, 409);
      const tracks = await orGetFolderTracks(env, folderName);
      await orSaveFolderTracks(env, newName, tracks);
      await env.RADIO_KV.delete(`openroom:folder:${folderName}`);
      // 파일 마스터 refs 업데이트
      for (const t of tracks) {
        const master = await orGetFileMaster(env, t.r2Key);
        if (master) {
          master.refs = master.refs.map(r => r === folderName ? newName : r);
          await orSaveFileMaster(env, master);
        }
      }
      folders[idx].name = newName;
    }
    if (icon) folders[idx].icon = icon;
    await env.RADIO_KV.put('openroom:folders', JSON.stringify(folders));
    return json({ ok: true }, cors);
  }

  // DELETE /api/openroom/folders/:name — 폴더 삭제 (관리자)
  const folderDeleteMatch = path.match(/^\/api\/openroom\/folders\/([^/]+)$/) && method === 'DELETE';
  if (folderDeleteMatch) {
    if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
    const folderName = decodeURIComponent(path.split('/')[4]);
    const folders = await orGetFolders(env);
    const folder = folders.find(f => f.name === folderName);
    if (!folder) return json({ error: '폴더를 찾을 수 없습니다' }, cors, 404);
    if (folder.isDefault) return json({ error: '기본 폴더는 삭제할 수 없습니다' }, cors, 400);
    // refs 정리 및 고아 파일 삭제
    const tracks = await orGetFolderTracks(env, folderName);
    for (const t of tracks) {
      const master = await orGetFileMaster(env, t.r2Key);
      if (master) {
        master.refs = master.refs.filter(r => r !== folderName);
        if (master.refs.length === 0) {
          await env.RADIO_BUCKET.delete(`openroom/files/${master.r2Key}`);
          await env.RADIO_KV.delete(`openroom:file:${master.r2Key}`);
        } else {
          await orSaveFileMaster(env, master);
        }
      }
    }
    await env.RADIO_KV.delete(`openroom:folder:${folderName}`);
    await env.RADIO_KV.put('openroom:folders', JSON.stringify(folders.filter(f => f.name !== folderName)));
    return json({ ok: true }, cors);
  }

  // GET /api/openroom/folders/:name/tracks
  const tracksGetMatch = path.match(/^\/api\/openroom\/folders\/([^/]+)\/tracks$/);
  if (tracksGetMatch && method === 'GET') {
    const folderName = decodeURIComponent(path.split('/')[4]);
    const tracks = await orGetFolderTracks(env, folderName);
    return json(tracks, cors);
  }

  // POST /api/openroom/folders/:name/tracks — 곡 업로드
  const tracksUploadMatch = path.match(/^\/api\/openroom\/folders\/([^/]+)\/tracks$/);
  if (tracksUploadMatch && method === 'POST') {
    const user = getRequestUser(request);
    if (!user) return json({ error: '로그인이 필요합니다' }, cors, 401);

    const folderName = decodeURIComponent(path.split('/')[4]);
    const folders = await orGetFolders(env);
    if (!folders.some(f => f.name === folderName))
      return json({ error: '폴더를 찾을 수 없습니다' }, cors, 404);

    const settings = await orGetSettings(env);
    const formData = await request.formData();
    const file = formData.get('file');
    const displayName = (formData.get('displayName') || '').trim() || (file?.name || '').replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ').trim();
    const duration = parseInt(formData.get('duration') || '0');
    const fileHash = (formData.get('fileHash') || '').trim().slice(0, 64);

    if (!file) return json({ error: '파일이 없습니다' }, cors, 400);
    const fileSizeMB = file.size / 1048576;
    if (fileSizeMB > settings.maxFileSizeMB)
      return json({ error: `파일 크기가 ${settings.maxFileSizeMB}MB를 초과합니다` }, cors, 400);

    const mime = file.type || 'audio/mpeg';
    const allowedMimes = settings.allowedMimeTypes || OR_DEFAULT_SETTINGS.allowedMimeTypes;
    if (!allowedMimes.includes(mime) && !mime.startsWith('audio/'))
      return json({ error: 'MP3, M4A, WAV, OGG, OPUS, WebM 파일만 올릴 수 있습니다' }, cors, 400);

    // 파일 확장자
    const extMap = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/webm': '.webm' };
    const ext = extMap[mime] || '.mp3';

    // 해시 기반 중복 제거
    const r2Key = fileHash ? `${fileHash}${ext}` : `${crypto.randomUUID()}${ext}`;
    const r2Path = `openroom/files/${r2Key}`;

    let master = await orGetFileMaster(env, r2Key);
    if (!master) {
      // 신규 파일 R2 업로드
      const fileBuffer = await file.arrayBuffer();
      await env.RADIO_BUCKET.put(r2Path, fileBuffer, {
        httpMetadata: { contentType: mime },
      });
      master = {
        r2Key,
        originalName: displayName,
        uploader: user.name,
        uploaderId: user.id,
        duration,
        size: file.size,
        mimeType: mime,
        refs: [],
        createdAt: new Date().toISOString(),
      };
    }

    // 폴더에 참조 추가
    const folderTracks = await orGetFolderTracks(env, folderName);
    if (folderTracks.length >= 100)
      return json({ error: '폴더당 최대 100곡까지 올릴 수 있습니다' }, cors, 400);
    if (folderTracks.some(t => t.r2Key === r2Key))
      return json({ error: '이 폴더에 이미 동일한 곡이 있습니다' }, cors, 409);

    const refId = crypto.randomUUID();
    const ref = {
      refId,
      r2Key,
      displayName: displayName || master.originalName,
      uploader: user.name,
      uploaderId: user.id,
      duration: duration || master.duration,
      addedAt: new Date().toISOString(),
    };
    folderTracks.push(ref);
    await orSaveFolderTracks(env, folderName, folderTracks);

    if (!master.refs.includes(folderName)) master.refs.push(folderName);
    await orSaveFileMaster(env, master);

    return json({ ok: true, track: { ...ref, folder: folderName } }, cors);
  }

  // PUT /api/openroom/folders/:name/order — 곡 순서 저장 (로그인 사용자)
  const orderMatch = path.match(/^\/api\/openroom\/folders\/([^/]+)\/order$/);
  if (orderMatch && method === 'PUT') {
    const orderUser = getRequestUser(request);
    if (!orderUser) return json({ error: 'Unauthorized' }, cors, 401);
    const folderName = decodeURIComponent(orderMatch[1]);
    const { refIds } = await request.json();
    if (!Array.isArray(refIds)) return json({ error: 'refIds 배열 필요' }, cors, 400);
    const tracks = await orGetFolderTracks(env, folderName);
    const trackMap = Object.fromEntries(tracks.map(t => [t.refId, t]));
    const reordered = refIds.map(id => trackMap[id]).filter(Boolean);
    await orSaveFolderTracks(env, folderName, reordered);
    return json({ ok: true }, cors);
  }

  // PUT /api/openroom/tracks/:refId — 곡 이름 수정
  const trackEditMatch = path.match(/^\/api\/openroom\/tracks\/([^/]+)$/);
  if (trackEditMatch && method === 'PUT') {
    const user = getRequestUser(request);
    const refId = trackEditMatch[1];
    const { folderName, displayName } = await request.json();
    if (!folderName || !displayName) return json({ error: '폴더명과 곡 이름이 필요합니다' }, cors, 400);
    const tracks = await orGetFolderTracks(env, folderName);
    const idx = tracks.findIndex(t => t.refId === refId);
    if (idx < 0) return json({ error: '곡을 찾을 수 없습니다' }, cors, 404);
    const track = tracks[idx];
    const isOwner = user && track.uploaderId === user.id;
    if (!isOwner && !isAdmin(request, env)) return json({ error: '권한이 없습니다' }, cors, 403);
    tracks[idx].displayName = displayName.trim().slice(0, 100);
    await orSaveFolderTracks(env, folderName, tracks);
    return json({ ok: true }, cors);
  }

  // DELETE /api/openroom/tracks/:refId — 폴더에서 제거
  const trackDeleteMatch = path.match(/^\/api\/openroom\/tracks\/([^/]+)$/);
  if (trackDeleteMatch && method === 'DELETE') {
    const user = getRequestUser(request);
    const refId = trackDeleteMatch[1];
    const folderName = url.searchParams.get('folder');
    if (!folderName) return json({ error: 'folder 파라미터가 필요합니다' }, cors, 400);
    const tracks = await orGetFolderTracks(env, folderName);
    const idx = tracks.findIndex(t => t.refId === refId);
    if (idx < 0) return json({ error: '곡을 찾을 수 없습니다' }, cors, 404);
    const track = tracks[idx];
    const isOwner = user && track.uploaderId === user.id;
    if (!isOwner && !isAdmin(request, env)) return json({ error: '권한이 없습니다' }, cors, 403);

    tracks.splice(idx, 1);
    await orSaveFolderTracks(env, folderName, tracks);

    // 파일 마스터 refs 업데이트
    const master = await orGetFileMaster(env, track.r2Key);
    if (master) {
      master.refs = master.refs.filter(r => r !== folderName);
      if (master.refs.length === 0) {
        await env.RADIO_BUCKET.delete(`openroom/files/${track.r2Key}`);
        await env.RADIO_KV.delete(`openroom:file:${track.r2Key}`);
      } else {
        await orSaveFileMaster(env, master);
      }
    }
    return json({ ok: true }, cors);
  }

  // POST /api/openroom/admin/copy — 복사
  if (path === '/api/openroom/admin/copy' && method === 'POST') {
    if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
    const { r2Key, sourceFolder, targetFolders } = await request.json();
    const master = await orGetFileMaster(env, r2Key);
    if (!master) return json({ error: '파일을 찾을 수 없습니다' }, cors, 404);
    const copied = [], skipped = [];
    for (const target of targetFolders) {
      const tracks = await orGetFolderTracks(env, target);
      if (tracks.some(t => t.r2Key === r2Key)) { skipped.push(target); continue; }
      const srcTracks = await orGetFolderTracks(env, sourceFolder);
      const srcRef = srcTracks.find(t => t.r2Key === r2Key);
      const newRef = {
        refId: crypto.randomUUID(),
        r2Key,
        displayName: srcRef?.displayName || master.originalName,
        uploader: master.uploader,
        uploaderId: master.uploaderId,
        duration: master.duration,
        addedAt: new Date().toISOString(),
      };
      tracks.push(newRef);
      await orSaveFolderTracks(env, target, tracks);
      if (!master.refs.includes(target)) master.refs.push(target);
      copied.push(target);
    }
    await orSaveFileMaster(env, master);
    return json({ ok: true, copied, skipped, refs: master.refs }, cors);
  }

  // POST /api/openroom/admin/move — 이동
  if (path === '/api/openroom/admin/move' && method === 'POST') {
    if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
    const { refId, sourceFolder, targetFolder } = await request.json();
    const srcTracks = await orGetFolderTracks(env, sourceFolder);
    const idx = srcTracks.findIndex(t => t.refId === refId);
    if (idx < 0) return json({ error: '곡을 찾을 수 없습니다' }, cors, 404);
    const ref = srcTracks[idx];
    const tgtTracks = await orGetFolderTracks(env, targetFolder);
    if (tgtTracks.some(t => t.r2Key === ref.r2Key)) return json({ error: '대상 폴더에 이미 존재합니다' }, cors, 409);
    srcTracks.splice(idx, 1);
    tgtTracks.push({ ...ref, refId: crypto.randomUUID(), addedAt: new Date().toISOString() });
    await orSaveFolderTracks(env, sourceFolder, srcTracks);
    await orSaveFolderTracks(env, targetFolder, tgtTracks);
    const master = await orGetFileMaster(env, ref.r2Key);
    if (master) {
      master.refs = master.refs.filter(r => r !== sourceFolder);
      if (!master.refs.includes(targetFolder)) master.refs.push(targetFolder);
      await orSaveFileMaster(env, master);
    }
    return json({ ok: true }, cors);
  }

  // DELETE /api/openroom/admin/files/:r2Key — 완전 삭제
  const adminFileDelete = path.match(/^\/api\/openroom\/admin\/files\/(.+)$/);
  if (adminFileDelete && method === 'DELETE') {
    if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
    const r2Key = decodeURIComponent(adminFileDelete[1]);
    const master = await orGetFileMaster(env, r2Key);
    if (!master) return json({ error: '파일을 찾을 수 없습니다' }, cors, 404);
    for (const folderName of master.refs) {
      const tracks = await orGetFolderTracks(env, folderName);
      await orSaveFolderTracks(env, folderName, tracks.filter(t => t.r2Key !== r2Key));
    }
    await env.RADIO_BUCKET.delete(`openroom/files/${r2Key}`);
    await env.RADIO_KV.delete(`openroom:file:${r2Key}`);
    return json({ ok: true }, cors);
  }

  // POST /api/openroom/admin/cross-copy — CH3/CH4 ↔ CH7 교차 복사
  if (path === '/api/openroom/admin/cross-copy' && method === 'POST') {
    if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
    const body = await request.json();
    const { r2Key, direction, targetFolders } = body;
    // direction: 'ch-to-or' (CH3/4→CH7), 'or-to-ch4' (CH7→CH4)
    if (direction === 'ch-to-or' && targetFolders && targetFolders.length > 0) {
      // CH3/CH4 R2 파일을 CH7 폴더에 참조로 추가
      const headObj = await env.RADIO_BUCKET.head(r2Key);
      if (!headObj) return json({ error: '파일을 찾을 수 없습니다' }, cors, 404);
      const displayName = decodeFileName(r2Key.split('/').pop());
      const copied = [];
      for (const folder of targetFolders) {
        const tracks = await orGetFolderTracks(env, folder);
        if (tracks.some(t => t.r2Key === r2Key)) continue; // 이미 있음
        tracks.push({
          refId: crypto.randomUUID(),
          r2Key,
          displayName,
          uploader: '관리자',
          uploaderId: 'admin',
          duration: 0,
          addedAt: new Date().toISOString(),
        });
        await orSaveFolderTracks(env, folder, tracks);
        copied.push(folder);
      }
      // fileMaster가 없으면 생성 (CH 파일이므로)
      let master = await orGetFileMaster(env, r2Key);
      if (!master) {
        master = {
          r2Key,
          originalName: displayName,
          uploader: '관리자',
          uploaderId: 'admin',
          duration: 0,
          size: headObj.size,
          mimeType: headObj.httpMetadata?.contentType || 'audio/mpeg',
          refs: [],
          createdAt: new Date().toISOString(),
        };
      }
      for (const f of copied) { if (!master.refs.includes(f)) master.refs.push(f); }
      await orSaveFileMaster(env, master);
      return json({ ok: true, copied }, cors);
    } else if (direction === 'or-to-ch4') {
      // CH7 → CH4: _meta.json에 crossRef 추가 (파일 복사 불필요)
      const prefix = DIR_MAP.list2;
      const metaKey = prefix + '_meta.json';
      const metaObj = await env.RADIO_BUCKET.get(metaKey);
      let meta = [];
      if (metaObj) { try { meta = JSON.parse(await metaObj.text()); } catch {} }
      if (!Array.isArray(meta)) meta = [];
      if (meta.some(m => m.key === r2Key)) return json({ error: '이미 찬양의 숲에 있습니다' }, cors, 409);
      // OpenRoom fileMaster에서 정보 가져오기
      const master = await orGetFileMaster(env, r2Key);
      const headObj = await env.RADIO_BUCKET.head(r2Key.startsWith('openroom/') ? r2Key : `openroom/files/${r2Key}`);
      const actualKey = headObj ? (r2Key.startsWith('openroom/') ? r2Key : `openroom/files/${r2Key}`) : r2Key;
      const displayName = master?.originalName || decodeFileName(r2Key);
      meta.push({
        key: actualKey,
        name: displayName,
        order: meta.length,
        crossRef: true,
        size: headObj?.size || master?.size || 0,
      });
      await env.RADIO_BUCKET.put(metaKey, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true }, cors);
    }
    return json({ error: '잘못된 direction' }, cors, 400);
  }

  // POST /api/openroom/admin/cross-move — CH3/CH4 ↔ CH7 교차 이동
  if (path === '/api/openroom/admin/cross-move' && method === 'POST') {
    if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
    const body = await request.json();
    const { r2Key, direction, targetFolder, sourceCh } = body;
    if (direction === 'ch-to-or' && targetFolder) {
      // CH→CH7: 폴더에 참조 추가 + CH 메타에서 제거
      const headObj = await env.RADIO_BUCKET.head(r2Key);
      if (!headObj) return json({ error: '파일을 찾을 수 없습니다' }, cors, 404);
      const displayName = decodeFileName(r2Key.split('/').pop());
      const tracks = await orGetFolderTracks(env, targetFolder);
      if (tracks.some(t => t.r2Key === r2Key)) return json({ error: '대상 폴더에 이미 존재합니다' }, cors, 409);
      tracks.push({
        refId: crypto.randomUUID(),
        r2Key,
        displayName,
        uploader: '관리자',
        uploaderId: 'admin',
        duration: 0,
        addedAt: new Date().toISOString(),
      });
      await orSaveFolderTracks(env, targetFolder, tracks);
      // fileMaster 생성/업데이트
      let master = await orGetFileMaster(env, r2Key);
      if (!master) {
        master = { r2Key, originalName: displayName, uploader: '관리자', uploaderId: 'admin', duration: 0, size: headObj.size, mimeType: headObj.httpMetadata?.contentType || 'audio/mpeg', refs: [], createdAt: new Date().toISOString() };
      }
      if (!master.refs.includes(targetFolder)) master.refs.push(targetFolder);
      await orSaveFileMaster(env, master);
      // 소스 CH 메타에서 제거
      const chMap = { 3: 'list1', 4: 'list2' };
      const prefix = DIR_MAP[chMap[sourceCh]] || DIR_MAP.list2;
      const metaKey = prefix + '_meta.json';
      const metaObj = await env.RADIO_BUCKET.get(metaKey);
      if (metaObj) {
        let meta = []; try { meta = JSON.parse(await metaObj.text()); } catch {}
        meta = meta.filter(m => m.key !== r2Key);
        await env.RADIO_BUCKET.put(metaKey, JSON.stringify(meta), { httpMetadata: { contentType: 'application/json' } });
      }
      return json({ ok: true }, cors);
    }
    return json({ error: '잘못된 direction' }, cors, 400);
  }

  // GET /api/openroom/admin/storage
  if (path === '/api/openroom/admin/storage' && method === 'GET') {
    if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
    const settings = await orGetSettings(env);
    const folders = await orGetFolders(env);
    let totalTracks = 0;
    for (const f of folders) {
      const tracks = await orGetFolderTracks(env, f.name);
      totalTracks += tracks.length;
    }
    return json({
      currentStorageUsed: settings.currentStorageUsed || 0,
      maxTotalStorageGB: settings.maxTotalStorageGB,
      totalTracks,
      totalFolders: folders.length,
    }, cors);
  }

  // PUT /api/openroom/admin/settings
  if (path === '/api/openroom/admin/settings' && method === 'PUT') {
    if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
    const body = await request.json();
    const settings = await orGetSettings(env);
    const updated = { ...settings, ...body };
    await env.RADIO_KV.put('openroom:settings', JSON.stringify(updated));
    return json({ ok: true, settings: updated }, cors);
  }

  // POST /api/openroom/admin/init — 기본 폴더 초기화
  if (path === '/api/openroom/admin/init' && method === 'POST') {
    if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, cors, 401);
    const existing = await env.RADIO_KV.get('openroom:folders');
    if (existing) return json({ ok: true, message: '이미 초기화됨', folders: JSON.parse(existing) }, cors);
    await env.RADIO_KV.put('openroom:folders', JSON.stringify(OR_DEFAULT_FOLDERS));
    await env.RADIO_KV.put('openroom:settings', JSON.stringify(OR_DEFAULT_SETTINGS));
    return json({ ok: true, folders: OR_DEFAULT_FOLDERS }, cors);
  }

  return json({ error: 'openroom: Not Found' }, cors, 404);
}

// ── Cron: 빈 폴더 정리 + 고아 파일 정리 + 용량 집계 ────────────
async function openRoomCron(env) {
  const settings = await orGetSettings(env);
  const folders = await orGetFolders(env);
  const cleanupDays = settings.emptyFolderCleanupDays || 30;
  const now = Date.now();

  // 1. 빈 폴더 자동 삭제
  const activeFolders = [];
  for (const folder of folders) {
    if (folder.isDefault) { activeFolders.push(folder); continue; }
    const tracks = await orGetFolderTracks(env, folder.name);
    if (tracks.length > 0) { activeFolders.push(folder); continue; }
    const created = folder.createdAt ? new Date(folder.createdAt).getTime() : 0;
    if (now - created >= cleanupDays * 86400000) {
      await env.RADIO_KV.delete(`openroom:folder:${folder.name}`);
      // 폴더 삭제 — 이미 빈 폴더이므로 refs 정리 불필요
    } else {
      activeFolders.push(folder);
    }
  }
  if (activeFolders.length !== folders.length) {
    await env.RADIO_KV.put('openroom:folders', JSON.stringify(activeFolders));
  }

  // 2. 고아 파일 정리 (refs가 빈 파일 마스터 레코드)
  // KV list로 openroom:file: 접두어 키 순회
  let listCursor;
  let totalSize = 0;
  do {
    const listed = await env.RADIO_KV.list({ prefix: 'openroom:file:', cursor: listCursor });
    for (const key of listed.keys) {
      const raw = await env.RADIO_KV.get(key.name);
      if (!raw) continue;
      const master = JSON.parse(raw);
      totalSize += master.size || 0;
      if (!master.refs || master.refs.length === 0) {
        await env.RADIO_BUCKET.delete(`openroom/files/${master.r2Key}`);
        await env.RADIO_KV.delete(key.name);
      }
    }
    listCursor = listed.list_complete ? undefined : listed.cursor;
  } while (listCursor);

  // 3. 저장 용량 갱신
  const updatedSettings = { ...settings, currentStorageUsed: totalSize };
  await env.RADIO_KV.put('openroom:settings', JSON.stringify(updatedSettings));
}
