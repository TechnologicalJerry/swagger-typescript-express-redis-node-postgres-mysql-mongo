-- AlterTable
ALTER TABLE "users" ADD COLUMN "is_email_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "email_verified_at" TIMESTAMP(3);
