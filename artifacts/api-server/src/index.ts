import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "./lib/migrate";
import { db, botSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { startBot, setBotManagerApp } from "./bot-manager";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Chạy migration trước khi listen — tạo tables nếu chưa có
try {
  await runMigrations();
} catch (migErr) {
  logger.error({ err: migErr }, "Migration failed — server will still start but DB ops may fail");
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Register app with bot manager so settings route can start the bot
  setBotManagerApp(app);

  // ─── Khởi động Telegram bot ─────────────────────────────────────────────
  try {
    // Ưu tiên token trong DB (lưu qua Admin Panel > Cài đặt), fallback về env var
    let botToken: string | null = null;

    try {
      const [row] = await db
        .select()
        .from(botSettingsTable)
        .where(eq(botSettingsTable.key, "bot_token"));
      botToken = row?.value ?? null;
    } catch (dbErr) {
      logger.warn({ err: dbErr }, "Could not read bot_token from DB");
    }

    if (!botToken) {
      botToken = process.env["TELEGRAM_BOT_TOKEN"] ?? null;
    }

    if (!botToken) {
      logger.warn(
        "TELEGRAM_BOT_TOKEN not set — bot will NOT start. " +
        "Set it in Admin Panel > Cài đặt or as a Replit Secret.",
      );
      return;
    }

    await startBot(botToken);

  } catch (botErr) {
    logger.error({ err: botErr }, "Failed to start Telegram bot");
  }
});
