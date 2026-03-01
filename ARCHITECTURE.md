# 예봄라디오 2.0 — 아키텍처 문서

> **버전**: 2026-03-01 v2.0
> **프로젝트 경로**: `c:\dev\yebomradio`
> **GitHub**: https://github.com/loginheaven-jpg/radio
> **Pages URL**: https://radio-axi.pages.dev

---

## 1. 프로젝트 개요

예봄라디오 2.0은 두 개의 기존 라디오 프로젝트(prev-radio + personal-radio)의 장점을 통합한 웹 라디오 서비스입니다.

| 항목 | 내용 |
|---|---|
| 인프라 | Cloudflare Workers + R2 + KV + Pages |
| 프론트엔드 | 단일 index.html (Vanilla JS, 빌드 없음) |
| 인증 | Admin Key — Bearer 토큰 방식 |
| PWA | manifest.json + sw.js (자동 업데이트) |
| UI 패턴 | 수평 스와이프 캐러셀 + Glassmorphism |

---

## 2. 파일 구조

```
yebomradio/
  ├── worker.js          ← Cloudflare Workers API (서버)
  ├── wrangler.toml      ← Workers 설정 (R2, KV 바인딩)
  ├── index.html         ← 전체 프론트엔드 (CSS + JS 인라인)
  ├── manifest.json      ← PWA 매니페스트
  ├── sw.js              ← Service Worker (캐시 전략)
  ├── icon-192.png       ← PWA 아이콘
  ├── icon-512.png       ← PWA 아이콘
  ├── ARCHITECTURE.md    ← 이 문서
  ├── DESIGN_GUIDE.md    ← 원본 설계 명세
  ├── prev-radio/        ← 이전 간이 라디오 (레퍼런스)
  └── personal-radio/    ← 이전 예봄라디오 (레퍼런스)
```

---

## 3. 채널 구성 (5채널)

| # | 채널명 | 유형 | 데이터 소스 | 색상 |
|---|---|---|---|---|
| 1 | KBS 클래식 FM | HLS 라이브 | KBS API → Workers 프록시 | `#C4B5FD` 라벤더 |
| 2 | 극동방송 | HLS 라이브 | 고정 m3u8 + 편성표 프록시 | `#FBBF9A` 살구 |
| 3 | 말씀의 전당 | R2 개인선택 | `radio/channel-list1/` | `#86EFAC` 민트 |
| 4 | 찬양의 숲 | R2 개인선택 | `radio/channel-list2/` | `#FCD34D` 골드 |
| 5 | 봄소리 방송 | R2 공유스트리밍 | `radio/channel-stream/` + KV 동기화 | `#F59E0B` 앰버 |

---

## 4. Workers API 엔드포인트

| Method | Path | 설명 | 인증 |
|---|---|---|---|
| GET | `/api/tracks?channel=list1\|list2\|stream` | 트랙 목록 (_meta.json 기준) | 없음 |
| GET | `/api/stream/:key` | R2 음원 Range Request 스트리밍 | 없음 |
| GET | `/api/ch5/state` | 채널5 현재 재생 상태 (KV) | 없음 |
| POST | `/api/ch5/state` | 채널5 재생 상태 변경 (KV) | Admin |
| POST | `/api/upload` | 음원 R2 업로드 + _meta.json 갱신 | Admin |
| POST | `/api/delete` | 음원 R2 삭제 + _meta.json 갱신 | Admin |
| POST | `/api/meta` | _meta.json 전체 덮어쓰기 (순서/곡명 변경) | Admin |
| GET | `/api/febc-schedule` | 극동방송 편성표 서버 프록시 (60초 캐시) | 없음 |
| GET | `/api/kbs` | KBS 스트리밍 URL + 현재 방송명 (서버 프록시) | 없음 |

### Recorder Server API (localhost:8090)

| Method | Path | 설명 |
|---|---|---|
| POST | `/record/start` | 녹음 시작 (source, filename, mode, silence_threshold, silence_duration) |
| POST | `/record/stop` | 녹음 중지 → MP3 저장 |
| GET | `/record/status` | 현재 녹음 상태 |
| GET | `/config/output-dir` | 현재 저장 경로 조회 |
| POST | `/config/output-dir` | 저장 경로 변경 (output_dir). 녹음 중 409 |
| GET | `/health` | 서버 상태 (output_dir 포함) |
| GET | `/devices` | 오디오 디바이스 목록 |
| GET | `/download/{filename}` | 녹음 파일 다운로드 |

---

## 5. R2 버킷 구조

```
coachdb-files/
  └── radio/
        ├── channel-stream/     ← 채널5 봄소리 방송
        ├── channel-list1/      ← 채널3 말씀의 전당
        │     └── _meta.json
        └── channel-list2/      ← 채널4 찬양의 숲
              └── _meta.json
```

---

## 6. KV 데이터

- **바인딩**: `RADIO_KV` (ID: `c4c08099c81c4860a0184e7c29562434`)
- **키**: `ch5_state` — 채널5 공유 스트리밍 상태 JSON

---

## 7. 핵심 기능

