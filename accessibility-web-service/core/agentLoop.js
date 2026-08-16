const { ADAPTERS } = require('./adapters');
const { MAX_TURNS } = require('./tools');
const { executeTool } = require('./executors');

function describeToolCall(name, input) {
  switch (name) {
    case 'axe_scan':
      return input.selector
        ? `"${input.selector}" 영역 접근성 검사 중...`
        : '페이지 전체 접근성 검사 중...';
    case 'inspect_element':
      return `"${input.selector}" 요소의 스타일/속성 확인 중...`;
    case 'compute_contrast':
      return `색상 대비 계산 중 (${input.foreground} / ${input.background})...`;
    case 'verify_fix':
      return `"${input.selector}" 수정안 임시 적용 후 검증 중...`;
    case 'check_cache':
      return `"${input.ruleId}" 규칙의 저장된 설명이 있는지 확인 중...`;
    case 'save_explanation_cache':
      return `"${input.ruleId}" 규칙 설명을 이 사이트에 저장 중...`;
    default:
      return `${name} 실행 중...`;
  }
}

// onStep(step)이 있으면 각 도구 호출마다 호출됩니다 (서버가 이걸로 진행상황을 스트리밍).
async function runAgentLoop({ provider, apiKey, model, page, domain, onStep }) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`알 수 없는 공급자: ${provider}`);

  let transcript = [
    {
      role: 'user',
      text: '현재 열려 있는 페이지의 웹 접근성을 도구를 사용해 조사하고, KWCAG 2.1 기준으로 최종 보고서를 작성해줘.',
    },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const result = await adapter.callModel(transcript, apiKey, model);
    transcript.push({ role: 'assistant', text: result.text, toolCalls: result.toolCalls });

    if (!result.toolCalls || result.toolCalls.length === 0) {
      transcript.push({
        role: 'user',
        text: '계속 진행하려면 도구를 호출하거나, 조사가 끝났다면 finish_report 도구로 보고서를 제출해줘.',
      });
      continue;
    }

    const finishCall = result.toolCalls.find((tc) => tc.name === 'finish_report');
    if (finishCall) {
      if (onStep) onStep({ tool: 'finish_report', text: '최종 보고서 작성 완료', done: true });
      return (finishCall.args && finishCall.args.findings) || [];
    }

    const toolResults = [];
    for (const tc of result.toolCalls) {
      if (onStep) onStep({ tool: tc.name, text: describeToolCall(tc.name, tc.args) });
      let output;
      try {
        output = await executeTool(tc.name, tc.args, page, domain);
      } catch (err) {
        output = { error: err.message };
      }
      toolResults.push({ id: tc.id, name: tc.name, output });
    }
    transcript.push({ role: 'tool_results', results: toolResults });
  }

  throw new Error(`최대 반복 횟수(${MAX_TURNS}회) 안에 보고서를 완성하지 못했습니다.`);
}

module.exports = { runAgentLoop };
