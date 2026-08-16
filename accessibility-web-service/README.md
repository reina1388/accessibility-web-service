# 웹 접근성 검증 AI Agent — 웹 서비스판

URL을 입력하면 서버가 헤드리스 브라우저(Playwright)로 그 페이지를 직접 열어서,
AI 에이전트(Claude/Gemini/OpenAI 중 선택)가 axe-core로 검사 → 캐시 확인 → 색상 대비 계산 →
수정안 검증까지 자율적으로 수행한 뒤 결과를 보여주는 웹 서비스입니다.

Chrome 확장 프로그램판과 **핵심 로직(도구 정의/AI 어댑터/에이전트 루프)을 그대로 공유**하고,
"페이지에 접근하는 방식"만 다릅니다 (확장: `chrome.scripting` / 웹서비스: Playwright).

## 아키텍처

```
[방문자] URL + 공급자 + API 키 입력 → "검사하기"
        │  POST /api/check (스트리밍 응답)
        ▼
[server.js] Playwright로 헤드리스 브라우저 실행 → 입력받은 URL로 이동
        │
        ▼
[core/agentLoop.js] 공급자 어댑터(core/adapters.js) 호출
        │  Claude tool_use / Gemini functionCall / OpenAI tool_calls
        │  → core/executors.js가 page.evaluate()로 axe_scan/inspect_element/
        │     verify_fix 실행 (확장 프로그램의 background.js 역할)
        │  → core/cache.js가 규칙+도메인 단위 설명 캐시 (서버 메모리, 방문자 공유)
        ▼
[server.js] 진행상황을 줄바꿈 JSON(ndjson)으로 실시간 스트리밍
        ▼
[public/app.js] 스트림을 읽어 활동 로그 실시간 표시 + 최종 결과 카드 렌더링
```

## 파일 구조

```
accessibility-web-service/
├── server.js              # Express 서버, /api/check 라우트
├── core/
│   ├── tools.js            # 도구 정의 + 시스템 프롬프트 (확장 프로그램과 동일)
│   ├── adapters.js         # Claude/Gemini/OpenAI 어댑터 (확장 프로그램과 동일)
│   ├── agentLoop.js         # 에이전트 루프 (공급자 무관, onStep으로 진행상황 콜백)
│   ├── executors.js         # ★ Playwright 기반 도구 실행 (background.js를 대체)
│   └── cache.js             # 서버 메모리 캐시 (규칙+도메인 단위)
├── public/
│   ├── index.html           # URL 입력 폼 + 결과 화면
│   ├── style.css
│   └── app.js                # 폼 처리, 스트림 파싱, 결과 렌더링
└── package.json
```

## 로컬 실행

```bash
npm install          # express, playwright, axe-core 설치
                      # (postinstall이 자동으로 playwright install --with-deps chromium 실행)
npm run check         # 모든 파일 문법 검사
npm start             # http://localhost:3000
```

브라우저에서 `http://localhost:3000` 접속 → URL, 공급자, API 키 입력 → "검사하기".

## Railway 배포

1. Railway 프로젝트 생성 후 이 폴더를 배포 (Git 연결 또는 `railway up`)
2. Railway는 Nixpacks로 자동으로 `npm install` → `npm start`를 실행합니다.
3. `postinstall`에서 Playwright의 Chromium 브라우저를 함께 설치하므로 별도 설정 없이 동작해야 합니다.
   (빌드 시간이 평소보다 오래 걸릴 수 있어요 — 브라우저 바이너리를 받기 때문입니다.)
4. 배포가 끝나면 Railway가 `*.up.railway.app` 형태의 실제 접속 URL을 줍니다. 이 URL이 사람들이 접속해서 쓰는 주소입니다.

## 확장 프로그램판과의 차이

| 항목 | 확장 프로그램 | 웹 서비스 |
|---|---|---|
| 검사 대상 | 지금 보고 있는 탭 (로그인 상태 포함) | 입력한 URL (비로그인 상태로 새로 열림) |
| 페이지 접근 방식 | `chrome.scripting` (브라우저 권한) | Playwright 헤드리스 브라우저 |
| 캐시 범위 | 각자의 브라우저(chrome.storage.local) | 서버 전체가 공유 (메모리, 재시작 시 초기화) |
| "위치 표시" 기능 | 있음 (실제 탭에 하이라이트) | 없음 (원격 헤드리스 브라우저라 상호작용 불가) |
| 감사 보고서(PDF) | 있음 | 아직 없음 (필요하면 추가 가능) |
| API 키 저장 | chrome.storage.local | 브라우저 localStorage (서버엔 저장 안 함) |

## 알아두어야 할 점

- **로그인이 필요한 페이지는 검사 못 합니다.** 헤드리스 브라우저는 매번 비로그인 상태로 새로 열리기 때문에, 로그인 뒤의 화면(마이페이지 등)은 확인할 수 없습니다. 이건 확장 프로그램판에는 없는 제약입니다.
- **서버 캐시는 모든 방문자가 공유합니다.** 개인정보가 아니라 "규칙 설명 텍스트"만 저장하지만, 여러 명이 쓰는 공개 서비스로 운영할 계획이면 이 점을 안내하거나 방문자별로 분리하는 걸 고려하세요.
- **API 키를 서버에 저장하지 않습니다.** 요청마다 브라우저가 서버로 전달하고, 서버는 그 요청을 처리하는 동안만 메모리에 들고 있다가 응답 후 버립니다. 다만 이 서비스를 여러 사람이 쓰는 공개 사이트로 운영한다면, 각자 API 키를 입력해야 하므로 그 점을 안내 문구로 명확히 하는 게 좋습니다.
- **동시 접속이 많으면 헤드리스 브라우저가 여러 개 뜨면서 서버 메모리를 많이 씁니다.** 개인/소규모 데모용으로는 문제없지만, 트래픽이 커지면 동시 실행 개수를 제한하는 큐(queue) 로직을 추가하는 걸 권장합니다.
