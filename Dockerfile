FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ sqlite-dev
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache sqlite-libs tini && \
    addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY src ./src
COPY views ./views
COPY public ./public
RUN mkdir -p /app/data && chown -R app:app /app
USER app
EXPOSE 3000
ENV NODE_ENV=production
ENV DB_PATH=/app/data/hajjduaa.db
VOLUME ["/app/data"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
