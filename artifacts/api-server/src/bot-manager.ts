import { Application } from "express";
import { createBot } from "./bot/index";
import { autoRestoreBankSession } from "./bot/bank";
import { logger } from "./lib/logger";

let _app: Application | null = null;
let _botRunning = false;

export function setBotManagerApp(app: Application) {
  _app = app;
}

export function isBotRunning() {
  return _botRunning;
}

export async function startBot(token: string): Promise<void> {
  if (!_app) {
    throw new Error("App not registered with bot manager");
  }

  logger.info("Starting Telegram bot via webhook…");
  const bot = createBot(token);

  // Remove old webhook handler if re-starting
  _app.post("/api/bot-webhook", async (req, res) => {
    try {
      await bot.handleUpdate(req.body, res);
    } catch (e) {
      logger.error({ err: e }, "bot.handleUpdate error");
      if (!res.headersSent) res.sendStatus(500);
    }
  });

  const domain = process.env["REPLIT_DEV_DOMAIN"] ?? "";
  const webhookUrl = `https://${domain}/api/bot-webhook`;

  await bot.telegram.setWebhook(webhookUrl);
  logger.info({ webhookUrl }, "Telegram webhook set ✓");

  try {
    await autoRestoreBankSession(bot);
  } catch (bankErr) {
    logger.warn({ err: bankErr }, "autoRestoreBankSession failed (non-fatal)");
  }

  process.once("SIGINT",  () => { bot.telegram.deleteWebhook().catch(() => {}); });
  process.once("SIGTERM", () => { bot.telegram.deleteWebhook().catch(() => {}); });

  _botRunning = true;
  logger.info("Telegram bot ready ✓");
}
