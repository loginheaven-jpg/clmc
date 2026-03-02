const CACHE_NAME = 'yebom-radio-v6';

const NO_CACHE_PATTERNS = [
  /\.mp3$/, /\.m4a$/, /\.ogg$/, /\.wav$/, /\.flac$/,
  /\.m3u8$/, /\.ts$/, /\.aac$/,
  /\/api\//,
  /kbs\.co\.kr/, /febc\.net/,
  /cloudfront\.net/, /workers\.dev/,
  /localhost/,
];

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()).then(() => {
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({ type: 'NEW_VERSION_ACTIVATED' });
        });
      });
    })
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;

  // 미디어/API 요청은 캐시하지 않음
  if (NO_CACHE_PATTERNS.some(p => p.test(request.url))) return;

  // ── 네비게이션 요청 (index.html) → Network-first ──
  // 온라인이면 항상 최신 HTML, 오프라인이면 캐시 폴백
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => caches.match('/') || caches.match(request))
    );
    return;
  }

  // ── 정적 자산 (아이콘, 폰트, manifest) → Cache-first ──
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      });
    }).catch(() => caches.match('/'))
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'CHECK_UPDATE') {
    self.skipWaiting();
  }
});
