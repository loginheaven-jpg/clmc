# VOLUME-BOOST-SLIDER.md
## 볼륨 슬라이더 150% 확장 — Claude Code 개발가이드

> **목적**: 기존 볼륨 슬라이더의 범위를 100%에서 150%까지 확장하여, 사용자가 볼륨이 작다고 느낄 때 스스로 부스트할 수 있게 한다.  
> **핵심 원칙**: 100% 이하는 기존 동작 완전 유지. 100% 초과 구간만 새로 추가한다.  
> **작업 범위**: `index.html` 내 볼륨 슬라이더 관련 코드만 수정  
> **대상 파일**: `index.html` (단일 파일)

---

## 1. 개요

현재 앱의 볼륨 슬라이더는 0~100% 범위다. 서버 음원 중 볼륨이 작은 파일이 있어 최대로 올려도 소리가 불충분한 경우가 발생한다. 슬라이더 범위를 150%까지 확장하고, 100% 초과 구간에서는 Web Audio API GainNode + DynamicsCompressor를 사용하여 안전하게 증폭한다.

### 동작 구조

```
슬라이더 0~100%:
  Howler.volume(0 ~ 1.0)  ← 기존과 100% 동일

슬라이더 100~150%:
  Howler.volume(1.0)  ← 항상 1.0 고정
  + GainNode.gain.value = 1.0 ~ 2.5  ← 실제 증폭
  + DynamicsCompressorNode ← 클리핑 방지
```

---

## 2. 기술 사양

### 2.1 볼륨 매핑 공식

```javascript
function applyVolume(sliderPercent) {
  // sliderPercent: 0 ~ 150 (슬라이더 값)
  
  if (sliderPercent <= 100) {
    // === 일반 구간: 기존과 동일 ===
    const howlerVol = sliderPercent / 100;  // 0.0 ~ 1.0
    Howler.volume(howlerVol);
    
    // 부스트 체인이 활성화되어 있으면 gain을 1.0으로 리셋
    if (boostGainNode) {
      boostGainNode.gain.value = 1.0;
    }
    
  } else {
    // === 부스트 구간: 100% 초과 ===
    Howler.volume(1.0);  // Howler는 최대로 고정
    
    // 100~150 → gain 1.0~2.5 (선형 매핑)
    const boostRatio = (sliderPercent - 100) / 50;  // 0.0 ~ 1.0
    const gainValue = 1.0 + (boostRatio * 1.5);     // 1.0 ~ 2.5
    
    ensureBoostChain();  // 부스트 오디오 체인 초기화 (lazy)
    boostGainNode.gain.value = gainValue;
  }
}
```

### 2.2 Web Audio 부스트 체인

부스트 구간 진입 시 **한 번만** 생성하고 이후 재사용한다. (lazy initialization)

```javascript
let boostGainNode = null;
let boostCompressor = null;

function ensureBoostChain() {
  if (boostGainNode) return;  // 이미 생성됨
  
  const ctx = Howler.ctx;
  
  // 1. DynamicsCompressor 생성 (클리핑 방지)
  boostCompressor = ctx.createDynamicsCompressor();
  boostCompressor.threshold.setValueAtTime(-24, ctx.currentTime);
  boostCompressor.knee.setValueAtTime(30, ctx.currentTime);
  boostCompressor.ratio.setValueAtTime(4, ctx.currentTime);
  boostCompressor.attack.setValueAtTime(0.003, ctx.currentTime);
  boostCompressor.release.setValueAtTime(0.25, ctx.currentTime);
  
  // 2. GainNode 생성
  boostGainNode = ctx.createGain();
  boostGainNode.gain.setValueAtTime(1.0, ctx.currentTime);
  
  // 3. 체인 연결: Howler.masterGain → GainNode → Compressor → destination
  //    Howler의 기존 연결을 끊고 새 체인을 삽입한다.
  Howler.masterGain.disconnect();
  Howler.masterGain.connect(boostGainNode);
  boostGainNode.connect(boostCompressor);
  boostCompressor.connect(ctx.destination);
}
```

#### 체인 구조도

```
[기존]
  Howler.masterGain ─────────────────────→ ctx.destination

[부스트 체인 삽입 후]
  Howler.masterGain → GainNode(1.0~2.5) → Compressor → ctx.destination
```

#### 중요: Howler.masterGain 접근

