import path from 'node:path';

export const DEFAULT_GROUP_SLUG = 'default';
export const DEFAULT_GROUP_ID = 'default';

export function slugify(value, fallback = 'item') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]+/g, '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback;
}

export function makeUniqueSlug(baseSlug, existingSlugs) {
  const existing = new Set(existingSlugs.filter(Boolean));
  let slug = slugify(baseSlug);
  let index = 2;
  while (existing.has(slug)) {
    slug = `${slugify(baseSlug)}-${index}`;
    index += 1;
  }
  return slug;
}

export function normalizeVisibility(value) {
  return value === 'hidden' ? 'hidden' : 'public';
}

export function normalizePhotoStatus(value) {
  if (value === 'hidden' || value === 'deleted') return value;
  return 'active';
}

export function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

export function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeR2Key({ groupSlug = DEFAULT_GROUP_SLUG, photoId, kind, fileName }) {
  const safeGroup = slugify(groupSlug, DEFAULT_GROUP_SLUG);
  const safePhoto = slugify(photoId, 'photo');
  const extension = path.extname(fileName || '');
  const safeName = slugify(path.basename(fileName || kind, extension), kind);
  const finalExtension = extension || (kind === 'original' ? '.bin' : '.webp');
  return `${kind}/${safeGroup}/${safePhoto}/${safeName}${finalExtension}`;
}

export function publicPhotoFromRecord({ photo, assets, group }) {
  const assetByKind = new Map<string, any>(assets.map((asset) => [asset.kind, asset]));
  return {
    id: photo.id,
    group: group?.slug || DEFAULT_GROUP_SLUG,
    groupId: photo.groupId || group?.id || DEFAULT_GROUP_ID,
    groupTitle: group?.title || 'Default',
    slug: photo.slug,
    title: photo.title,
    description: photo.description || '',
    capturedAt: photo.capturedAt || null,
    sourceName: photo.sourceName || '',
    width: photo.width || 1,
    height: photo.height || 1,
    aspect: photo.aspect || 1,
    color: photo.color || 'rgb(188, 148, 57)',
    blurDataUrl: photo.blurDataUrl || '',
    sortOrder: photo.sortOrder || 0,
    status: photo.status || 'active',
    thumb: assetByKind.get('thumb')?.url || photo.thumb || '',
    medium: assetByKind.get('medium')?.url || photo.medium || '',
    large: assetByKind.get('large')?.url || photo.large || '',
    visitUrl: photo.visitUrl || '',
    workMedia: photo.workMedia || [],
    index: photo.index || 1,
  };
}

export function defaultGroup(overrides = {}) {
  const timestamp = nowIso();
  return {
    id: DEFAULT_GROUP_ID,
    slug: DEFAULT_GROUP_SLUG,
    title: 'Default Gallery',
    description: '',
    coverPhotoId: null,
    sortOrder: 0,
    visibility: 'public',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}
