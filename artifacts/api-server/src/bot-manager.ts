import { Application } from "express";
import { createBot } from "./bot/index";
import { autoRestoreBankSession } from "./bot/bank";
import { logger } from "./lib/logger";

let _app: Application | null = null;
let _botRunning = false;
let _lastBotError: string | null = null;

export function setBotManagerApp(app: Application) {
  _app = app;
}

export function isBotRunning() {
  return _botRunning;
}

export function getLastBotError() {
  return _lastBotError;
}

export async function startBot(token: string): Promise<void> {
  if (!_app) {
    throw new Error("App not registered with bot manager");
  }

  _lastBotError = null;
  logger.info("Starting Telegram bot…");

  const bot = createBot(token);

  const isProd = process.env["NODE_ENV"] === "production";
  const domain = process.env["REPLIT_DEV_DOMAIN"] ?? "";

  if (isProd && domain) {
    // ── Webhook mode (production / Docker) ──────────────────────────────────
    _app.post("/api/bot-webhook", async (req, res) => {
      try {
        await bot.handleUpdate(req.body, res);
      } catch (e) {
        logger.error({ err: e }, "bot.handleUpdate error");
        if (!res.headersSent) res.sendStatus(500);
      }
    });

    const webhookUrl = `https://${domain}/api/bot-webhook`;
    await bot.telegram.setWebhook(webhookUrl);
    logger.info({ webhookUrl }, "Telegram webhook set ✓");

    process.once("SIGINT",  () => { bot.telegram.deleteWebhook().catch(() => {}); });
    process.once("SIGTERM", () => { bot.telegram.deleteWebhook().catch(() => {}); });

  } else {
    // ── Long-polling mode (dev / Replit) ─────────────────────────────────────
    // Xoá webhook cũ nếu có (không throw nếu thất bại)
    try { await bot.telegram.deleteWebhook({ drop_pending_updates: false }); } catch { /* ok */ }

    // bot.launch() trả về Promise resolve ngay sau khi polling bắt đầu
    await bot.launch();
    logger.info("Telegram bot started (long-polling) ✓");

    process.once("SIGINT",  () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
  }

  try {
    await autoRestoreBankSession(bot);
  } catch (bankErr) {
    logger.warn({ err: bankErr }, "autoRestoreBankSession failed (non-fatal)");
  }

  _botRunning = true;
  logger.info("Telegram bot ready ✓");
}
