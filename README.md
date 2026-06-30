# WebGL Gallery

一个本地优先的 TypeScript WebGL 家庭相册。前端使用 Three.js shader 做横向胶片带、滚动形变、颗粒和暗角；服务端负责上传照片、生成 WebP 派生图并更新照片清单。

## 一键启动

推荐 Docker。已经下载项目源码时：

```bash
cp .env.example .env
docker compose up -d --build
```

打开：

```text
http://localhost:5279
```

第一次启动如果还没有配置，会自动进入：

```text
http://localhost:5279/setup
```

推荐先选择默认的 `Local SQLite` + `Local folder`，填一个后台密码后保存。这样不需要 R2、Postgres 或额外图床服务，马上就能用 `/studio` 上传和管理相册。设置页支持中文和英文，可以右上角切换语言。

开发者也可以直接用 Node：

```bash
npm install
npm run setup
npm start
```

## Docker 发布

发布给家人或朋友时，可以把项目打成 `.tar.gz` 并托管，然后用 `install.sh` 做 curl 风格 Docker 安装：

```bash
npm run package:release
```

这会生成：

- `dist/install.sh`
- `dist/webgl-gallery.tar.gz`

把这两个文件上传到同一个可公开下载的位置后，用户只需要：

```bash
curl -fsSL https://github.com/ArisaTaki/webgl-gallery/releases/latest/download/install.sh | \
  WEBGL_GALLERY_SOURCE_URL=https://github.com/ArisaTaki/webgl-gallery/releases/latest/download/webgl-gallery.tar.gz sh
```

这条命令会在用户机器上构建本地镜像，最稳妥。如果 GitHub Release 已经发布了 GHCR 镜像，可以改用预构建镜像，启动会更快：

```bash
curl -fsSL https://github.com/ArisaTaki/webgl-gallery/releases/latest/download/install.sh | \
  WEBGL_GALLERY_SOURCE_URL=https://github.com/ArisaTaki/webgl-gallery/releases/latest/download/webgl-gallery.tar.gz \
  WEBGL_GALLERY_IMAGE_MODE=prebuilt \
  WEBGL_GALLERY_IMAGE=ghcr.io/arisataki/webgl-gallery:latest sh
```

也可以直接从 GitHub 仓库安装：

```bash
curl -fsSL https://raw.githubusercontent.com/ArisaTaki/webgl-gallery/main/install.sh | \
  WEBGL_GALLERY_REPO_URL=https://github.com/ArisaTaki/webgl-gallery.git sh
```

默认会安装到 `~/webgl-gallery`，可以用 `WEBGL_GALLERY_DIR=/path/to/gallery` 指定位置。脚本会检查 Docker 和 Docker Compose，下载源码，生成 `.env`，创建持久化目录，然后执行：

```bash
docker compose up -d --build
```

预构建镜像模式会改用：

```bash
docker compose -f docker-compose.image.yml up -d
```

首次在交互式终端安装时，脚本会先询问图片存储方式：

- `Local folder on this server`: 图片派生图保存在服务器本地 `public/media/`，只启动 gallery 应用容器。
- `Cloudflare R2`: 脚本会继续询问 `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、公开/私有 bucket 和公开图片域名，并写入 `.env`。

如果输入 `CLOUDFLARE_TUNNEL_TOKEN`，脚本还会同时启动 `cloudflared` 容器，把 `gallery.irop.one` 转发到应用容器；不输入 token 时只启动应用容器。

无人值守部署可以直接用环境变量跳过提问：

```bash
WEBGL_GALLERY_STORAGE_MODE=local sh install.sh
```

或：

```bash
WEBGL_GALLERY_STORAGE_MODE=r2 \
R2_ACCOUNT_ID="..." \
R2_ACCESS_KEY_ID="..." \
R2_SECRET_ACCESS_KEY="..." \
R2_PUBLIC_BUCKET="gallery-public" \
R2_PRIVATE_BUCKET="gallery-private" \
R2_PUBLIC_BASE_URL="https://media.example.com" \
CLOUDFLARE_TUNNEL_TOKEN="..." \
sh install.sh
```

如果服务器已经部署过，可以用更新模式刷新代码并重启 Docker。`.env`、`.gallery` 和 `.uploads` 会保留；更新时脚本会优先读取 `.gallery/config.json` 里的 `storage.kind`，已有 R2 配置不需要再把 R2 密钥复制到 `.env`：

```bash
curl -fsSL https://raw.githubusercontent.com/ArisaTaki/webgl-gallery/main/install.sh | \
  WEBGL_GALLERY_ACTION=update \
  WEBGL_GALLERY_SOURCE_URL=https://github.com/ArisaTaki/webgl-gallery/archive/refs/heads/main.tar.gz \
  WEBGL_GALLERY_IMAGE_MODE=prebuilt \
  WEBGL_GALLERY_IMAGE=ghcr.io/arisataki/webgl-gallery:latest sh
