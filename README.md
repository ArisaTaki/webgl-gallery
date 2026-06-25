# 念念照片画廊

一个本地优先的 TypeScript WebGL 家庭相册。前端使用 Three.js shader 做横向胶片带、滚动形变、颗粒和暗角；服务端负责上传照片、生成 WebP 派生图并更新照片清单。

## 启动

```bash
npm install
npm run dev
```

打开：

```text
http://localhost:5279
```

隐藏管理入口：

```text
http://localhost:5279/studio
```

也可以在画廊里直接输入 `nian` 打开隐藏管理入口。没有配置管理员密码 hash 时，开发环境会临时沿用 `GALLERY_UPLOAD_KEY`，默认是 `13209`。生产环境建议设置 `GALLERY_ADMIN_PASSWORD_HASH` 和 `SESSION_SECRET`：

```bash
npx tsx -e "import { createPasswordHash } from './server/auth.ts'; console.log(createPasswordHash('your-password'))"
GALLERY_ADMIN_PASSWORD_HASH="scrypt:..." SESSION_SECRET="long-random-secret" npm run dev
```

服务端也支持 `GALLERY_DATA_DIR`、`GALLERY_MEDIA_DIR`、`GALLERY_UPLOAD_DIR`、`GALLERY_ORIGINAL_DIR` 和 `GALLERY_MANIFEST_PATH` 覆盖本地 fallback 存储路径，主要用于隔离测试或临时部署。上传管线的端到端验证：

```bash
node scripts/qa-upload-pipeline-v106.mjs
```

## 托管图片与数据库

线上推荐使用 Cloudflare R2 存图片文件、Postgres 存相册和图片元数据：

```bash
DATABASE_URL="postgres://..."
R2_ACCOUNT_ID="..."
R2_ACCESS_KEY_ID="..."
R2_SECRET_ACCESS_KEY="..."
R2_PUBLIC_BUCKET="gallery-public"
R2_PRIVATE_BUCKET="gallery-private"
R2_PUBLIC_BASE_URL="https://cdn.example.com"
npm run db:migrate
```

`R2_PUBLIC_BUCKET` 保存公开的 `thumb/medium/large` WebP 派生图；`R2_PRIVATE_BUCKET` 保存原图，用于后台重新生成缩略图。没有配置 `DATABASE_URL` 时，应用会继续使用 `public/data/photos.json` 和本地 `public/media/`，方便本地开发。

从旧 manifest 迁移到 Postgres/R2：

```bash
npm run migrate:manifest -- --manifest public/data/photos.json --media public/media --source "/absolute/path/to/originals"
```

先检查不写数据库的 dry run：

```bash
npm run migrate:manifest -- --dry-run --manifest public/data/photos.json --media public/media
```

## 同步本地照片

```bash
npm run sync:photos -- --source "/absolute/path/to/photos"
```

脚本会按同名文件去重，并生成三档 WebP：

- `thumb`: 小缩略图
- `medium`: 画廊默认图
- `large`: 大图状态

当前生成内容放在 `public/media/` 和 `public/data/photos.json`，这些文件默认不提交到 git，避免把家庭照片带进仓库。上传时的临时原图会先进入 `.uploads/`，处理完就删除，不会从公开静态目录暴露。

## 构建

```bash
npm run typecheck
npm run build
npm test
npm run preview
```

前端入口、服务端入口和照片同步脚本都使用 TypeScript：`src/main.ts`、`server/index.ts`、`server/photoPipeline.ts` 和 `scripts/sync-photos.ts`。
