FROM node:24-alpine AS deps
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
FROM node:24-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
# The runtime only needs node: removing the package managers drops their bundled
# dependencies, which scanners otherwise report as vulnerabilities in the image.
RUN npm ci --omit=dev && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/yarn-v* \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