```

GitHub `main` 分支有新 push 时，Release workflow 会跑完整校验并刷新 GHCR 的 `latest`、`main` 和 `sha-*` 镜像标签；推送 `v*` tag 时仍然会生成正式 GitHub Release 和安装包附件。

如果需要走 Node 本地模式，可以设置：

```bash
WEBGL_GALLERY_INSTALL_MODE=node sh install.sh
```

配置完成后可以随时检查当前存储和设置是否可用：

```bash
npm run doctor
```

### irop.one 域名

推荐把画廊页面放在 `gallery.irop.one`，继续让 `media.irop.one` 专门服务 R2 图片。Docker Compose 已经内置可选的 Cloudflare Tunnel 服务：

1. 在 Cloudflare Zero Trust 里创建一个 Cloudflared tunnel
2. Public hostname 指向 `gallery.irop.one`
3. Service 填 `http://gallery:5279`
4. 把 tunnel token 写入 `.env` 的 `CLOUDFLARE_TUNNEL_TOKEN`
5. 启动 tunnel profile：

```bash
docker compose --profile tunnel up -d
```

SQLite 不需要用户额外安装系统 SQLite；项目优先使用 Node.js 自带的 `node:sqlite`。如果当前 Node 版本不支持内置 SQLite，应用仍然会正常启动到 `/setup`，并自动提供 `Local JSON fallback` 兼容模式，也可以改选 Postgres。建议普通本地使用升级到 Node 24+ 后继续选择 SQLite。

配置会写到本地私有目录：

- `.gallery/config.json`: 一键启动配置和后台密码 hash
- `.gallery/gallery.sqlite`: 本地 SQL 元数据
- `public/data/photos.json`: JSON 兼容模式元数据
- `public/media/`: 公开缩略图和 WebP 派生图
- `.uploads/originals/`: 旧版本原图兼容目录，新上传不会再保存原图

## 图片存储怎么选

普通本机使用选 `Local folder`。项目只会持久化可公开展示的 `thumb/medium/large` WebP 图片，放进 `public/media/`；上传时的临时原图处理完成后会删除，不再额外备份一份原图。`/setup` 里保留的原图目录字段用于旧数据兼容和迁移，新上传不会写入。

部署到公网或多台机器访问时选 `Cloudflare R2`。推荐两个 bucket：

- 公开 bucket：保存 `thumb/medium/large` 展示图，绑定公开域名，例如 `https://media.example.com`
- 私有 bucket：旧版本原图兼容和迁移使用，不开启公开访问；新上传不会写入 `original`

R2 配置保存时会做一次实际检查：向公开 bucket 和私有 bucket 临时写入 `_setup-check` 对象，读取成功后删除，并通过公开域名确认展示图能被浏览器访问。检查失败时，通常是 token 权限、bucket 名称、公开域名或 CORS 没配好。

隐藏管理入口：

```text
http://localhost:5279/studio
```

也可以在画廊里直接输入 `webgl` 打开隐藏管理入口。开发时仍然可以用热更新命令：

```bash
npm run dev
```

没有配置管理员密码 hash 时，开发环境会临时沿用 `GALLERY_UPLOAD_KEY`，默认是 `13209`。生产环境建议在 `/setup` 里设置后台密码，或者设置 `GALLERY_ADMIN_PASSWORD_HASH` 和 `SESSION_SECRET`：

```bash
npx tsx -e "import { createPasswordHash } from './server/auth.ts'; console.log(createPasswordHash('your-password'))"
GALLERY_ADMIN_PASSWORD_HASH="scrypt:..." SESSION_SECRET="long-random-secret" npm run dev
```

服务端也支持 `GALLERY_CONFIG_PATH`、`GALLERY_DATA_DIR`、`GALLERY_MEDIA_DIR`、`GALLERY_UPLOAD_DIR`、`GALLERY_ORIGINAL_DIR`、`GALLERY_MANIFEST_PATH`、`GALLERY_SQLITE_PATH` 和 `GALLERY_DISABLE_SQLITE=1` 覆盖或模拟本地路径，主要用于隔离测试或临时部署。上传管线的端到端验证：

```bash
node scripts/qa-upload-pipeline-v106.mjs
```

## 托管图片与数据库

线上推荐使用 Cloudflare R2 存图片文件、Postgres 存相册和图片元数据。优先用 `/setup` 或 `npm run setup` 填写，项目会把密钥写进本机 `.gallery/config.json`，不会提交到 git。熟悉部署环境的人也可以继续用环境变量：

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

`R2_PUBLIC_BUCKET` 保存公开的 `thumb/medium/large` WebP 派生图；`R2_PRIVATE_BUCKET` 仅用于旧版本原图记录或迁移兼容，新上传不会再保存原图。没有配置 `DATABASE_URL` 时，应用默认使用本地 SQLite。第一次切到 SQLite 时，如果发现旧的 `public/data/photos.json`，会自动把旧照片清单导入本地 SQL。

R2 公开 bucket 需要允许浏览器读取图片。推荐 CORS：

- Origins: `*` 或你的站点域名
- Methods: `GET`, `HEAD`
- Headers: `*`
- Expose headers: `ETag`

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
npm run release:test
npm run preview
```

前端入口、服务端入口和照片同步脚本都使用 TypeScript：`src/main.ts`、`server/index.ts`、`server/photoPipeline.ts` 和 `scripts/sync-photos.ts`。
