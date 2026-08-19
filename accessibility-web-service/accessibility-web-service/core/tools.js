// 확장 프로그램(sidepanel.js)과 동일한 도구 정의입니다.
// 실제 실행 방식(Playwright vs chrome.scripting)만 executors.js에서 다릅니다.

const MAX_TURNS = 8;

const TOOLS = [
  {
    name: 'axe_scan',
    description:
      '현재 페이지 전체(또는 특정 CSS 선택자 범위)에 대해 axe-core 접근성 검사를 실행합니다. 위반 항목 목록(id, impact, description, help, nodes)을 반환합니다.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '검사 범위를 좁힐 CSS 선택자. 생략하면 문서 전체를 검사합니다.',
        },
        runOnly: {
          type: 'array',
          items: { type: 'string' },
          description: "특정 axe rule id만 실행하고 싶을 때 지정 (예: ['color-contrast']).",
        },
      },
    },
  },
  {
    name: 'inspect_element',
    description:
      '지정한 CSS 선택자에 해당하는 요소의 outerHTML, 속성, 주요 계산 스타일(color, background-color, font-size, font-weight), 크기를 반환합니다.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
    },
  },
  {
    name: 'compute_contrast',
    description: '두 색상(hex 또는 rgb 문자열)의 WCAG 명도 대비(contrast ratio)를 계산합니다.',
    input_schema: {
      type: 'object',
      properties: {
        foreground: { type: 'string' },
        background: { type: 'string' },
      },
      required: ['foreground', 'background'],
    },
  },
  {
    name: 'verify_fix',
    description:
      "제안한 수정안을 페이지에 '임시로' 적용한 뒤 해당 axe rule만 재검사하고, 검사가 끝나면 즉시 원래 상태로 되돌립니다. 실제 페이지나 코드에는 영구적인 변경을 남기지 않습니다. 확신이 있는 수정안은 반드시 이 도구로 검증한 뒤 보고서에 포함하세요.",
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        ruleId: { type: 'string', description: '재검사할 axe rule id' },
        attributes: {
          type: 'object',
          description: "임시로 적용할 속성 key-value (예: {\"alt\": \"로그인 버튼\"})",
        },
        styles: {
          type: 'object',
          description: '임시로 적용할 인라인 스타일 key-value',
        },
      },
      required: ['selector', 'ruleId'],
    },
  },
  {
    name: 'check_cache',
    description:
      '이 도구를 사용해 이 사이트(도메인)에서 이 axe rule에 대한 설명을 예전에 이미 작성해 저장해둔 적이 있는지 확인하세요. 있다면(cached: true) 그 설명을 그대로 재사용하고 다시 작성하지 마세요.',
    input_schema: {
      type: 'object',
      properties: { ruleId: { type: 'string' } },
      required: ['ruleId'],
    },
  },
  {
    name: 'save_explanation_cache',
    description:
      '새로 작성한 설명(title, kwcagRef, explanation, howToFix)을 이 사이트(도메인)의 이 axe rule에 대한 캐시로 저장합니다.',
    input_schema: {
      type: 'object',
      properties: {
        ruleId: { type: 'string' },
        title: { type: 'string' },
        kwcagRef: { type: 'string' },
        explanation: { type: 'string' },
        howToFix: { type: 'string' },
      },
      required: ['ruleId', 'title', 'explanation', 'howToFix'],
    },
  },
  {
    name: 'finish_report',
    description:
      '검사와 (가능한 경우) 검증이 끝나면 이 도구를 호출해 최종 보고서를 제출하세요. 이 호출 이후에는 다른 도구를 호출하지 않습니다.',
    input_schema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ruleId: { type: 'string' },
              title: { type: 'string' },
              severity: { type: 'string', enum: ['critical', 'serious', 'moderate', 'minor'] },
              kwcagRef: { type: 'string' },
              selector: { type: 'string' },
              explanation: { type: 'string' },
              howToFix: { type: 'string' },
              verified: {
                type: 'boolean',
                description: 'verify_fix 도구로 실제 해결을 확인했는지 여부',
              },
            },
            required: ['ruleId', 'title', 'severity', 'explanation', 'howToFix'],
          },
        },
      },
      required: ['findings'],
    },
  },
];

const AGENT_SYSTEM_PROMPT = `당신은 한국 웹 접근성(KWCAG 2.1) 진단 에이전트입니다.
주어진 도구를 사용해 지금 열려 있는 웹페이지(사용자가 입력한 URL)를 스스로 조사하고, 발견한 문제를 검증한 뒤 최종 보고서를 제출하세요.

작업 방식:
1. axe_scan으로 전체 페이지를 검사해 위반 항목을 찾으세요.
2. 위반 항목마다 먼저 check_cache(ruleId)를 호출해 이 사이트에서 이미 작성해둔 설명이 있는지 확인하세요.
   - 캐시가 있으면(cached: true) 그 title/kwcagRef/explanation/howToFix를 그대로 재사용하세요. 다시 작성하지 마세요.
   - 캐시가 없으면 새로 작성한 뒤, save_explanation_cache로 저장해 다음에 재사용할 수 있게 하세요.
3. 색상 대비 관련 위반(새로 등장한 요소라면)은 inspect_element로 실제 색상 값을 확인하고 compute_contrast로 직접 계산해 심각도를 재확인하세요.
4. 중요도가 critical 또는 serious인 항목 중 최소 1건 이상은 verify_fix로 수정안이 실제로 통하는지 검증하세요.
   (alt 속성 추가, aria-label 추가, 색상 값 변경 등 간단히 속성/스타일로 재현 가능한 경우에 한함)
   주의: verify_fix는 캐시된 설명이 있어도 반드시 이 페이지에서 새로 실행하세요. 검증 결과는 캐시하지 않습니다.
5. 확인이 끝나면 finish_report를 호출해 각 위반 항목마다 다음을 한국어로 작성하세요.
   - title: 짧은 제목
   - kwcagRef: 관련 KWCAG 2.1 원칙명 (정확히 대응 안 되면 "관련 원칙: ..." 형태로 근접 원칙 표기)
   - explanation: 스크린리더/키보드 사용자 등에게 왜 문제가 되는지 (2~3문장)
   - howToFix: 코드 스니펫 없이 자연어로 구체적인 수정 방법 (2~4문장)
   - verified: verify_fix로 검증했다면 true

주의: 최대 ${MAX_TURNS}번의 도구 호출 턴 안에 반드시 finish_report를 호출해 마무리하세요. 실제 페이지를 영구적으로 수정하지 마세요(verify_fix는 자동으로 원복됩니다).`;

module.exports = { TOOLS, AGENT_SYSTEM_PROMPT, MAX_TURNS };
