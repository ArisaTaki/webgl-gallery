import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { makeR2Key } from './galleryUtils.js';

export function createStorage({ mediaDir, originalDir, storageConfig = null }) {
  if (hasR2Config(storageConfig)) {
    return new R2Storage(storageConfig);
  }
  return new LocalStorage({
    mediaDir: storageConfig?.mediaDir || mediaDir,
    originalDir: storageConfig?.originalDir || originalDir,
  });
}

export function hasR2Config(storageConfig: any = null) {
  return missingR2ConfigFields(storageConfig).length === 0;
}

export function resolveR2Config(storageConfig: any = null) {
  const r2 = storageConfig?.r2 || storageConfig || {};
  return {
    accountId: String(r2.accountId || process.env.R2_ACCOUNT_ID || ''),
    accessKeyId: String(r2.accessKeyId || process.env.R2_ACCESS_KEY_ID || ''),
    secretAccessKey: String(r2.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY || ''),
    publicBucket: String(r2.publicBucket || process.env.R2_PUBLIC_BUCKET || ''),
    privateBucket: String(r2.privateBucket || process.env.R2_PRIVATE_BUCKET || ''),
    publicBaseUrl: String(r2.publicBaseUrl || process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  };
}

export function missingR2ConfigFields(storageConfig: any = null) {
  const r2 = resolveR2Config(storageConfig);
  return [
    ['accountId', r2.accountId],
    ['accessKeyId', r2.accessKeyId],
    ['secretAccessKey', r2.secretAccessKey],
    ['publicBucket', r2.publicBucket],
    ['privateBucket', r2.privateBucket],
    ['publicBaseUrl', r2.publicBaseUrl],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

export async function verifyStorageConfig(storageConfig: any, options: any = {}) {
  if (storageConfig?.kind === 'r2') {
    return verifyR2StorageConfig(storageConfig, options);
  }
  return verifyLocalStorageConfig(storageConfig, options);
}

export async function verifyLocalStorageConfig(storageConfig: any, options: any = {}) {
  const mediaDir = path.resolve(String(storageConfig?.mediaDir || 'public/media'));
  const originalDir = path.resolve(String(storageConfig?.originalDir || '.uploads/originals'));
  if (samePath(mediaDir, originalDir) || isSubPath(originalDir, mediaDir)) {
    throw new Error('Original backup folder must be outside the public media folder.');
  }
  if (options.publicDir && (samePath(originalDir, path.resolve(options.publicDir)) || isSubPath(originalDir, path.resolve(options.publicDir)))) {
    throw new Error('Original backup folder must not be inside the public directory.');
  }
  await mkdir(mediaDir, { recursive: true });
  await mkdir(originalDir, { recursive: true });
  await access(mediaDir, constants.W_OK);
  await access(originalDir, constants.W_OK);
  return {
    ok: true,
    kind: 'local',
    mediaDir,
    originalDir,
  };
}

export async function verifyR2StorageConfig(storageConfig: any, options: any = {}) {
  const missing = missingR2ConfigFields(storageConfig);
  if (missing.length) {
    throw new Error(`R2 storage is missing: ${missing.join(', ')}.`);
  }

  const r2 = resolveR2Config(storageConfig);
  if (r2.publicBucket === r2.privateBucket) {
    throw new Error('R2 public bucket and private bucket must be different.');
  }
  const client = createR2Client(r2);
  const probeId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.txt`;
  const publicKey = `_setup-check/public-${probeId}`;
  const privateKey = `_setup-check/private-${probeId}`;
  const body = Buffer.from('ok\n');
  const uploaded: Array<{ bucket: string; key: string }> = [];
  const cleanupFailures: string[] = [];

  try {
    await putProbeObject(client, r2.publicBucket, publicKey, body);
    uploaded.push({ bucket: r2.publicBucket, key: publicKey });
    await assertProbeObject(client, r2.publicBucket, publicKey, body);

    await putProbeObject(client, r2.privateBucket, privateKey, body);
    uploaded.push({ bucket: r2.privateBucket, key: privateKey });
    await assertProbeObject(client, r2.privateBucket, privateKey, body);

    if (options.verifyPublicUrl !== false) {
      const publicUrl = `${r2.publicBaseUrl}/${publicKey}`;
      const response = await fetch(publicUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`R2 public URL check failed with HTTP ${response.status}: ${publicUrl}`);
      }
      const text = await response.text();
      if (text !== body.toString('utf8')) {
        throw new Error(`R2 public URL returned unexpected content: ${publicUrl}`);
      }
    }
  } finally {
    const cleanupResults = await Promise.allSettled(
      uploaded.map((item) => client.send(new DeleteObjectCommand({ Bucket: item.bucket, Key: item.key }))),
    );
    cleanupResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        cleanupFailures.push(`${uploaded[index]?.bucket}/${uploaded[index]?.key}: ${result.reason?.message || result.reason}`);
      }
    });
  }

  if (cleanupFailures.length) {
    throw new Error(`R2 probe uploaded successfully, but cleanup failed. Check delete permission: ${cleanupFailures.join('; ')}`);
  }

  return {
    ok: true,
    kind: 'r2',
    publicBucket: r2.publicBucket,
    privateBucket: r2.privateBucket,
    publicBaseUrl: r2.publicBaseUrl,
  };
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

  constructor(storageConfig: any = null) {
    const r2 = resolveR2Config(storageConfig);
    this.kind = 'r2';
    this.publicBucket = r2.publicBucket;
    this.privateBucket = r2.privateBucket;
    this.publicBaseUrl = r2.publicBaseUrl;
    this.client = createR2Client(r2);
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

function createR2Client(r2) {
  return new S3Client({
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
    endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
    region: 'auto',
  });
}

async function putProbeObject(client, bucket, key, body) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      CacheControl: 'no-store',
      ContentLength: body.byteLength,
      ContentType: 'text/plain; charset=utf-8',
    }),
  );
}

async function assertProbeObject(client, bucket, key, expected) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const actual = await streamToBuffer(result.Body);
  if (!actual.equals(expected)) {
    throw new Error(`R2 object read check returned unexpected content for ${bucket}/${key}.`);
  }
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function isSubPath(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
