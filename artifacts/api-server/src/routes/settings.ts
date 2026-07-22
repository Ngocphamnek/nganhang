import { Router } from "express";
import { db, botSettingsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { startBot, isBotRunning } from "../bot-manager";

const router = Router();

const DEFAULT_CHANNEL = "lichsuphienclmmgg";

const ADMIN_PASSWORD = "19112007vV";

function requireAdmin(req: any, res: any, next: any) {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!token || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.key, key));
  return row?.value ?? null;
}

async function setSetting(key: string, value: string) {
  await db
    .insert(botSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({
      target: botSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
}

// ─── GET /api/settings ────────────────────────────────────────────────────────
router.get("/", requireAdmin, async (_req, res) => {
  const rows = await db
    .select()
    .from(botSettingsTable)
    .where(inArray(botSettingsTable.key, ["txc_channel", "bot_token"]));

  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;

  // Bot token: return masked version or env var presence
  const rawToken = map["bot_token"] ?? process.env["TELEGRAM_BOT_TOKEN"] ?? "";
  const botTokenSet = rawToken.length > 0;
  const botTokenMasked = botTokenSet
    ? rawToken.slice(0, 8) + "…" + rawToken.slice(-4)
    : "";

  return res.json({
    txcChannel: map["txc_channel"] ?? DEFAULT_CHANNEL,
    botTokenSet,
    botTokenMasked,
  });
});

// ─── PUT /api/settings ────────────────────────────────────────────────────────
router.put("/", requireAdmin, async (req, res) => {
  const { txcChannel, botToken } = req.body as {
    txcChannel?: string;
    botToken?: string;
  };

  if (txcChannel !== undefined) {
    const val = txcChannel.trim().replace(/^@/, "");
    if (!val) {
      return res.status(400).json({ success: false, message: "Tên kênh không được rỗng." });
    }
    await setSetting("txc_channel", val);
  }

  if (botToken !== undefined) {
    const val = botToken.trim();
    if (!val) {
      return res.status(400).json({ success: false, message: "Bot token không được rỗng." });
    }
    await setSetting("bot_token", val);

    // Khởi động bot ngay nếu chưa chạy
    if (!isBotRunning()) {
      startBot(val).catch((err) => {
        console.error("Failed to start bot after token save:", err?.message ?? err);
      });
    }
  }

  return res.json({ success: true, message: null });
});

export default router;
