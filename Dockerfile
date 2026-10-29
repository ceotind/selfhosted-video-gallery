FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY astro.config.mjs ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine
RUN apk add --no-cache nodejs ffmpeg
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /app/dist
COPY scripts /app/scripts
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
