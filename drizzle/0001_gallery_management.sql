CREATE TABLE IF NOT EXISTS "groups" (
  "id" varchar(80) PRIMARY KEY NOT NULL,
  "slug" varchar(120) NOT NULL UNIQUE,
  "title" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "cover_photo_id" varchar(120),
  "sort_order" integer NOT NULL DEFAULT 0,
  "visibility" varchar(20) NOT NULL DEFAULT 'public',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "photos" (
  "id" varchar(120) PRIMARY KEY NOT NULL,
  "group_id" varchar(80) NOT NULL REFERENCES "groups"("id"),
  "slug" varchar(140) NOT NULL UNIQUE,
  "title" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "captured_at" timestamp with time zone,
  "source_name" text NOT NULL DEFAULT '',
  "width" integer NOT NULL DEFAULT 1,
  "height" integer NOT NULL DEFAULT 1,
  "aspect" real NOT NULL DEFAULT 1,
  "color" varchar(60) NOT NULL DEFAULT 'rgb(188, 148, 57)',
  "blur_data_url" text NOT NULL DEFAULT '',
  "sort_order" integer NOT NULL DEFAULT 0,
  "status" varchar(20) NOT NULL DEFAULT 'active',
  "visit_url" text NOT NULL DEFAULT '',
  "work_media" text NOT NULL DEFAULT '[]',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "photo_assets" (
  "id" varchar(160) PRIMARY KEY NOT NULL,
  "photo_id" varchar(120) NOT NULL REFERENCES "photos"("id"),
  "kind" varchar(24) NOT NULL,
  "r2_key" text NOT NULL,
  "url" text NOT NULL DEFAULT '',
  "width" integer NOT NULL DEFAULT 1,
  "height" integer NOT NULL DEFAULT 1,
  "size_bytes" integer NOT NULL DEFAULT 0,
  "mime_type" varchar(120) NOT NULL DEFAULT 'application/octet-stream',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "groups_visibility_idx" ON "groups" ("visibility");
CREATE INDEX IF NOT EXISTS "groups_sort_idx" ON "groups" ("sort_order");
CREATE INDEX IF NOT EXISTS "photos_group_idx" ON "photos" ("group_id");
CREATE INDEX IF NOT EXISTS "photos_status_idx" ON "photos" ("status");
CREATE INDEX IF NOT EXISTS "photos_sort_idx" ON "photos" ("sort_order");
CREATE INDEX IF NOT EXISTS "photo_assets_photo_idx" ON "photo_assets" ("photo_id");
CREATE INDEX IF NOT EXISTS "photo_assets_kind_idx" ON "photo_assets" ("kind");

INSERT INTO "groups" ("id", "slug", "title", "description", "sort_order", "visibility")
VALUES ('default', 'default', 'Default Gallery', '', 0, 'public')
ON CONFLICT ("id") DO NOTHING;

