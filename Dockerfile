FROM node:20-slim

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

RUN mkdir -p auth_sessions

EXPOSE 3100
CMD ["node", "index.js"]
