const express = require('express');
const path = require('path');
const { chromium } = require('playwright');
const { runAgentLoop } = require('./core/agentLoop');
const { getCacheSize, clearCache } = require('./core/cache');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PAGE_LOAD_TIMEOUT_MS = 30000;

app.post('/api/check', async (req, res) => {
  const { url, provider, apiKey, model } = req.body || {};

  if (!url || !provider || !apiKey || !model) {
    res.status(400).json({ error: 'url, provider, apiKey, model은 모두 필수입니다.' });
    return;
  }
  if (!['claude', 'gemini', 'openai'].includes(provider)) {
    res.status(400).json({ error: `알 수 없는 공급자: ${provider}` });
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('http/https만 지원합니다.');
  } catch (e) {
    res.status(400).json({ error: '올바른 URL 형식이 아닙니다 (http:// 또는 https://로 시작해야 함).' });
    return;
  }

  // 진행상황을 줄바꿈으로 구분된 JSON(ndjson)으로 스트리밍합니다.
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (obj) => res.write(`${JSON.stringify(obj)}\n`);

  let browser;
  try {
    send({ type: 'log', text: '브라우저를 준비하는 중...' });
    browser = await chromium.launch();
    const page = await browser.newPage();

    send({ type: 'log', text: `${parsedUrl.hostname} 페이지를 여는 중...` });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });

    const pageTitle = await page.title().catch(() => '');

    const findings = await runAgentLoop({
      provider,
      apiKey,
      model,
      page,
      domain: parsedUrl.hostname,
      onStep: (step) => send({ type: 'log', tool: step.tool, text: step.text, done: !!step.done }),
    });

    send({ type: 'done', findings, pageUrl: url, pageTitle, domain: parsedUrl.hostname });
  } catch (err) {
    send({ type: 'error', message: err.message });
  } finally {
    if (browser) await browser.close();
    res.end();
  }
});

app.get('/api/cache-status', (req, res) => {
  res.json({ size: getCacheSize() });
});

app.post('/api/cache-clear', (req, res) => {
  res.json(clearCache());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`웹 접근성 검증 에이전트 서버 실행 중: http://localhost:${PORT}`);
});