- `Howler.masterGain`은 Howler.js가 내부적으로 생성하는 마스터 GainNode이다.
- Howler.js 소스에서 `Howler._muted`, `Howler.volume()` 등이 이 노드를 제어한다.
- **확인 필요**: 현재 index.html에서 사용 중인 Howler.js 버전에서 `Howler.masterGain`이 접근 가능한지 확인할 것. 접근 불가 시 `Howler._audioNode` 또는 유사한 내부 프로퍼티를 탐색하여 사용.
- 만약 Howler 내부 노드 접근이 불가능하면, **대안**: 각 Sound 객체의 `_node`에 개별 GainNode를 연결하는 방식으로 전환. (이 경우 구현이 복잡해지므로, 먼저 `Howler.masterGain` 접근 가능 여부를 확인하는 것이 우선)

---

## 3. UI 수정 사항

### 3.1 슬라이더 HTML

기존 슬라이더의 `max` 속성을 변경한다.

```
변경 전: <input type="range" min="0" max="100" ...>
변경 후: <input type="range" min="0" max="150" ...>
```

- `step` 값은 기존 유지 (1 단위)
- `id`, `class` 등 기존 속성은 변경하지 않는다.

### 3.2 슬라이더 시각적 피드백

100% 초과 시 사용자에게 "부스트 구간"임을 시각적으로 알린다.

#### 3.2.1 슬라이더 트랙 색상 변화

```css
/* 슬라이더 값에 따라 동적으로 적용 (JavaScript로 class 토글) */

/* 일반 구간 (0~100%) — 기존 스타일 유지 */
.volume-slider { }

/* 부스트 구간 (100% 초과) */
.volume-slider.boost-active {
  /* 트랙의 100% 초과 영역을 주황~빨간 계열 그라데이션으로 표시 */
  /* 정확한 색상은 기존 앱 테마에 맞춰 조정 */
}
```

#### 3.2.2 볼륨 퍼센트 표시

슬라이더 근처에 현재 볼륨 퍼센트를 텍스트로 표시한다.

```
일반 구간:   "80%"   (흰색 또는 기존 색상)
부스트 구간: "130%"  (주황색 계열, 볼드)
```

#### 3.2.3 부스트 아이콘 (선택사항)

100% 초과 시 슬라이더 옆에 작은 부스트 아이콘(🔊+ 또는 스피커에 + 표시)을 표시한다.  
구현이 복잡하면 생략해도 된다. 퍼센트 텍스트 색상 변화만으로 충분하다.

### 3.3 슬라이더 기본값

- **앱 시작 시 기본값**: 기존과 동일 (100% 또는 기존 저장된 값)
- **localStorage 저장**: 슬라이더 값을 0~150 범위로 저장/복원. 기존 저장값이 0~100이면 그대로 호환된다.

---

## 4. 수정 대상 코드 영역

`index.html` 내에서 수정이 필요한 부분:

### 4.1 수정할 것

| 영역 | 수정 내용 |
|------|----------|
| 볼륨 슬라이더 HTML (`<input type="range">`) | `max="100"` → `max="150"` |
| 볼륨 변경 이벤트 핸들러 | `applyVolume()` 함수 추가/수정, 100% 초과 분기 처리 |
| 볼륨 표시 텍스트 (있는 경우) | 150%까지 표시 가능하도록 수정 |
| CSS | `.boost-active` 클래스 스타일 추가 |
| 앱 초기화 코드 | `ensureBoostChain()` 함수 추가, localStorage 호환성 처리 |

### 4.2 수정하지 않을 것

| 영역 | 이유 |
|------|------|
| Howler.js 라이브러리 코드 | 라이브러리 수정 금지 |
| 오디오 재생 로직 (play/pause/stop) | 볼륨 제어만 변경 |
| 채널 전환 로직 | 무관 |
| HLS/스트리밍 관련 코드 | 무관 |
| Service Worker | 무관 |

---

## 5. 엣지 케이스 처리

### 5.1 AudioContext 미초기화 상태

부스트 구간 진입 시 `Howler.ctx`가 아직 생성되지 않았을 수 있다. (사용자가 아직 아무 오디오도 재생하지 않은 경우)

```javascript
function ensureBoostChain() {
  if (boostGainNode) return;
  
  const ctx = Howler.ctx;
  if (!ctx) {
    // AudioContext 아직 없음 → 부스트 체인 생성 보류
    // 슬라이더 값만 저장해두고, 첫 재생 시점에 체인을 생성한다
    return;
  }
  // ... 체인 생성
}
```

첫 재생 시점(play 이벤트)에서 현재 슬라이더 값이 100% 초과면 `ensureBoostChain()`을 재호출한다.

