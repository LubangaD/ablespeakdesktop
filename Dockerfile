# Stage 1: Build dashboard
FROM node:22-alpine AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# Stage 2: Run gateway
FROM node:22-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --production
COPY server/ ./
COPY --from=dashboard-build /app/dashboard/dist ./dashboard-dist

ENV NODE_ENV=production
ENV GATEWAY_PORT=3001
ENV DASHBOARD_DIST=./dashboard-dist

EXPOSE 3001
CMD ["node", "src/index.js"]
