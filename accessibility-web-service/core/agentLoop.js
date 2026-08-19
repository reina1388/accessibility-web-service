const { ADAPTERS } = require('./adapters');
const { MAX_TURNS } = require('./tools');
const { executeTool } = require('./executors');

const DEFAULT_TOKEN_LIMIT = 1000;

const INITIAL_PROMPT =
  '현재 열려 있는 페이지의 웹 접근성을 도구를 사용해 조사하고, KWCAG 2.1 기준으로 최종 보고서를 작성해줘.';

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

async function runToolCalls(toolCalls, page, domain, onStep) {
  const toolResults = [];
  for (const tc of toolCalls) {
    if (onStep) onStep({ tool: tc.name, text: describeToolCall(tc.name, tc.args) });
    let output;
    try {
      output = await executeTool(tc.name, tc.args, page, domain);
    } catch (err) {
      output = { error: err.message };
    }
    toolResults.push({ id: tc.id, name: tc.name, output });
  }
  return toolResults;
}

// 토큰 한도에 도달했을 때, 지금까지 조사한 내용만으로 중간 보고서를 강제로 받아냅니다.
// 주의: 원본 transcript(이어가기용)는 건드리지 않고, 복사본에서만 질문합니다.
// (그렇지 않으면 "답변되지 않은 도구 호출"이 대화 기록에 남아, 이어서 진행할 때
//  일부 API가 대화 형식 오류로 거부할 수 있습니다.)
async function requestInterimReport(adapter, transcript, apiKey, model, onStep) {
  const sideTranscript = JSON.parse(JSON.stringify(transcript));
  sideTranscript.push({
    role: 'user',
    text:
      '토큰 사용 한도에 도달했습니다. 지금까지 조사/검증한 내용만으로 finish_report를 호출해 중간 보고서를 제출해줘. 아직 검증하지 못한 항목은 verified를 false로 표시해줘.',
  });

  const result = await adapter.callModel(sideTranscript, apiKey, model);

  const finishCall = (result.toolCalls || []).find((tc) => tc.name === 'finish_report');
  const findings = finishCall ? (finishCall.args && finishCall.args.findings) || [] : [];

  if (onStep) {
    onStep({ tool: 'token_limit', text: `토큰 한도 도달 · 중간 보고서 ${findings.length}건`, done: false });
  }

  return { findings, tokensUsed: (result.usage && result.usage.totalTokens) || 0 };
}

// onStep(step)이 있으면 각 도구 호출마다 호출됩니다 (서버가 이걸로 진행상황을 스트리밍).
// transcript를 인자로 주면 이전에 중단된 지점부터 이어서 진행합니다(토큰 한도 재개용).
async function runAgentLoop({
  provider,
  apiKey,
  model,
  page,
  domain,
  onStep,
  transcript,
  tokenLimit = DEFAULT_TOKEN_LIMIT,
}) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`알 수 없는 공급자: ${provider}`);

  const localTranscript = transcript || [{ role: 'user', text: INITIAL_PROMPT }];
  let tokensUsedThisSegment = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const result = await adapter.callModel(localTranscript, apiKey, model);
    tokensUsedThisSegment += (result.usage && result.usage.totalTokens) || 0;
    localTranscript.push({ role: 'assistant', text: result.text, toolCalls: result.toolCalls });

    if (!result.toolCalls || result.toolCalls.length === 0) {
      localTranscript.push({
        role: 'user',
        text: '계속 진행하려면 도구를 호출하거나, 조사가 끝났다면 finish_report 도구로 보고서를 제출해줘.',
      });
      continue;
    }

    const finishCall = result.toolCalls.find((tc) => tc.name === 'finish_report');
    if (finishCall) {
      if (onStep) onStep({ tool: 'finish_report', text: '최종 보고서 작성 완료', done: true });
      return {
        done: true,
        findings: (finishCall.args && finishCall.args.findings) || [],
        tokensUsed: tokensUsedThisSegment,
        transcript: localTranscript,
      };
    }

    // 이번 턴에 결정된 도구 호출은 실행해서 결과를 반영합니다 (로컬 실행이라 토큰 비용 없음).
    const toolResults = await runToolCalls(result.toolCalls, page, domain, onStep);
    localTranscript.push({ role: 'tool_results', results: toolResults });

    if (tokensUsedThisSegment >= tokenLimit) {
      const interim = await requestInterimReport(adapter, localTranscript, apiKey, model, onStep);
      tokensUsedThisSegment += interim.tokensUsed;
      return {
        done: false,
        findings: interim.findings,
        tokensUsed: tokensUsedThisSegment,
        transcript: localTranscript,
      };
    }
  }

  throw new Error(`최대 반복 횟수(${MAX_TURNS}회) 안에 보고서를 완성하지 못했습니다.`);
}

module.exports = { runAgentLoop, DEFAULT_TOKEN_LIMIT };
