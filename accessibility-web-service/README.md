# 웹 접근성 검증 AI Agent — 웹 서비스판

URL을 입력하면 서버가 헤드리스 브라우저(Playwright)로 그 페이지를 직접 열어서,
AI 에이전트(Claude/Gemini/OpenAI 중 관리자가 설정한 공급자)가 axe-core로 검사 → 캐시 확인 →
색상 대비 계산 → 수정안 검증까지 자율적으로 수행한 뒤, 문제 위치 스크린샷과 함께 결과를 보여주는
웹 서비스입니다.

Chrome 확장 프로그램판과 **핵심 로직(도구 정의/AI 어댑터/에이전트 루프)을 그대로 공유**하고,
"페이지에 접근하는 방식"만 다릅니다 (확장: `chrome.scripting` / 웹서비스: Playwright).

방문자 화면은 **관리자가 `/admin.html`에서 정한 운영 모드**에 따라 자동으로 달라집니다.

- **관리자 키 모드**: 방문자는 URL만 입력하면 됩니다. 관리자가 등록한 공급자/모델/API 키로 검사하고,
  비용은 관리자에게 청구됩니다.
- **방문자 직접 입력 모드**: 방문자가 자기 공급자/모델/API 키를 반드시 입력해야 검사할 수 있습니다.
  관리자에게 비용이 청구되지 않습니다.

모드 전환은 관리자가 언제든 `/admin.html`에서 바꿀 수 있고, 방문자 화면은 접속 시 자동으로 해당
모드에 맞는 화면을 보여줍니다 (방문자가 직접 고르는 게 아닙니다).

## 아키텍처

```
[방문자] URL만 입력 → "검사하기"
        │  POST /api/check (스트리밍 응답)
        ▼
[server.js] 관리자가 설정한 공급자/모델/API 키를 서버 메모리에서 꺼내 사용
        │  Playwright로 헤드리스 브라우저 실행 → 입력받은 URL로 이동
        ▼
[core/agentLoop.js] 공급자 어댑터(core/adapters.js) 호출
        │  Claude tool_use / Gemini functionCall / OpenAI tool_calls
        │  → core/executors.js가 page.evaluate()로 axe_scan/inspect_element/
        │     verify_fix 실행 + 문제 요소 스크린샷 캡처
        │  → core/cache.js가 규칙+도메인 단위 설명 캐시 (서버 메모리, 방문자 공유)
        ▼
[server.js] 진행상황을 줄바꿈 JSON(ndjson)으로 실시간 스트리밍
        ▼
[public/app.js] 스트림을 읽어 활동 로그 실시간 표시 + 최종 결과 카드(스크린샷 포함) 렌더링


[관리자] /admin.html → 비밀번호 로그인 → 공급자/모델/API 키 설정
        │  POST /api/admin/login, GET·POST /api/admin/config (Bearer 토큰 인증)
        ▼
[core/serverConfig.js] 서버 메모리에 저장 (재시작 시 초기화 — 아래 환경변수로 보완)
[core/adminAuth.js]    비밀번호 검증 + 세션 토큰 발급/검증 (2시간 유지)
```

## 파일 구조

```
accessibility-web-service/
├── server.js               # Express 서버, /api/check, /api/admin/* 라우트
├── Dockerfile               # Playwright 공식 이미지 기반 (Render Docker 배포용)
├── core/
│   ├── tools.js              # 도구 정의 + 시스템 프롬프트 (확장 프로그램과 동일)
│   ├── adapters.js           # Claude/Gemini/OpenAI 어댑터 (확장 프로그램과 동일)
│   ├── agentLoop.js           # 에이전트 루프 (토큰 사용량 체크포인트 포함, 내부 운영값)
│   ├── executors.js           # Playwright 기반 도구 실행 + 요소 스크린샷 캡처
│   ├── cache.js               # 서버 메모리 설명 캐시 (규칙+도메인 단위)
│   ├── serverConfig.js        # ★ 공급자/모델/API 키 서버 공용 설정
│   ├── adminAuth.js           # ★ 관리자 비밀번호 로그인 + 세션 토큰
│   └── rateLimit.js           # ★ IP별 시간당 요청 횟수 제한 (남용 방지)
├── public/
│   ├── index.html             # 방문자 화면 — URL 입력만 있음
│   ├── admin.html              # ★ 관리자 화면 — 로그인 + 설정
│   ├── admin.js
│   ├── style.css
│   └── app.js
└── package.json
```

## 환경변수 (Render에서 반드시/선택적으로 설정)

| 변수 | 필수 여부 | 설명 |
|---|---|---|
| `ADMIN_PASSWORD` | **필수** | `/admin.html` 로그인 비밀번호. 설정 안 하면 관리자 기능 전체가 잠깁니다. |
| `DEFAULT_MODE` | 선택 | 서버 시작 시 기본 운영 모드 (`admin`/`visitor`). 기본값 `admin`. |
| `DEFAULT_PROVIDER` | 선택 | 서버 시작 시 기본 공급자 (`gemini`/`claude`/`openai`). 기본값 `gemini`. |
| `DEFAULT_MODEL` | 선택 | 서버 시작 시 기본 모델. |
| `DEFAULT_API_KEY` | 선택 (강력 추천, admin 모드일 때) | 서버 시작 시 기본 API 키. **이걸 설정해두면 서버가 재시작돼도 관리자가 다시 로그인해서 키를 넣지 않아도 됩니다.** |

