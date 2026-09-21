const crypto = require('crypto');
const { chromium } = require('playwright');
const { runAgentLoop, DEFAULT_TOKEN_LIMIT } = require('./agentLoop');
const { computeScoreAndGrade } = require('./scoring');

// 자동(무인) 검사는 사람이 "계속 진행"을 눌러줄 수 없으므로,
// 일시정지되면 자동으로 이어서 진행하되 무한정 반복하지 않도록 최대 구간 수를 둡니다.
const MAX_AUTO_SEGMENTS = 3;

// URL을 헤드리스 브라우저로 열어 끝까지(또는 최대 구간까지) 검사합니다.
// 사람이 관여하지 않는 자동 검사(스케줄러)에서 사용합니다.
async function runFullCheckAutomated({ provider, apiKey, model, url }) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const pageTitle = await page.title().catch(() => '');
    const domain = new URL(url).hostname;

    let transcript;
    let findings = [];
    for (let segment = 0; segment < MAX_AUTO_SEGMENTS; segment++) {
      const result = await runAgentLoop({
        provider, apiKey, model, page, domain, transcript, tokenLimit: DEFAULT_TOKEN_LIMIT,
      });
      findings = result.findings;
      if (result.done) break;
      transcript = result.transcript;
    }

    const { score, grade } = computeScoreAndGrade(findings);
    return { pageTitle, score, grade, findings };
  } finally {
    await browser.close();
  }
}

// AI를 부르지 않고, 페이지 내용이 이전과 달라졌는지만 가볍게 확인하기 위한 해시값을 구합니다.
async function fetchContentHash(url) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const content = await page.content();
    return crypto.createHash('sha256').update(content).digest('hex');
  } finally {
    await browser.close();
  }
}

module.exports = { runFullCheckAutomated, fetchContentHash };
