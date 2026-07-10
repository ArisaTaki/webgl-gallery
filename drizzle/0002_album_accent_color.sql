ALTER TABLE "groups"
ADD COLUMN IF NOT EXISTS "accent_color" varchar(7) NOT NULL DEFAULT '';
