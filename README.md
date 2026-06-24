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

隐藏上传入口：

```text
http://localhost:5279/studio
```

也可以在画廊里直接输入 `nian` 打开隐藏上传入口。默认上传 key 是 `13209`，上传页会显示已选择的文件数和总大小，并支持自定义照片标题前缀。需要更换 key 时：

```bash
GALLERY_UPLOAD_KEY="your-private-key" npm run dev
```

服务端也支持 `GALLERY_DATA_DIR`、`GALLERY_MEDIA_DIR`、`GALLERY_UPLOAD_DIR` 和 `GALLERY_MANIFEST_PATH` 覆盖存储路径，主要用于隔离测试或临时部署。上传管线的端到端验证：

```bash
node scripts/qa-upload-pipeline-v106.mjs
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
npm run preview
```

前端入口、服务端入口和照片同步脚本都使用 TypeScript：`src/main.ts`、`server/index.ts`、`server/photoPipeline.ts` 和 `scripts/sync-photos.ts`。
