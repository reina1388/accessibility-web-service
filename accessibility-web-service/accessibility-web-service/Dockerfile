# Playwright 공식 이미지: Chromium과 필요한 시스템 라이브러리가 이미 설치되어 있음
# (Render의 기본 Node 환경에서는 apt 설치 권한 문제로 playwright install --with-deps가 실패하기 때문에
#  이 방식으로 우회합니다)
FROM mcr.microsoft.com/playwright:v1.62.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
