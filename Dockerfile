FROM node:22-alpine

RUN apk add --no-cache bash

WORKDIR /app

# Install mcp-telegram
RUN npm install @overpod/mcp-telegram

# Copy the HTTP bridge server
COPY server.js /app/server.js
COPY package.json /app/package.json

# Session data directory
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "/app/server.js"]
