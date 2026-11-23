# Build from the repository root, because the backend shares src/lib with the client:
#   docker build -f backend/Dockerfile -t nexora-backend .
#   docker run --env-file backend/.env -p 8787:8787 nexora-backend            # API
#   docker run --env-file backend/.env nexora-backend node src/worker.ts      # worker (needs REDIS_URL)
#   docker run --env-file backend/.env nexora-backend node src/cli.ts migrate # migrations
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY src/lib ./src/lib
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev && npm cache clean --force
COPY backend/src ./backend/src
COPY backend/migrations ./backend/migrations
WORKDIR /app/backend
USER node
EXPOSE 8787
CMD ["node", "src/server.ts"]
