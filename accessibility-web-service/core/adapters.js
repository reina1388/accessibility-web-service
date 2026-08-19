const { TOOLS, AGENT_SYSTEM_PROMPT } = require('./tools');

// fetch는 Node 18+ 에 전역으로 내장되어 있습니다 (별도 설치 불필요).

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  if (schema.type) out.type = schema.type.toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      out.properties[key] = toGeminiSchema(val);
    }
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.required) out.required = schema.required;
  return out;
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return {};
  }
}

const ClaudeAdapter = {
  buildTools() {
    return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  },
  toMessages(transcript) {
    const messages = [];
    for (const entry of transcript) {
      if (entry.role === 'user') {
        messages.push({ role: 'user', content: entry.text });
      } else if (entry.role === 'assistant') {
        const content = [];
        if (entry.text) content.push({ type: 'text', text: entry.text });
        for (const tc of entry.toolCalls || []) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
        }
        messages.push({ role: 'assistant', content });
      } else if (entry.role === 'tool_results') {
        const content = entry.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: JSON.stringify(r.output),
        }));
        messages.push({ role: 'user', content });
      }
    }
    return messages;
  },
  async callModel(transcript, apiKey, model) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        system: AGENT_SYSTEM_PROMPT,
        tools: this.buildTools(),
        messages: this.toMessages(transcript),
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API 오류 (${response.status}): ${errText.slice(0, 200)}`);
    }
    const data = await response.json();
    const textBlock = data.content.find((b) => b.type === 'text');
    const toolCalls = data.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: b.input }));
    const usage = data.usage || {};
    const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
    return { text: textBlock ? textBlock.text : '', toolCalls, usage: { totalTokens } };
  },
};

const GeminiAdapter = {
  buildTools() {
    return [
      {
        functionDeclarations: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: toGeminiSchema(t.input_schema),
        })),
      },
    ];
  },
  toContents(transcript) {
    const contents = [];
    for (const entry of transcript) {
      if (entry.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: entry.text }] });
      } else if (entry.role === 'assistant') {
        const parts = [];
        if (entry.text) parts.push({ text: entry.text });
        for (const tc of entry.toolCalls || []) {
          const part = { functionCall: { name: tc.name, args: tc.args, id: tc.id } };
          // Gemini 3 계열은 이전에 받은 thought_signature를 그대로 돌려줘야 다음 턴이 유효합니다.
          // (병렬 도구 호출 시 첫 functionCall에만 실릴 수 있고, 없는 경우 검증을 건너뛰는
          //  공식 호환 값(skip_thought_signature_validator)으로 대체합니다.)
          part.thoughtSignature = tc.thoughtSignature || 'skip_thought_signature_validator';
          parts.push(part);
        }
        contents.push({ role: 'model', parts });
      } else if (entry.role === 'tool_results') {
        const parts = entry.results.map((r) => ({
          functionResponse: { name: r.name, id: r.id, response: r.output },
        }));
        contents.push({ role: 'user', parts });
      }
    }
    return contents;
  },
  async callModel(transcript, apiKey, model) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: AGENT_SYSTEM_PROMPT }] },
          contents: this.toContents(transcript),
          tools: this.buildTools(),
          generationConfig: { maxOutputTokens: 4000 },
        }),
      }
    );
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API 오류 (${response.status}): ${errText.slice(0, 200)}`);
    }
    const data = await response.json();
    const candidate = data.candidates && data.candidates[0];
    if (!candidate || !candidate.content) {
      throw new Error('Gemini 응답에서 유효한 candidate를 받지 못했습니다.');
    }
    const parts = candidate.content.parts || [];
    const textPart = parts.find((p) => p.text);
    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => ({
        id: p.functionCall.id,
        name: p.functionCall.name,
        args: p.functionCall.args,
        thoughtSignature: p.thoughtSignature, // 다음 턴에 그대로 돌려줘야 하므로 함께 보관
      }));
    const usageMeta = data.usageMetadata || {};
    const totalTokens = usageMeta.totalTokenCount || 0;
    return { text: textPart ? textPart.text : '', toolCalls, usage: { totalTokens } };
  },
};

const OpenAIAdapter = {
  buildTools() {
    return TOOLS.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  },
  toMessages(transcript) {
    const messages = [{ role: 'system', content: AGENT_SYSTEM_PROMPT }];
    for (const entry of transcript) {
      if (entry.role === 'user') {
        messages.push({ role: 'user', content: entry.text });
      } else if (entry.role === 'assistant') {
        const msg = { role: 'assistant', content: entry.text || null };
        if (entry.toolCalls && entry.toolCalls.length) {
          msg.tool_calls = entry.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }
        messages.push(msg);
      } else if (entry.role === 'tool_results') {
        for (const r of entry.results) {
          messages.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.output) });
        }
      }
    }
    return messages;
  },
  async callModel(transcript, apiKey, model) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: this.toMessages(transcript),
        tools: this.buildTools(),
        tool_choice: 'auto',
        max_tokens: 4000,
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API 오류 (${response.status}): ${errText.slice(0, 200)}`);
    }
    const data = await response.json();
    const message = data.choices && data.choices[0] && data.choices[0].message;
    if (!message) throw new Error('OpenAI 응답에서 message를 받지 못했습니다.');
    const toolCalls = (message.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: safeJsonParse(tc.function.arguments),
    }));
    const usage = data.usage || {};
    const totalTokens = usage.total_tokens || 0;
    return { text: message.content || '', toolCalls, usage: { totalTokens } };
  },
};

const ADAPTERS = { claude: ClaudeAdapter, gemini: GeminiAdapter, openai: OpenAIAdapter };

module.exports = { ADAPTERS, toGeminiSchema };
