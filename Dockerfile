FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=5279 \
    GALLERY_CONFIG_DIR=/app/.gallery \
    GALLERY_PORTABLE_PATHS=1 \
    GALLERY_DATA_DIR=/app/public/data \
    GALLERY_MEDIA_DIR=/app/public/media \
    GALLERY_UPLOAD_DIR=/app/.uploads/tmp \
    GALLERY_ORIGINAL_DIR=/app/.uploads/originals

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build \
  && mkdir -p /app/.gallery /app/.uploads/tmp /app/.uploads/originals /app/public/data /app/public/media

EXPOSE 5279

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5279/api/setup/status').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "preview"]
