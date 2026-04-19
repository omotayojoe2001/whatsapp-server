FROM node:20-slim

RUN apt-get update && apt-get install -y git --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p auth_sessions

EXPOSE 3100
CMD ["node", "index.js"]