Render 대시보드 → 서비스 선택 → **Environment** 탭에서 추가할 수 있습니다.

## 관리자 사용법

1. `https://내주소.onrender.com/admin.html` 접속 (방문자에게 이 링크를 공유하지 마세요 — 검색엔진 색인도 막아뒀습니다)
2. `ADMIN_PASSWORD`로 로그인
3. **운영 모드**를 선택합니다:
   - **관리자 키 사용**: 아래에 공급자/모델/API 키를 입력 → 저장. 방문자는 URL만 입력하면 됩니다.
   - **방문자 직접 입력**: 아래 공급자/모델은 방문자 화면의 추천 기본값으로만 쓰입니다 (API 키는 안 써도 됨).
     방문자는 반드시 자기 키를 입력해야 검사할 수 있습니다.
4. 저장하면 방문자 화면이 즉시 그 모드에 맞게 바뀝니다 (새로고침 시 반영)

## 로컬 실행

```bash
npm install          # express, playwright, axe-core 설치
                      # (postinstall이 자동으로 playwright install --with-deps chromium 실행)
npm run check         # 모든 파일 문법 검사
ADMIN_PASSWORD=아무거나 npm start   # http://localhost:3000
```

브라우저에서 `http://localhost:3000/admin.html`로 먼저 공급자/키를 설정한 뒤,
`http://localhost:3000`에서 URL만 입력해 테스트하세요.

## Render 배포 (Docker)

1. GitHub 저장소에 이 폴더를 올립니다 (하위 폴더 구조라면 Render의 **Root Directory**에 해당 경로 지정)
2. Render 대시보드 → New + → Web Service → 저장소 연결
3. **Language/Runtime: Docker** 선택 (Dockerfile을 자동 인식합니다)
4. Instance Type: Free (또는 유료 플랜)
5. **Environment** 탭에서 `ADMIN_PASSWORD` (필수), 가능하면 `DEFAULT_API_KEY` 등도 함께 설정
6. Create Web Service → 배포 완료 후 나오는 `https://*.onrender.com` 주소가 실제 접속 URL

## 확장 프로그램판과의 차이

| 항목 | 확장 프로그램 | 웹 서비스 |
|---|---|---|
| 검사 대상 | 지금 보고 있는 탭 (로그인 상태 포함) | 입력한 URL (비로그인 상태로 새로 열림) |
| 페이지 접근 방식 | `chrome.scripting` (브라우저 권한) | Playwright 헤드리스 브라우저 |
| API 키 관리 | 사용자 각자 자기 브라우저에 저장 | **관리자 한 명이 서버에 설정, 전체 방문자가 공용** |
| 비용 부담 | 사용자 각자 | **서버 운영자(관리자)** |
| 캐시 범위 | 각자의 브라우저 | 서버 전체가 공유 (메모리, 재시작 시 초기화) |
| "위치 표시" 기능 | 있음 (실제 탭에 하이라이트) | 스크린샷으로 대체 (원격 헤드리스 브라우저라 실시간 상호작용 불가) |
| 남용 방지 | 필요 없음 (개인용) | IP당 시간당 요청 수 제한 |

## 알아두어야 할 점

- **관리자가 정한 모드에 따라 방문자 화면 자체가 달라집니다** (방문자가 고르는 게 아님).
  관리자 키 모드는 IP당 시간당 5회, 방문자 직접 입력 모드는 시간당 20회로 제한됩니다
  (서버 자원 보호 목적, `core/rateLimit.js`에서 조정 가능).
- **관리자 키 모드에서는 API 키를 서버 운영자 한 명이 부담합니다.**
  방문자가 늘어날수록 그만큼 API 사용료가 관리자에게 청구됩니다. `core/rateLimit.js`에서
  IP당 시간당 요청 수를 제한하고 있지만, 이건 최소한의 안전장치일 뿐 정교한 부정사용
  방지는 아닙니다. 트래픽이 커지면 더 강력한 방어(로그인, CAPTCHA, 더 낮은 한도)를
  추가하는 걸 권장합니다.
- **서버 재시작 시 관리자 설정(API 키 포함)이 초기화됩니다.** 메모리에만 저장하기 때문입니다.
  `DEFAULT_API_KEY` 등 환경변수를 설정해두면 재시작 후에도 자동으로 복구됩니다.
- **관리자 로그인은 2시간 동안 유지**되고, 세션은 서버 메모리에 저장됩니다 (재시작 시 로그아웃됨).
- **로그인이 필요한 페이지는 검사 못 합니다.** 헤드리스 브라우저는 매번 비로그인 상태로 새로 열립니다.
- **`/admin.html`은 링크로 안내하지 않았을 뿐, URL을 알면 누구나 로그인 화면까지는 접근 가능합니다.**
  진짜 보안은 비밀번호에 달려있으니, 추측하기 어려운 값으로 설정하세요.
