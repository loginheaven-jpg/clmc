# 🔦 플래시(Torch) 기능 구현 가이드

> **대상**: `index.html` (예봄라디오 2.0 단일 파일)  
> **구현자**: Claude Code  
> **목적**: 화면 터치로 스마트폰 후면 카메라 플래시를 ON/OFF 토글하는 기능

---

## 1. 기술 개요

### 원리
- `navigator.mediaDevices.getUserMedia()`로 후면 카메라 스트림을 열고
- `videoTrack.applyConstraints({ advanced: [{ torch: true }] })`로 플래시 점등
- `track.stop()`으로 플래시 소등 및 스트림 해제

### 브라우저 지원
| 환경 | 지원 |
|------|------|
| Chrome Android 58+ | ✅ |
| Samsung Internet | ✅ |
| Android WebView (예봄알람) | ✅ |
| iOS Safari | ❌ |
| Firefox Android | ❌ |

### 전제 조건
- HTTPS (이미 충족)
- 카메라 권한 (최초 1회 사용자 승인)

---

## 2. UI 배치

### 위치: 상단 헤더 영역

헤더 바의 적절한 위치에 **플래시 아이콘 버튼**을 배치한다.

```
┌─────────────────────────────────────┐
│  ☰  예봄라디오    [🔦]  [⚙]        │  ← 헤더 바
└─────────────────────────────────────┘
```

### 아이콘
- OFF 상태: 🔦 (또는 SVG flashlight 아이콘, 회색 톤)
- ON 상태: 아이콘 활성화 색상 (노란색/금색 계열) + 아이콘 변경 또는 glow 효과

### 요소 구조

```html
<button id="torchBtn" class="torch-btn" onclick="toggleTorch()" 
        style="display:none;" title="플래시">
  <svg id="torchIcon" ...><!-- 플래시 아이콘 SVG --></svg>
</button>
```

- 기본적으로 `display:none` → 기능 감지 후 지원 기기에서만 `display:block`으로 전환
- 비지원 기기(iOS, 데스크탑 등)에서는 버튼 자체가 보이지 않는다

---

## 3. JavaScript 구현

### 3-1. 전역 변수

```javascript
// ── 플래시(Torch) 상태 ──
let torchStream = null;      // MediaStream 참조
let torchTrack = null;       // VideoTrack 참조
let torchOn = false;         // 현재 ON/OFF 상태
let torchTimer = null;       // 자동 꺼짐 타이머 ID
const TORCH_TIMEOUT = 10 * 60 * 1000;  // 10분 (밀리초)
```

### 3-2. 기능 감지 (앱 초기화 시 실행)

```javascript
async function checkTorchSupport() {
  // 모바일 + getUserMedia 지원 여부 1차 필터
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
    const track = stream.getVideoTracks()[0];
    const capabilities = track.getCapabilities ? track.getCapabilities() : {};
    track.stop(); // 감지용 스트림 즉시 해제
    
    if (capabilities.torch) {
      // 지원 확인 → 버튼 표시
      document.getElementById('torchBtn').style.display = '';
    }
  } catch (e) {
    // 권한 거부 또는 카메라 없음 → 버튼 숨김 유지
    console.log('Torch not available:', e.message);
  }
}
```

**호출 위치**: 기존 앱 초기화 함수(DOMContentLoaded 또는 init 계열) 내에서 호출한다.

> ⚠️ **주의**: `checkTorchSupport()`는 카메라 권한 팝업을 유발한다. 
> 권한 팝업이 초기 로딩 때 뜨는 것이 부담스러우면, 아래 **3-2-B 대안**을 사용한다.

### 3-2-B. 대안: 권한 요청 없는 감지

카메라 권한을 초기화 때 요청하지 않고, **모바일 기기이면 일단 버튼을 표시**하되, 
첫 터치 때 실제 권한 요청 + 감지를 수행하는 방식이다.

