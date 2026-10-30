FROM node:25-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Test image: full dev dependencies, runs unit and e2e suites.
FROM deps AS test
ENV NODE_ENV=test
COPY tsconfig*.json jest.config.js ./
COPY src ./src
COPY migrations ./migrations
COPY test ./test
CMD ["npm", "run", "test:all"]

FROM deps AS build
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# Production image: compiled JS and runtime dependencies only, running as a non-root user.
FROM node:25-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
