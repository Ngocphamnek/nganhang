import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Tạo toàn bộ tables nếu chưa tồn tại.
 * Chạy mỗi lần server khởi động — idempotent, an toàn khi chạy nhiều lần.
 */
export async function runMigrations(): Promise<void> {
  logger.info("Running database migrations…");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "telegram_users" (
      "id"           SERIAL PRIMARY KEY,
      "telegram_id"  BIGINT        NOT NULL UNIQUE,
      "username"     TEXT,
      "first_name"   TEXT,
      "last_name"    TEXT,
      "balance"      NUMERIC(18,2) NOT NULL DEFAULT 0,
      "referred_by"  BIGINT,
      "created_at"   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      "updated_at"   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "key_products" (
      "id"            SERIAL PRIMARY KEY,
      "name"          TEXT          NOT NULL,
      "description"   TEXT,
      "game"          TEXT          NOT NULL,
      "price"         NUMERIC(18,2) NOT NULL,
      "duration_days" INTEGER       NOT NULL DEFAULT 30,
      "is_active"     BOOLEAN       NOT NULL DEFAULT TRUE,
      "created_at"    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "keys" (
      "id"                  SERIAL PRIMARY KEY,
      "key_code"            TEXT        NOT NULL UNIQUE,
      "product_id"          INTEGER     NOT NULL,
      "used_by_telegram_id" TEXT,
      "used_at"             TIMESTAMPTZ,
      "expires_at"          TIMESTAMPTZ,
      "is_used"             BOOLEAN     NOT NULL DEFAULT FALSE,
      "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "transactions" (
      "id"           SERIAL PRIMARY KEY,
      "telegram_id"  BIGINT        NOT NULL,
      "type"         TEXT          NOT NULL,
      "amount"       NUMERIC(18,2) NOT NULL,
      "description"  TEXT,
      "status"       TEXT          NOT NULL DEFAULT 'pending',
      "reference_id" TEXT,
      "created_at"   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "bot_settings" (
      "key"        TEXT        PRIMARY KEY,
      "value"      TEXT        NOT NULL,
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "prediction_logs" (
      "id"              SERIAL PRIMARY KEY,
      "game_key"        TEXT        NOT NULL,
      "session_id"      INTEGER     NOT NULL,
      "action"          TEXT        NOT NULL,
      "predicted_label" TEXT,
      "actual_label"    TEXT,
      "confidence"      INTEGER     NOT NULL,
      "trend_score"     INTEGER,
      "freq_score"      INTEGER,
      "rev_score"       INTEGER,
      "is_correct"      BOOLEAN,
      "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "verified_at"     TIMESTAMPTZ,
      "hour_of_day"     INTEGER
    )
  `);

  logger.info("Database migrations complete ✓");
}