```javascript
function checkTorchSupportLazy() {
  // 모바일(Android)에서만 버튼을 표시
  const isAndroid = /Android/i.test(navigator.userAgent);
  const hasGetUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  
  if (isAndroid && hasGetUserMedia) {
    document.getElementById('torchBtn').style.display = '';
  }
}
```

이 경우 `toggleTorch()` 내에서 첫 실행 시 torch 지원 여부를 확인하고, 
미지원이면 버튼을 숨기고 안내 토스트를 표시한다.

**→ 이 대안(3-2-B)을 기본 구현으로 채택한다.**

### 3-3. 토글 함수 (핵심)

```javascript
async function toggleTorch() {
  if (torchOn) {
    // ── OFF ──
    stopTorch();
  } else {
    // ── ON ──
    try {
      torchStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      torchTrack = torchStream.getVideoTracks()[0];
      
      // torch 지원 여부 확인 (첫 실행 시)
      const capabilities = torchTrack.getCapabilities ? torchTrack.getCapabilities() : {};
      if (!capabilities.torch) {
        torchTrack.stop();
        torchStream = null;
        torchTrack = null;
        document.getElementById('torchBtn').style.display = 'none';
        showToast('이 기기에서는 플래시를 지원하지 않습니다');
        return;
      }
      
      await torchTrack.applyConstraints({ advanced: [{ torch: true }] });
      torchOn = true;
      updateTorchUI(true);
      
      // 10분 자동 꺼짐 타이머 시작
      clearTimeout(torchTimer);
      torchTimer = setTimeout(() => {
        stopTorch();
        showToast('플래시가 자동으로 꺼졌습니다 (10분)');
      }, TORCH_TIMEOUT);
      
    } catch (e) {
      console.error('Torch error:', e);
      if (e.name === 'NotAllowedError') {
        showToast('카메라 권한이 필요합니다');
      } else {
        showToast('플래시를 켤 수 없습니다');
      }
    }
  }
}
```

### 3-4. 정지 함수

```javascript
function stopTorch() {
  if (torchTrack) {
    torchTrack.stop();
    torchTrack = null;
  }
  if (torchStream) {
    torchStream.getTracks().forEach(t => t.stop());
    torchStream = null;
  }
  torchOn = false;
  clearTimeout(torchTimer);
  torchTimer = null;
  updateTorchUI(false);
}
```

### 3-5. UI 업데이트

```javascript
function updateTorchUI(isOn) {
  const btn = document.getElementById('torchBtn');
  const icon = document.getElementById('torchIcon');
  
  if (isOn) {
    btn.classList.add('torch-active');
    // 아이콘 색상 변경 (SVG fill 또는 class 토글)
  } else {
    btn.classList.remove('torch-active');
  }
}
```

### 3-6. 페이지 이탈 시 정리

```javascript
// 기존 beforeunload 또는 pagehide 핸들러에 추가
window.addEventListener('pagehide', () => {
  if (torchOn) stopTorch();
});

// visibilitychange 에서도 — 백그라운드 진입 시 플래시 끄기 (선택사항)
// 단, 의도적으로 켜둔 것일 수 있으므로 끄지 않는 쪽을 기본으로 한다.
// 필요시 아래 주석을 해제:
// document.addEventListener('visibilitychange', () => {
//   if (document.hidden && torchOn) stopTorch();
// });
```

---

## 4. CSS

```css
/* ── 플래시 버튼 ── */
.torch-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 8px;
  border-radius: 50%;
  transition: background-color 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.torch-btn svg {
  width: 22px;
  height: 22px;
  fill: #aaa;           /* OFF 상태: 회색 */
  transition: fill 0.2s;
}

.torch-btn.torch-active svg {
  fill: #FFD700;         /* ON 상태: 금색 */
  filter: drop-shadow(0 0 6px rgba(255, 215, 0, 0.6));
}

.torch-btn:active {
  background-color: rgba(255, 255, 255, 0.1);
}
```

