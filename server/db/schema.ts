import { index, integer, pgTable, real, text, timestamp, varchar } from 'drizzle-orm/pg-core';

export const galleryGroups = pgTable(
  'groups',
  {
    id: varchar('id', { length: 80 }).primaryKey(),
    slug: varchar('slug', { length: 120 }).notNull().unique(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    coverPhotoId: varchar('cover_photo_id', { length: 120 }),
    sortOrder: integer('sort_order').notNull().default(0),
    visibility: varchar('visibility', { length: 20 }).notNull().default('public'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    visibilityIdx: index('groups_visibility_idx').on(table.visibility),
    sortIdx: index('groups_sort_idx').on(table.sortOrder),
  }),
);

export const photos = pgTable(
  'photos',
  {
    id: varchar('id', { length: 120 }).primaryKey(),
    groupId: varchar('group_id', { length: 80 })
      .notNull()
      .references(() => galleryGroups.id),
    slug: varchar('slug', { length: 140 }).notNull().unique(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    sourceName: text('source_name').notNull().default(''),
    width: integer('width').notNull().default(1),
    height: integer('height').notNull().default(1),
    aspect: real('aspect').notNull().default(1),
    color: varchar('color', { length: 60 }).notNull().default('rgb(188, 148, 57)'),
    blurDataUrl: text('blur_data_url').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    visitUrl: text('visit_url').notNull().default(''),
    workMedia: text('work_media').notNull().default('[]'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    groupIdx: index('photos_group_idx').on(table.groupId),
    statusIdx: index('photos_status_idx').on(table.status),
    sortIdx: index('photos_sort_idx').on(table.sortOrder),
  }),
);

export const photoAssets = pgTable(
  'photo_assets',
  {
    id: varchar('id', { length: 160 }).primaryKey(),
    photoId: varchar('photo_id', { length: 120 })
      .notNull()
      .references(() => photos.id),
    kind: varchar('kind', { length: 24 }).notNull(),
    r2Key: text('r2_key').notNull(),
    url: text('url').notNull().default(''),
    width: integer('width').notNull().default(1),
    height: integer('height').notNull().default(1),
    sizeBytes: integer('size_bytes').notNull().default(0),
    mimeType: varchar('mime_type', { length: 120 }).notNull().default('application/octet-stream'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    photoIdx: index('photo_assets_photo_idx').on(table.photoId),
    kindIdx: index('photo_assets_kind_idx').on(table.kind),
  }),
);

