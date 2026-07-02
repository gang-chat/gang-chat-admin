FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG VITE_API_BASE=http://127.0.0.1:8787
ARG VITE_WS_BASE=ws://127.0.0.1:8787
ENV VITE_API_BASE=$VITE_API_BASE
ENV VITE_WS_BASE=$VITE_WS_BASE
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV OPS_HOST=0.0.0.0
ENV OPS_PORT=8787
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/build ./build
COPY --from=builder /app/server/dist ./server/dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000 8787
CMD ["node", "build"]
