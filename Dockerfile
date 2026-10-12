
FROM mcr.microsoft.com/playwright:v1.52.0-noble

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

EXPOSE 3000

CMD ["npm", "start"]