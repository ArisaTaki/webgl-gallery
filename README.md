# 念念照片画廊

一个本地优先的 TypeScript WebGL 家庭相册。前端使用 Three.js shader 做横向胶片带、滚动形变、颗粒和暗角；服务端负责上传照片、生成 WebP 派生图并更新照片清单。

## 一键启动

```bash
npm install
npm start
```

打开：

```text
http://localhost:5279
```

第一次启动如果还没有配置，会自动进入：

```text
http://localhost:5279/setup
```

推荐先选择默认的 `Local SQLite` + `Local folder`，填一个后台密码后保存。这样不需要 R2、Postgres、Docker 或图床服务，马上就能用 `/studio` 上传和管理相册。配置会写到本地私有目录：

- `.gallery/config.json`: 一键启动配置和后台密码 hash
- `.gallery/gallery.sqlite`: 本地 SQL 元数据
- `public/media/`: 公开缩略图和 WebP 派生图
- `.uploads/originals/`: 本地原图备份

隐藏管理入口：

```text
http://localhost:5279/studio
```

也可以在画廊里直接输入 `nian` 打开隐藏管理入口。开发时仍然可以用热更新命令：

```bash
npm run dev
```

没有配置管理员密码 hash 时，开发环境会临时沿用 `GALLERY_UPLOAD_KEY`，默认是 `13209`。生产环境建议在 `/setup` 里设置后台密码，或者设置 `GALLERY_ADMIN_PASSWORD_HASH` 和 `SESSION_SECRET`：

```bash
npx tsx -e "import { createPasswordHash } from './server/auth.ts'; console.log(createPasswordHash('your-password'))"
GALLERY_ADMIN_PASSWORD_HASH="scrypt:..." SESSION_SECRET="long-random-secret" npm run dev
```

服务端也支持 `GALLERY_CONFIG_PATH`、`GALLERY_DATA_DIR`、`GALLERY_MEDIA_DIR`、`GALLERY_UPLOAD_DIR`、`GALLERY_ORIGINAL_DIR`、`GALLERY_MANIFEST_PATH` 和 `GALLERY_SQLITE_PATH` 覆盖本地路径，主要用于隔离测试或临时部署。上传管线的端到端验证：

```bash
node scripts/qa-upload-pipeline-v106.mjs
```

## 托管图片与数据库

线上推荐使用 Cloudflare R2 存图片文件、Postgres 存相册和图片元数据。可以直接在 `/setup` 页面里填写，也可以继续用环境变量：

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

`R2_PUBLIC_BUCKET` 保存公开的 `thumb/medium/large` WebP 派生图；`R2_PRIVATE_BUCKET` 保存原图，用于后台重新生成缩略图。没有配置 `DATABASE_URL` 时，应用默认使用本地 SQLite。第一次切到 SQLite 时，如果发现旧的 `public/data/photos.json`，会自动把旧照片清单导入本地 SQL。

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
