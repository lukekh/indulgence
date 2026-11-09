FROM node:22-slim AS build
WORKDIR /app
COPY shared ./shared
COPY gate/package.json gate/package-lock.json ./gate/
RUN cd gate && npm ci
COPY gate ./gate
RUN cd gate && npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/gate/dist ./dist
USER node
EXPOSE 8787
CMD ["node", "dist/main.js"]
