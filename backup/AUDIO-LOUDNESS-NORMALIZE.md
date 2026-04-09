# AUDIO-LOUDNESS-NORMALIZE.md
## R2 음원 볼륨 정규화 배치 스크립트 — Claude Code 개발가이드

> **목적**: R2에 저장된 음원 중 볼륨이 기준 이하인 파일만 선별하여 라우드니스를 부스트한다.  
> **핵심 원칙**: 볼륨이 큰 파일은 절대 건드리지 않는다. 작은 것만 끌어올린다.  
> **실행 환경**: 로컬 머신 (Node.js + FFmpeg CLI)  
> **작업 범위**: 독립 스크립트 (`normalize-r2-audio.js`) 1개 파일 생성

---

## 1. 개요

예봄라디오 R2 버킷에 저장된 음원의 볼륨이 제각각이다. 특히 볼륨이 지나치게 작은 파일이 문제다.  
FFmpeg의 loudnorm 필터를 이용해 라우드니스를 측정하고, 기준 이하인 파일만 부스트하여 R2에 재업로드한다.

### 처리 흐름

```
R2 버킷 음원 목록 조회
    ↓
각 파일 다운로드 → FFmpeg 1st pass (라우드니스 측정)
    ↓
기준(-18 LUFS) 이하인가?
    ├─ YES → FFmpeg 2nd pass (부스트 처리) → R2 재업로드 → 원본 덮어쓰기
    └─ NO  → 스킵 (원본 보존)
    ↓
처리 결과 리포트 출력
```

---

## 2. 기술 사양

### 2.1 라우드니스 기준값

| 파라미터 | 값 | 설명 |
|---------|-----|------|
| 측정 기준 (threshold) | **-18 LUFS** | 이 값 이상이면 처리하지 않음 |
| 목표 라우드니스 (target) | **-16 LUFS** | 부스트 시 이 값으로 맞춤 |
| True Peak 상한 | **-1.5 dBTP** | 클리핑 방지 |
| Loudness Range | **11 LU** | 다이나믹 레인지 허용폭 |

### 2.2 FFmpeg 명령어

#### Pass 1: 측정 (출력 파일 없음)

```bash
ffmpeg -i input.mp3 -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -
```

stderr에 JSON이 출력된다. 핵심 필드:

```json
{
  "input_i": "-28.5",       ← 통합 라우드니스 (이 값으로 판단)
  "input_tp": "-3.2",       ← True Peak
  "input_lra": "8.1",       ← Loudness Range
  "input_thresh": "-38.9",
  "target_offset": "0.2"
}
```

`input_i` 값이 **-18.0 이하**이면 부스트 대상이다.

#### Pass 2: 부스트 (2-pass loudnorm)

```bash
ffmpeg -i input.mp3 -af loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-28.5:measured_TP=-3.2:measured_LRA=8.1:measured_thresh=-38.9:offset=0.2:linear=true -ar 44100 -b:a 192k output.mp3
```

- Pass 1에서 얻은 `measured_*` 값을 Pass 2에 그대로 넣는다.
- `linear=true`를 반드시 설정한다. (리니어 모드가 음질 열화가 적다)
- 출력 포맷: MP3 192kbps, 44100Hz (원본이 다른 포맷이면 원본 포맷 유지)

### 2.3 대상 파일 확장자

- `.mp3`, `.m4a`, `.aac`, `.ogg`, `.wav`, `.flac`
- 그 외 확장자는 스킵한다.

---

## 3. 스크립트 구조

### 파일명: `normalize-r2-audio.js`

```
normalize-r2-audio.js
├── 설정 상수 (R2 접속정보, 임계값, 목표값)
├── main()
│   ├── R2 파일 목록 조회 (wrangler r2 object list)
│   ├── 임시 디렉토리 생성 (/tmp/normalize-work/)
│   ├── for each 음원파일:
│   │   ├── downloadFromR2(key)
│   │   ├── measureLoudness(filePath) → { input_i, input_tp, ... }
│   │   ├── if input_i > THRESHOLD → skip, log
│   │   ├── else → normalizeLoudness(filePath, measurements) → outputPath
│   │   ├── uploadToR2(key, outputPath) → 원본 키에 덮어쓰기
│   │   └── cleanup temp files
│   └── printReport(results)
└── 유틸 함수들
```

### 3.1 주요 함수 명세

#### `measureLoudness(filePath)`

```javascript
/**
 * FFmpeg loudnorm 1st pass로 라우드니스를 측정한다.
 * @param {string} filePath - 로컬 파일 경로
 * @returns {Object} { input_i, input_tp, input_lra, input_thresh, target_offset }
 *                   모든 값은 number 타입으로 파싱하여 반환
 * @throws FFmpeg 실행 실패 시 에러
 */
```

구현 포인트:
- `child_process.execSync` 또는 `execa`로 FFmpeg 실행
- stderr에서 JSON 블록을 파싱한다 (stdout 아님, stderr임에 주의)
- JSON 파싱 실패 시 해당 파일은 스킵하고 리포트에 에러로 기록