> **참고**: 실제 색상값은 기존 헤더의 디자인 톤에 맞춰 조정한다.

---

## 5. SVG 아이콘

플래시 아이콘은 간결한 SVG를 인라인으로 사용한다. 아래는 참고용 기본 형태이며, 
기존 UI의 아이콘 스타일에 맞게 조정한다.

```svg
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/>
</svg>
```

> 전구 모양 아이콘이다. flashlight(손전등) 형태를 원하면 path를 교체한다.

---

## 6. 구현 순서 (체크리스트)

1. [ ] 전역 변수 4개 추가 (`torchStream`, `torchTrack`, `torchOn`, `torchTimer`, `TORCH_TIMEOUT`)
2. [ ] HTML: 헤더 영역에 `torchBtn` 버튼 + SVG 아이콘 삽입
3. [ ] CSS: `.torch-btn`, `.torch-active` 스타일 추가
4. [ ] JS: `checkTorchSupportLazy()` 함수 추가 → 기존 init에서 호출
5. [ ] JS: `toggleTorch()` 함수 추가
6. [ ] JS: `stopTorch()` 함수 추가
7. [ ] JS: `updateTorchUI()` 함수 추가
8. [ ] JS: `pagehide` 이벤트에 `stopTorch()` 연결
9. [ ] 테스트: Android Chrome에서 ON/OFF 토글, 10분 타이머, 권한 거부 시나리오

---

## 7. 절대 금지 사항 🚫

1. **기존 오디오 재생 코드를 수정하지 말 것** — Howler.js, HLS.js, AudioContext, Service Worker 등 일체 변경 금지
2. **기존 CSS 클래스/변수를 변경하지 말 것** — 새로운 `.torch-*` 클래스만 추가
3. **기존 이벤트 핸들러를 교체하지 말 것** — `pagehide`에 추가만 한다 (기존 핸들러 유지)
4. **iOS/데스크탑에서 에러를 발생시키지 말 것** — 반드시 기능 감지 후 조건부 실행
5. **카메라 스트림을 화면에 렌더링하지 말 것** — `<video>` 요소에 연결 불필요, 스트림은 torch 제어용으로만 사용
6. **외부 라이브러리를 추가하지 말 것** — 순수 Web API만 사용
7. **기존 `showToast()` 함수가 없으면 간단한 것을 만들되**, 이미 존재하면 그것을 사용한다

---

## 8. 참고: showToast 없을 경우

기존 코드에 토스트 알림 함수가 없다면, 아래 최소 구현을 추가한다.

```javascript
function showToast(msg, duration = 3000) {
  let toast = document.getElementById('toastMsg');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toastMsg';
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
      'background:rgba(0,0,0,0.8);color:#fff;padding:10px 20px;border-radius:20px;' +
      'font-size:14px;z-index:10000;transition:opacity 0.3s;pointer-events:none;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, duration);
}
```

---

## 9. 에지 케이스 처리

| 상황 | 처리 |
|------|------|
| 다른 앱이 카메라 점유 중 | `getUserMedia` catch → 토스트 "카메라를 사용할 수 없습니다" |
| 플래시 ON 중 페이지 새로고침 | `pagehide`에서 `stopTorch()` 호출로 정리 |
| 플래시 ON 중 전화 수신 | OS가 카메라 스트림을 중단 → `track.onended` 이벤트로 감지 가능 |
| 10분 타이머 만료 | 자동 OFF + 토스트 안내 |
| 권한 "이번만 허용" 선택 | 매 토글마다 `getUserMedia`를 새로 호출하므로 문제없음 |

### track.onended 처리 (권장)

```javascript
// toggleTorch() 내 torch ON 성공 직후에 추가:
torchTrack.onended = () => {
  // OS 또는 다른 앱이 카메라를 강제 해제한 경우
  torchOn = false;
  clearTimeout(torchTimer);
  torchTimer = null;
  updateTorchUI(false);
};
```

---

*문서 버전: v1.0 — 2026-03-21*
