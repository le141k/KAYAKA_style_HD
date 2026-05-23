-- Add NUMBER to the CustomFieldType enum (Kayako parity: numeric custom fields).
-- Postgres 12+ permits ALTER TYPE ... ADD VALUE inside a migration transaction
-- as long as the new value is not used within the same transaction.
ALTER TYPE "CustomFieldType" ADD VALUE IF NOT EXISTS 'NUMBER' BEFORE 'FILE';