### 5.2 채널 전환 시

채널 전환으로 Howler 인스턴스가 새로 생성되어도, 부스트 체인은 `Howler.masterGain` 레벨에 걸려 있으므로 영향받지 않는다.  
단, Howler가 완전히 재초기화(unload 후 재생성)되는 경우 부스트 체인이 끊어질 수 있다.

**대응**: 재생 시작 시점마다 부스트 체인 연결 상태를 확인한다.

```javascript
function onPlayStart() {
  // 기존 재생 시작 로직...
  
  // 부스트 체인 연결 확인
  if (getCurrentSliderValue() > 100) {
    ensureBoostChain();
    applyVolume(getCurrentSliderValue());
  }
}
```

### 5.3 뮤트 상태에서 부스트

뮤트(음소거) 상태에서 슬라이더를 150%로 올린 뒤 뮤트 해제 시, 갑자기 큰 소리가 나올 수 있다.

**대응**: 뮤트 해제 시 GainNode 값을 `setValueAtTime`이 아닌 `linearRampToValueAtTime`으로 0.1초에 걸쳐 페이드인한다.

```javascript
function unmuteWithBoost() {
  if (boostGainNode && getCurrentSliderValue() > 100) {
    const ctx = Howler.ctx;
    boostGainNode.gain.setValueAtTime(1.0, ctx.currentTime);
    const targetGain = getGainFromSlider(getCurrentSliderValue());
    boostGainNode.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + 0.1);
  }
}
```

### 5.4 Web Audio API 미지원 브라우저

극히 드문 경우이나, Web Audio API를 지원하지 않는 환경에서는 100% 초과 부스트가 불가능하다.

**대응**: 슬라이더 max를 100으로 제한하고, 부스트 UI를 숨긴다. (graceful degradation)

---

## 6. DynamicsCompressor 파라미터 설명

| 파라미터 | 값 | 역할 |
|---------|-----|------|
| threshold | -24 dB | 이 레벨 이상의 신호에 압축 적용 |
| knee | 30 dB | 부드러운 압축 전환 (하드 클리핑 방지) |
| ratio | 4:1 | 압축 비율 (4dB 초과 시 1dB만 통과) |
| attack | 0.003초 | 압축 시작 반응 속도 |
| release | 0.25초 | 압축 해제 속도 |

이 설정은 음악 소스에 적합한 범용 값이다. 말씀/설교 채널에서도 동일하게 작동한다.

---

## 7. 테스트 시나리오

| # | 시나리오 | 기대 결과 |
|---|---------|----------|
| 1 | 슬라이더 0~100% 조작 | 기존과 완전히 동일하게 동작 |
| 2 | 슬라이더 100% → 130% 올림 | 소리가 점진적으로 커짐, 찌그러짐 없음 |
| 3 | 슬라이더 150%에서 채널 전환 | 전환 후에도 150% 부스트 유지 |
| 4 | 슬라이더 130% → 80%로 내림 | 부스트 해제, 일반 볼륨으로 정상 복귀 |
| 5 | 150%로 설정 후 앱 새로고침 | localStorage에서 150% 복원, 부스트 정상 동작 |
| 6 | 뮤트 → 슬라이더 150% → 뮤트 해제 | 급격한 볼륨 점프 없이 부드러운 페이드인 |
| 7 | 재생 없이 슬라이더 150% 설정 후 재생 시작 | 첫 재생 시 부스트 정상 적용 |

---

## 8. 절대 금지 사항

1. **0~100% 구간의 기존 볼륨 동작을 변경하지 말 것** — 이 구간은 기존과 100% 동일해야 한다.
2. **Howler.js 라이브러리 파일을 수정하지 말 것** — 외부 라이브러리는 손대지 않는다.
3. **오디오 재생/정지/채널전환 로직을 수정하지 말 것** — 볼륨 제어 코드만 수정한다.
4. **Service Worker 코드를 수정하지 말 것** — 무관한 영역이다.
5. **부스트 체인을 앱 시작 시 무조건 생성하지 말 것** — lazy initialization 필수. AudioContext가 준비되기 전에 생성하면 에러 발생.
6. **DynamicsCompressor 없이 GainNode만 사용하지 말 것** — 반드시 Compressor를 거쳐야 클리핑이 방지된다.
7. **슬라이더 max를 150 초과로 설정하지 말 것** — 2.5배 이상 증폭은 음질 열화가 심하다.
