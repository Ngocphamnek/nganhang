/**
 * Lưu/đọc thông tin đăng nhập MB Bank theo từng Telegram user trong bảng bot_settings
 */

import { db, botSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

interface BankCreds { username: string; password: string }

function key(telegramId: number) { return `bank_creds_${telegramId}`; }

export async function saveBankCreds(telegramId: number, creds: BankCreds): Promise<void> {
  await db.insert(botSettingsTable)
    .values({ key: key(telegramId), value: JSON.stringify(creds) })
    .onConflictDoUpdate({
      target: botSettingsTable.key,
      set: { value: JSON.stringify(creds), updatedAt: new Date() },
    });
}

export async function loadBankCreds(telegramId: number): Promise<BankCreds | null> {
  const [row] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.key, key(telegramId)));
  if (!row) return null;
  try { return JSON.parse(row.value) as BankCreds; }
  catch { return null; }
}

export async function deleteBankCreds(telegramId: number): Promise<void> {
  await db.delete(botSettingsTable).where(eq(botSettingsTable.key, key(telegramId)));
}
