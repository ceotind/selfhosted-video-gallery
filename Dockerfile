FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY astro.config.mjs ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM node:22-alpine AS authdeps
WORKDIR /auth
COPY auth/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM nginx:1.27-alpine
# ffmpeg for posters, libstdc++ for the node binary, su-exec to drop down to your user.
RUN apk add --no-cache ffmpeg libstdc++ su-exec
COPY --from=node:22-alpine /usr/local/bin/node /usr/local/bin/node
COPY --from=authdeps /auth/node_modules /app/node_modules
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /app/dist
COPY scripts /app/scripts
COPY auth/login.html /app/auth/login.html
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]