### 이어듣기 (채널 3, 4)
- localStorage 키: `radio-ch3-resume`, `radio-ch4-resume`
- 4중 저장: setInterval(5초) + beforeunload + pagehide + visibilitychange
- 복원 시 7일 만료 + R2 파일 존재 확인

### HLS 재생 (채널 1, 2)
- hls.js CDN 동적 로드
- iOS Safari 네이티브 HLS 폴백
- 60초마다 프로그램명 갱신

### 공유 스트리밍 (채널 5)
- 관리자가 ON AIR → KV에 상태 저장
- 청취자는 10초마다 polling → 오프셋 계산 → Howler.js로 재생

### Admin
- 헤더 3번 탭 → Admin Key 인증
- 파일 업로드/삭제, 순서 변경 (드래그&드롭)
- 채널 5 ON AIR / 일시정지 / 종료 제어

### PWA 설치
- `beforeinstallprompt` 이벤트 캡처 → 설치 버튼 표시
- iOS: Safari 공유 버튼 안내 가이드 모달
- 이미 standalone이면 버튼 숨김

### 자동 업데이트
- sw.js `activate` → `NEW_VERSION_ACTIVATED` 메시지 클라이언트에 전송
- 클라이언트: `updatefound` + 메시지 수신 시 1.5초 후 `window.location.reload()`
- 30분마다 `reg.update()` 호출

---

## 8. UI 구성

### 레이아웃
```
┌─────────────────────────────────────┐
│  Background: 시간대별 gradient       │
│  + 3개 Floating Orb (blur 70px)    │
├─────────────────────────────────────┤
│  CLOCK: HH:MM (3.5rem) SS (1.5rem)│  ← Space Grotesk, 채널색 연동
│  TITLE: 예봄라디오                   │  ← Black Han Sans
│  SUBTITLE: 현재 재생 프로그램명      │
├─────────────────────────────────────┤
│  ← [CARD] [CARD] [●CARD] [CARD] → │  ← scroll-snap 캐러셀
│         · · ● · ·                   │  ← dot indicators
├─────────────────────────────────────┤
│  PODCAST CONTROLS (채널 3,4,5만)    │  ← 시크바 + 이전/셔플/반복/다음
├─────────────────────────────────────┤
│  GLASS PANEL: 볼륨 + 수면타이머     │  ← glassmorphism
├─────────────────────────────────────┤
│  PWA INSTALL 버튼 (미설치시)         │
│  FOOTER                            │
└─────────────────────────────────────┘
```

### 채널 카드 구조
- 로고 이모지 + 주파수 + 채널명 + Now Playing 텍스트
- 10-bar 스펙트럼 애니메이션 (CSS keyframe, 재생 시)
- Ripple ring 효과 (재생 시 확산 원형 애니메이션)
- Active: scale(1.0), opacity(1.0) / Inactive: scale(0.88), opacity(0.45)

### 시간대별 배경 테마
| 시간대 | 시간 | 색상 톤 |
|---|---|---|
| dawn | 04-06 | 보라-남색 |
| morning | 07-11 | 진보라-남색 |
| afternoon | 12-16 | 남색-청록 |
| evening | 17-20 | 붉은-보라 |
| night | 21-03 | 검정-짙은남 |

### nowPlayingEl 프록시
기존 코드 호환성을 위해 `nowPlayingEl`을 Proxy 객체로 구현.
`textContent`/`innerHTML` 설정 시 헤더 서브타이틀 + 활성 카드 동시 갱신.

---

## 9. 외부 의존성 (CDN)

| 라이브러리 | 버전 | 용도 |
|---|---|---|
| Howler.js | 2.2.4 | R2 음원 재생 (Range Request) |
| hls.js | 1.4.14 | HLS 라이브 스트리밍 (동적 로드) |
| Space Grotesk | - | 시계/숫자 모노스페이스 폰트 |
| Black Han Sans | - | 타이틀 폰트 |
| Noto Serif KR | - | 채널명/제목 폰트 |
| Noto Sans KR | - | 본문 폰트 |

---

## 10. 배포

```bash
# Workers API 배포 (수동)
wrangler deploy

# Admin Key 설정 (최초 1회)
wrangler secret put ADMIN_KEY

# 프론트엔드 배포 (GitHub 자동)
# git push → Cloudflare Pages 자동 빌드/배포
# 프로젝트: radio (radio-axi.pages.dev)
# GitHub: loginheaven-jpg/radio (main 브랜치)
git add . && git commit -m "설명" && git push
```

---

## 11. localStorage 키 목록

| 키 | 용도 |
|---|---|
| `radio-worker-url` | Workers API URL |
| `radio-admin-key` | Admin 인증키 (클라이언트 캐시) |
| `radio-last-channel` | 마지막 선택 채널 (1~5) |
| `radio-ch3-resume` | 채널3 이어듣기 상태 JSON |
| `radio-ch4-resume` | 채널4 이어듣기 상태 JSON |
| `radio-volume` | 볼륨 (0.0~1.0) |
| `radio-record-dir` | 녹음 파일 저장 경로 (서버와 자동 동기화) |