#### `normalizeLoudness(filePath, measurements)`

```javascript
/**
 * FFmpeg loudnorm 2nd pass로 라우드니스를 정규화한다.
 * @param {string} filePath - 원본 로컬 파일 경로
 * @param {Object} measurements - measureLoudness()의 반환값
 * @returns {string} 정규화된 출력 파일 경로
 */
```

구현 포인트:
- 출력 파일명: `{원본이름}_normalized.{원본확장자}`
- 원본의 비트레이트를 `ffprobe`로 확인하여 동일 비트레이트로 출력
- 원본이 192kbps 이상이면 192kbps로 출력, 미만이면 원본 비트레이트 유지

#### `downloadFromR2(key)` / `uploadToR2(key, filePath)`

```javascript
/**
 * wrangler CLI를 이용하여 R2 오브젝트를 다운로드/업로드한다.
 * 
 * 다운로드: wrangler r2 object get <BUCKET>/<key> --file <localPath>
 * 업로드:   wrangler r2 object put <BUCKET>/<key> --file <localPath>
 *           --content-type 은 확장자에 따라 자동 설정
 */
```

### 3.2 설정 상수

```javascript
const CONFIG = {
  R2_BUCKET: 'yebom-radio',        // wrangler.toml의 버킷명과 일치시킬 것
  THRESHOLD_LUFS: -18,              // 이 값 이하만 처리
  TARGET_LUFS: -16,                 // 목표 라우드니스
  TRUE_PEAK: -1.5,                  // True Peak 상한
  LRA: 11,                          // Loudness Range
  TEMP_DIR: '/tmp/normalize-work',
  // R2 내 처리 대상 prefix (빈 문자열이면 전체)
  TARGET_PREFIX: '',
  // dry-run 모드 (true면 측정만 하고 업로드 안 함)
  DRY_RUN: false,
};
```

### 3.3 CLI 인터페이스

```bash
# 전체 버킷 처리
node normalize-r2-audio.js

# 특정 prefix만 처리
node normalize-r2-audio.js --prefix openroom/files/

# dry-run (측정만, 업로드 안 함)
node normalize-r2-audio.js --dry-run

# dry-run + 특정 prefix
node normalize-r2-audio.js --dry-run --prefix channel3/
```

커맨드라인 인자 파싱은 `process.argv` 직접 파싱으로 충분하다. 외부 라이브러리 불필요.

### 3.4 리포트 출력

처리 완료 후 콘솔에 요약 리포트를 출력한다.

```
═══════════════════════════════════════════════════
  R2 Audio Loudness Normalization Report
═══════════════════════════════════════════════════
  Total files scanned:  142
  Skipped (above -18):  98
  Boosted:              39
  Errors:                5
═══════════════════════════════════════════════════

  Boosted files:
  ──────────────────────────────────────────────
  openroom/files/song1.mp3    -26.3 → -16.0 LUFS
  openroom/files/song2.m4a    -22.1 → -16.0 LUFS
  channel3/hymn01.mp3         -31.5 → -16.0 LUFS
  ...

  Errors:
  ──────────────────────────────────────────────
  openroom/files/corrupt.mp3  FFmpeg parse error
  ...
```

---

## 4. 에러 처리

| 상황 | 처리 |
|------|------|
| FFmpeg 미설치 | 스크립트 시작 시 `ffmpeg -version` 체크, 없으면 안내 메시지 출력 후 종료 |
| wrangler 미설치/미인증 | 스크립트 시작 시 `wrangler whoami` 체크 |
| FFmpeg JSON 파싱 실패 | 해당 파일 스킵, 에러 리포트에 기록, 다음 파일 계속 처리 |
| R2 업로드 실패 | 3회 재시도 후 실패 시 에러 리포트에 기록, 다음 파일 계속 처리 |
| 디스크 공간 부족 | 각 파일 처리 후 즉시 임시 파일 삭제, 한 번에 하나씩만 처리 |

---

## 5. 의존성

```json
{
  "dependencies": {}
}
```

- **외부 npm 패키지 없음**. Node.js 내장 모듈(`child_process`, `fs`, `path`, `os`)만 사용한다.
- **시스템 요구사항**: FFmpeg (4.x 이상), wrangler CLI (인증 완료 상태)

---

## 6. 절대 금지 사항

1. **볼륨이 -18 LUFS 이상인 파일을 수정하지 말 것** — 이것이 이 스크립트의 핵심 원칙이다.
2. **원본 파일의 포맷(확장자)을 변경하지 말 것** — .m4a를 .mp3로 바꾸는 등의 변환 금지.
3. **index.html을 수정하지 말 것** — 이 스크립트는 완전히 독립적인 유틸리티다.
4. **R2 키(경로)를 변경하지 말 것** — 업로드 시 원본과 동일한 키에 덮어쓴다.
5. **동시 처리(병렬 다운로드/업로드)를 하지 말 것** — 순차 처리로 디스크/네트워크 안정성 확보.
6. **외부 npm 패키지를 추가하지 말 것** — Node.js 내장 모듈만 사용.
