FROM node:20-slim

RUN apt-get update && apt-get install -y git openssh-client --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Force all git ssh URLs to use https
ENV GIT_SSH_COMMAND="echo"
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && \
    git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/" && \
    git config --global url."https://github.com/".insteadOf "git@github.com:"

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p auth_sessions

EXPOSE 3100
CMD ["node", "index.js"]
