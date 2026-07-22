import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { db, botSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const API_ID = parseInt(process.env["TELEGRAM_API_ID"] ?? "35029605");
const API_HASH = process.env["TELEGRAM_API_HASH"] ?? "1915336c87ee8bf9d948253e9e9b9c1a";

let _mainClient: TelegramClient | null = null;

// ─── DB session persistence ───────────────────────────────────────────────────

export async function loadSession(): Promise<string | null> {
  try {
    const [row] = await db
      .select()
      .from(botSettingsTable)
      .where(eq(botSettingsTable.key, "telegram_session"));
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function saveSession(sessionStr: string): Promise<void> {
  await db
    .insert(botSettingsTable)
    .values({ key: "telegram_session", value: sessionStr })
    .onConflictDoUpdate({
      target: botSettingsTable.key,
      set: { value: sessionStr, updatedAt: new Date() },
    });
}

// ─── Main connected client ────────────────────────────────────────────────────

export async function getMainClient(): Promise<TelegramClient | null> {
  if (_mainClient?.connected) return _mainClient;

  const sessionStr = await loadSession();
  if (!sessionStr) return null;

  try {
    _mainClient = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, {
      connectionRetries: 3,
      retryDelay: 1000,
      autoReconnect: true,
    });
    await _mainClient.connect();
    logger.info("MTProto client connected from saved session");
    return _mainClient;
  } catch (err) {
    logger.error({ err }, "MTProto reconnect failed");
    _mainClient = null;
    return null;
  }
}

// ─── Interactive auth (driven by promise callbacks) ──────────────────────────

export async function startInteractiveAuth(callbacks: {
  onNeedPhone: () => Promise<string>;
  onNeedCode: () => Promise<string>;
  onNeedPassword: () => Promise<string>;
}): Promise<"success" | "error"> {
  try {
    const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
      connectionRetries: 3,
    });
    await client.connect();

    await client.start({
      phoneNumber: callbacks.onNeedPhone,
      phoneCode: callbacks.onNeedCode,
      password: callbacks.onNeedPassword,
      onError: (err: any) => {
        logger.error({ err }, "Telegram auth error");
        // Throw để dừng vòng lặp retry của GramJS, đặc biệt với FloodWaitError
        throw err;
      },
    });

    const sessionStr = client.session.save() as unknown as string;
    await saveSession(sessionStr);
    _mainClient = client;
    logger.info("MTProto interactive auth succeeded");
    return "success";
  } catch (err) {
    logger.error({ err }, "startInteractiveAuth failed");
    return "error";
  }
}

export function resetClient(): void {
  if (_mainClient) {
    _mainClient.disconnect().catch(() => {});
    _mainClient = null;
  }
}
