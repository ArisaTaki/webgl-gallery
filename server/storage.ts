import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { makeR2Key } from './galleryUtils.js';

export function createStorage({ mediaDir, originalDir }) {
  if (hasR2Config()) {
    return new R2Storage();
  }
  return new LocalStorage({ mediaDir, originalDir });
}

export function hasR2Config() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_PUBLIC_BUCKET &&
      process.env.R2_PRIVATE_BUCKET &&
      process.env.R2_PUBLIC_BASE_URL,
  );
}

export class LocalStorage {
  [key: string]: any;

  constructor({ mediaDir, originalDir }) {
    this.kind = 'local';
    this.mediaDir = mediaDir;
    this.originalDir = originalDir;
  }

  async putAsset({ groupSlug, photoId, kind, fileName, buffer, mimeType }) {
    const key = makeR2Key({ groupSlug, photoId, kind, fileName });
    const root = kind === 'original' ? this.originalDir : this.mediaDir;
    const outputPath = path.join(root, key);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, buffer);
    return {
      key,
      url: kind === 'original' ? '' : `/media/${key}`,
      mimeType,
      sizeBytes: buffer.byteLength,
    };
  }

  async getAssetBuffer(asset) {
    const root = asset.kind === 'original' ? this.originalDir : this.mediaDir;
    return readFile(path.join(root, asset.r2Key || asset.key));
  }

  async deleteAsset(asset) {
    const root = asset.kind === 'original' ? this.originalDir : this.mediaDir;
    await unlink(path.join(root, asset.r2Key || asset.key)).catch(() => {});
  }
}

export class R2Storage {
  [key: string]: any;

  constructor() {
    this.kind = 'r2';
    this.publicBucket = process.env.R2_PUBLIC_BUCKET;
    this.privateBucket = process.env.R2_PRIVATE_BUCKET;
    this.publicBaseUrl = String(process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    this.client = new S3Client({
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      region: 'auto',
    });
  }

  async putAsset({ groupSlug, photoId, kind, fileName, buffer, mimeType }) {
    const key = makeR2Key({ groupSlug, photoId, kind, fileName });
    const bucket = kind === 'original' ? this.privateBucket : this.publicBucket;
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentLength: buffer.byteLength,
        ContentType: mimeType,
      }),
    );
    return {
      key,
      url: kind === 'original' ? '' : `${this.publicBaseUrl}/${key}`,
      mimeType,
      sizeBytes: buffer.byteLength,
    };
  }

  async getAssetBuffer(asset) {
    const bucket = asset.kind === 'original' ? this.privateBucket : this.publicBucket;
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: asset.r2Key || asset.key,
      }),
    );
    return streamToBuffer(result.Body);
  }

  async deleteAsset(asset) {
    const bucket = asset.kind === 'original' ? this.privateBucket : this.publicBucket;
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: asset.r2Key || asset.key,
      }),
    );
  }
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof Readable) {
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(await body.transformToByteArray());
}
