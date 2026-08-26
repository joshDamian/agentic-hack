FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/typescript/ node_modules/typescript/
RUN mkdir -p node_modules/.bin && ln -s ../typescript/bin/tsc node_modules/.bin/tsc
EXPOSE 8080
CMD ["node", "dist/index.js"]
