/**
 * Tích hợp MB Bank vào Telegram bot HARU
 * Cho phép user đăng nhập, xem số dư, lịch sử giao dịch,
 * và bật/tắt theo dõi tự động biến động số dư
 */

import { Markup, type Telegraf } from "telegraf";
import { isAdmin } from "./keyboard";
import { CoreBankService } from "../bank/core-bank";
import { TransactionMonitor } from "../bank/monitor";
import { DepositMonitor } from "../bank/deposit-monitor";
import { formatMoney, formatDate } from "../bank/format";
import { saveBankCreds, loadBankCreds, deleteBankCreds } from "../bank/session-store";
import { warmupOCR } from "../bank/captcha-ocr";
import { logger } from "../lib/logger";
import type { TransferParams } from "../bank/types";
import { db, botSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ─── Admin account info (singleton, dùng cho hướng dẫn nạp tiền) ─────────────

export interface AdminDepositInfo {
  accountNumber: string;
  accountName: string;
  bankName: string;
}

let _adminDepositInfo: AdminDepositInfo | null = null;   // từ MB Bank login
let _staticDepositInfo: AdminDepositInfo | null = null;  // cấu hình thủ công
let _depositMonitor: DepositMonitor | null = null;
let _depositMonitorAdminId: number | null = null;

/**
 * Trả về thông tin TK nhận tiền.
 * Ưu tiên: MB Bank session → cấu hình thủ công → null
 */
export function getAdminDepositInfo(): AdminDepositInfo | null {
  return _adminDepositInfo ?? _staticDepositInfo ?? null;
}

/** Đọc cấu hình STK thủ công từ DB khi khởi động bot */
export async function loadStaticDepositInfo(): Promise<void> {
  try {
    // Ưu tiên: STK thủ công (/setbank) → STK từ MB Bank login
    const rows = await db.select().from(botSettingsTable)
      .where(eq(botSettingsTable.key, "static_bank_account"));
    if (rows[0]) {
      _staticDepositInfo = JSON.parse(rows[0].value) as AdminDepositInfo;
      logger.info({ accountNumber: _staticDepositInfo.accountNumber }, "Static bank account loaded");
      return;
    }
    // Fallback: dùng TK MB Bank đã cache từ lần đăng nhập trước
    const cached = await db.select().from(botSettingsTable)
      .where(eq(botSettingsTable.key, "cached_mb_account"));
    if (cached[0]) {
      _adminDepositInfo = JSON.parse(cached[0].value) as AdminDepositInfo;
      logger.info({ accountNumber: _adminDepositInfo.accountNumber }, "Cached MB account restored from DB");
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Could not load static bank account");
  }
}

/** Lưu cấu hình STK thủ công vào DB và cập nhật cache */
export async function setStaticBankAccount(info: AdminDepositInfo): Promise<void> {
  _staticDepositInfo = info;
  await db
    .insert(botSettingsTable)
    .values({ key: "static_bank_account", value: JSON.stringify(info) })
    .onConflictDoUpdate({
      target: botSettingsTable.key,
      set: { value: JSON.stringify(info), updatedAt: new Date() },
    });
  logger.info({ accountNumber: info.accountNumber }, "Static bank account saved");
}

/** Xóa cấu hình STK thủ công */
export async function clearStaticBankAccount(): Promise<void> {
  _staticDepositInfo = null;
  await db.delete(botSettingsTable).where(eq(botSettingsTable.key, "static_bank_account"));
}

/** Trả về true nếu DepositMonitor đang chạy (tự động duyệt nạp) */
export function isDepositMonitorRunning(): boolean {
  return _depositMonitor?.isRunning() ?? false;
}

/**
 * Tự động đăng nhập MB Bank lúc startup nếu có credentials đã lưu.
 * - Nếu OCR captcha thành công → đăng nhập luôn, cache TK.
 * - Nếu OCR thất bại → gửi ảnh captcha cho admin qua Telegram để nhập tay.
 */
export async function autoRestoreBankSession(bot: Telegraf): Promise<void> {
  try {
    const rows = await db.select().from(botSettingsTable);
    const credRows = rows.filter(r => r.key.startsWith("bank_creds_"));
    for (const row of credRows) {
      try {
        const adminId = parseInt(row.key.replace("bank_creds_", ""), 10);
        if (isNaN(adminId)) continue;
        const creds = JSON.parse(row.value) as { username: string; password: string };
        const bank = getBankService(adminId);
        if (bank.getSession()) continue;
        logger.info({ adminId }, "Auto-restoring MB Bank session on startup...");
        const result = await bank.autoLogin(creds.username, creds.password);
        if (result.success) {
          await fetchAndCacheAdminAccount(bank);
          startDepositAutoMonitor(bank, bot, adminId);
          logger.info({ adminId }, "MB Bank session auto-restored on startup");
        } else if (result.needManualCaptcha && result.captchaBase64) {
          // OCR thất bại → yêu cầu admin nhập captcha thủ công qua Telegram
          logger.info({ adminId }, "OCR failed on startup — requesting manual captcha from admin");
          // Lưu state chờ captcha
          _pendingStartupCaptcha.set(adminId, {
            username: creds.username,
            password: creds.password,
            deviceId: result.deviceId ?? "",
          });
          const imgBuf = Buffer.from(result.captchaBase64, "base64");
          try {
            await bot.telegram.sendPhoto(
              adminId,
              { source: imgBuf },
              {
                caption:
                  `🔐 <b>MB Bank cần xác nhận captcha</b>\n\n` +
                  `Bot không tự nhận diện được captcha.\n` +
                  `Nhìn vào ảnh trên rồi gửi <b>mã captcha</b> (6 ký tự) để đăng nhập tự động.\n\n` +
                  `<i>Gõ /cancel để bỏ qua</i>`,
                parse_mode: "HTML",
              },
            );
          } catch (sendErr: any) {
            logger.warn({ adminId, err: sendErr.message }, "Could not send captcha image to admin");
          }
        } else {
          logger.warn({ adminId, msg: result.message }, "MB Bank auto-restore failed");
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, "Error during MB Bank auto-restore");
      }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "autoRestoreBankSession failed");
  }
}

// ─── Startup captcha pending map ─────────────────────────────────────────────
// adminId → credentials + deviceId chờ user nhập captcha
interface PendingStartupCaptcha {
  username: string;
  password: string;
  deviceId: string;
}
const _pendingStartupCaptcha = new Map<number, PendingStartupCaptcha>();

/** Kiểm tra xem user có đang chờ nhập captcha startup không. Dùng trong text handler. */
export function getPendingStartupCaptcha(adminId: number): PendingStartupCaptcha | null {
  return _pendingStartupCaptcha.get(adminId) ?? null;
}

/** Xử lý captcha admin nhập tay sau startup auto-restore thất bại. */
export async function handleStartupCaptcha(
  adminId: number,
  captchaText: string,
  bot: Telegraf,
  ctx: any,
): Promise<boolean> {
  const pending = _pendingStartupCaptcha.get(adminId);
  if (!pending) return false;
  _pendingStartupCaptcha.delete(adminId);

  try {
    const bank = getBankService(adminId);
    const result = await bank.loginManual(pending.username, pending.password, captchaText, pending.deviceId);
    if (result.success) {
      await fetchAndCacheAdminAccount(bank);
      startDepositAutoMonitor(bank, bot, adminId);
      await ctx.reply(
        `✅ <b>MB Bank đã kết nối!</b>\nBot tự động duyệt nạp tiền & QR đã sẵn sàng.`,
        { parse_mode: "HTML" },
      );
    } else {
      await ctx.reply(
        `❌ Captcha sai: ${result.message}\nDùng <code>🏦 Ngân hàng → Đăng nhập</code> để thử lại.`,
        { parse_mode: "HTML" },
      );
    }
  } catch (err: any) {
    await ctx.reply(`❌ Lỗi: ${err.message}`);
  }
  return true;
}

async function fetchAndCacheAdminAccount(bank: CoreBankService): Promise<void> {
  try {
    const balance = await bank.getBalance();
    if (balance?.accounts?.length) {
      const acc = balance.accounts[0];
      _adminDepositInfo = {
        accountNumber: acc.number,
        accountName: acc.name,
        bankName: "MB Bank",
      };
      logger.info({ accountNumber: acc.number }, "Admin deposit account cached");
      // Persist to DB so QR still works after bot restarts
      await db
        .insert(botSettingsTable)
        .values({ key: "cached_mb_account", value: JSON.stringify(_adminDepositInfo) })
        .onConflictDoUpdate({
          target: botSettingsTable.key,
          set: { value: JSON.stringify(_adminDepositInfo), updatedAt: new Date() },
        });
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Could not fetch admin account info");
  }
}

function ensureDepositMonitor(bank: CoreBankService, bot: Telegraf, adminId: number): void {
  if (_depositMonitor && _depositMonitorAdminId === adminId) return;
  // Dừng monitor cũ nếu có
  _depositMonitor?.stop();
  _depositMonitor = new DepositMonitor(bank, bot, adminId, 15);
  _depositMonitorAdminId = adminId;
}

function startDepositAutoMonitor(bank: CoreBankService, bot: Telegraf, adminId: number): void {
  ensureDepositMonitor(bank, bot, adminId);
  if (!_depositMonitor!.isRunning()) {
    _depositMonitor!.start();
    logger.info({ adminId }, "DepositMonitor auto-started after login");
  }
}

// ─── State per user ──────────────────────────────────────────────────────────

type LoginStep = "await_username" | "await_password" | "await_captcha";
type TransferStep =
  | "await_transfer_account"
  | "await_transfer_amount"
  | "await_transfer_desc"
  | "await_transfer_otp";

interface BankUserState {
  step?: LoginStep | TransferStep;
  pendingUsername?: string;
  pendingPassword?: string;
  pendingDeviceId?: string;
  // transfer state
  transfer?: {
    bankCode: string;
    bankName: string;
    toAccount?: string;
    toAccountName?: string;
    fromAccount?: string;
    amount?: number;
    description?: string;
    transactionId?: string;
  };
}

const bankUserState = new Map<number, BankUserState>();

// ─── Per-user bank service + monitor singletons ──────────────────────────────

const bankServices = new Map<number, CoreBankService>();
const bankMonitors = new Map<number, TransactionMonitor>();

function getBankService(telegramId: number): CoreBankService {
  if (!bankServices.has(telegramId)) bankServices.set(telegramId, new CoreBankService());
  return bankServices.get(telegramId)!;
}

export function isBankLoginPending(telegramId: number): boolean {
  return bankUserState.has(telegramId) && !!bankUserState.get(telegramId)?.step;
}

// ─── Keyboards ───────────────────────────────────────────────────────────────

export function bankMenuKeyboard(hasSession: boolean, monitorRunning: boolean) {
  const rows = [
    [Markup.button.callback("🔐 Đăng nhập MB Bank", "bank_login")],
  ];
  if (hasSession) {
    rows.push([
      Markup.button.callback("💰 Xem số dư", "bank_balance"),
      Markup.button.callback("📋 Lịch sử GD", "bank_history"),
    ]);
    rows.push([
      Markup.button.callback("💸 Chuyển tiền", "bank_transfer"),
    ]);
    rows.push([
      monitorRunning
        ? Markup.button.callback("⏹️ Dừng theo dõi", "bank_monitor_stop")
        : Markup.button.callback("▶️ Bật theo dõi tự động", "bank_monitor_start"),
      Markup.button.callback("🔔 Test thông báo", "bank_test"),
    ]);
    rows.push([Markup.button.callback("🚪 Đăng xuất", "bank_logout")]);
  }
  rows.push([Markup.button.callback("◀️ Quay lại", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

/** Keyboard chọn ngân hàng thụ hưởng */
function bankSelectKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🏦 MB Bank", "tf_bank_MB"),
      Markup.button.callback("💚 Vietcombank", "tf_bank_VCB"),
    ],
    [
      Markup.button.callback("🔵 Techcombank", "tf_bank_TCB"),
      Markup.button.callback("🟠 VPBank", "tf_bank_VPB"),
    ],
    [
      Markup.button.callback("🔴 Agribank", "tf_bank_VBA"),
      Markup.button.callback("🟣 BIDV", "tf_bank_BIDV"),
    ],
    [
      Markup.button.callback("🟡 ACB", "tf_bank_ACB"),
      Markup.button.callback("🔷 TPBank", "tf_bank_TPB"),
    ],
    [
      Markup.button.callback("🟤 Sacombank", "tf_bank_STB"),
      Markup.button.callback("⚪ MSB", "tf_bank_MSB"),
    ],
    [Markup.button.callback("❌ Huỷ", "bank_transfer_cancel")],
  ]);
}

const BANK_NAMES: Record<string, string> = {
  MB: "MB Bank",
  VCB: "Vietcombank",
  TCB: "Techcombank",
  VPB: "VPBank",
  VBA: "Agribank",
  BIDV: "BIDV",
  ACB: "ACB",
  TPB: "TPBank",
  STB: "Sacombank",
  MSB: "MSB",
};

// ─── Register handlers ───────────────────────────────────────────────────────

export function registerBankHandlers(bot: Telegraf): void {
  // OCR model warm-up is deferred to first login — avoids any startup interference

  // Tự động restore session từ DB khi bot khởi động
  (async () => {
    // Không có danh sách user nào ở đây — restore on-demand khi họ mở menu
  })();

  // ─── 🏦 Ngân hàng menu ───────────────────────────────────────────────────
  bot.hears("🏦 Ngân hàng", async (ctx) => {
    const tgId = ctx.from!.id;
    if (!isAdmin(tgId)) return;
    const bank = getBankService(tgId);

    // Thử tự động restore credentials nếu chưa có session
    if (!bank.getSession() && bank.hasCredentials() === false) {
      const creds = await loadBankCreds(tgId);
      if (creds) {
        ctx.reply(`🔄 <b>Đang tự động đăng nhập MB Bank...</b>`, { parse_mode: "HTML" }).catch(() => {});
        const result = await bank.autoLogin(creds.username, creds.password);
        if (!result.success) await saveBankCreds(tgId, creds); // giữ creds dù thất bại
      }
    }

    const hasSession = !!bank.getSession();
    const monitorRunning = bankMonitors.get(tgId)?.isRunning() ?? false;

    await ctx.reply(
      `🏦 <b>MB Bank — Ngân hàng số dư</b>\n\n` +
      (hasSession
        ? `✅ Đã đăng nhập: <b>${bank.getSession()!.username}</b>\n`
        : `❌ Chưa đăng nhập\n`) +
      `📡 Theo dõi tự động: <b>${monitorRunning ? "🟢 Đang chạy" : "🔴 Tắt"}</b>\n\n` +
      `Chọn chức năng bên dưới 👇`,
      { parse_mode: "HTML", ...bankMenuKeyboard(hasSession, monitorRunning) },
    );
  });

  // ─── Bắt đầu đăng nhập ───────────────────────────────────────────────────
  bot.action("bank_login", async (ctx) => {
    await ctx.answerCbQuery();
    bankUserState.set(ctx.from!.id, { step: "await_username" });
    await ctx.reply(
      `🔐 <b>Đăng nhập MB Bank</b>\n\n` +
      `Nhập <b>tên đăng nhập</b> (số điện thoại/ID MB Bank):\n` +
      `<i>Gõ /cancel để huỷ</i>`,
      { parse_mode: "HTML" },
    );
  });

  // ─── Xem số dư ───────────────────────────────────────────────────────────
  bot.action("bank_balance", async (ctx) => {
    await ctx.answerCbQuery("⏳ Đang lấy số dư...");
    const tgId = ctx.from!.id;
    const bank = getBankService(tgId);
    try {
      const balance = await bank.getBalance();
      if (!balance) { await ctx.reply("❌ Không lấy được số dư. Vui lòng đăng nhập lại."); return; }

      let text = `💰 <b>SỐ DƯ TÀI KHOẢN MB BANK</b>\n━━━━━━━━━━━━━━━━━\n`;
      for (const acc of balance.accounts) {
        text += `🏦 <code>${acc.number}</code>\n`;
        text += `   ${acc.name}\n`;
        text += `   💵 <b>${formatMoney(acc.balance)}</b>\n\n`;
      }
      text += `━━━━━━━━━━━━━━━━━\n💼 <b>Tổng:</b> ${formatMoney(balance.totalBalance)}`;
      await ctx.reply(text, { parse_mode: "HTML" });
    } catch (err: any) {
      await ctx.reply(`❌ Lỗi: ${err.message}`);
    }
  });

  // ─── Lịch sử giao dịch ───────────────────────────────────────────────────
  bot.action("bank_history", async (ctx) => {
    await ctx.answerCbQuery("⏳ Đang tải lịch sử...");
    const tgId = ctx.from!.id;
    const bank = getBankService(tgId);
    try {
      const balance = await bank.getBalance();
      if (!balance?.accounts.length) { await ctx.reply("❌ Không lấy được tài khoản."); return; }

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const today = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
      const week = new Date(now.getTime() - 7 * 86400000);
      const weekStr = `${pad(week.getDate())}/${pad(week.getMonth() + 1)}/${week.getFullYear()}`;

      const txs = await bank.getTransactions(balance.accounts[0].number, weekStr, today);
      const recent = txs.slice(0, 10);

      if (!recent.length) { await ctx.reply("📋 Không có giao dịch nào trong 7 ngày qua."); return; }

      let text = `📋 <b>LỊCH SỬ GIAO DỊCH (7 ngày)</b>\n━━━━━━━━━━━━━━━━━\n`;
      for (const tx of recent) {
        const isCredit = tx.creditAmount > 0;
        const amt = isCredit ? tx.creditAmount : tx.debitAmount;
        text += `${isCredit ? "🟢" : "🔴"} <b>${formatMoney(amt)}</b>\n`;
        text += `   📅 ${tx.transactionDate}\n`;
        text += `   📝 <i>${(tx.description || "—").slice(0, 60)}</i>\n`;
        text += `   🔖 <code>${tx.refNo || "—"}</code>\n\n`;
      }
      await ctx.reply(text, { parse_mode: "HTML" });
    } catch (err: any) {
      await ctx.reply(`❌ Lỗi: ${err.message}`);
    }
  });

  // ─── Chuyển tiền: chọn ngân hàng ─────────────────────────────────────────
  bot.action("bank_transfer", async (ctx) => {
    await ctx.answerCbQuery();
    const tgId = ctx.from!.id;
    const bank = getBankService(tgId);
    if (!bank.getSession()) { await ctx.reply("❌ Vui lòng đăng nhập trước."); return; }
    bankUserState.set(tgId, { step: "await_transfer_account" });
    await ctx.reply(
      `💸 <b>CHUYỂN TIỀN MB BANK</b>\n\n` +
      `Chọn ngân hàng thụ hưởng 👇`,
      { parse_mode: "HTML", ...bankSelectKeyboard() },
    );
  });

  bot.action("bank_transfer_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    bankUserState.delete(ctx.from!.id);
    await ctx.reply("❌ <b>Đã huỷ lệnh chuyển tiền.</b>", { parse_mode: "HTML" });
  });

  // Chọn ngân hàng → lưu vào state, hỏi số tài khoản
  for (const [code, name] of Object.entries(BANK_NAMES)) {
    bot.action(`tf_bank_${code}`, async (ctx) => {
      await ctx.answerCbQuery();
      const tgId = ctx.from!.id;
      bankUserState.set(tgId, {
        step: "await_transfer_account",
        transfer: { bankCode: code, bankName: name },
      });
      await ctx.reply(
        `🏦 Ngân hàng: <b>${name}</b>\n\n` +
        `Nhập <b>số tài khoản / số thẻ</b> người nhận:\n<i>Gõ /cancel để huỷ</i>`,
        { parse_mode: "HTML" },
      );
    });
  }

  // ─── Bật theo dõi ────────────────────────────────────────────────────────
  bot.action("bank_monitor_start", async (ctx) => {
    await ctx.answerCbQuery();
    const tgId = ctx.from!.id;
    const bank = getBankService(tgId);

    if (!bank.getSession()) { await ctx.reply("❌ Vui lòng đăng nhập trước."); return; }

    // Lấy thông tin TK nếu chưa có
    if (!_adminDepositInfo) await fetchAndCacheAdminAccount(bank);

    // Bật TransactionMonitor (thông báo biến động)
    let monitor = bankMonitors.get(tgId);
    if (!monitor) {
      monitor = new TransactionMonitor(bank, bot, tgId, 15);
      bankMonitors.set(tgId, monitor);
    }
    if (!monitor.isRunning()) monitor.start();

    // Bật DepositMonitor (tự động cộng tiền)
    startDepositAutoMonitor(bank, bot, tgId);

    const accInfo = _adminDepositInfo;
    await ctx.reply(
      `▶️ <b>Đã bật theo dõi + tự động cộng tiền!</b>\n\n` +
      `🏦 <b>Tài khoản nhận:</b> ${accInfo ? `<code>${accInfo.accountNumber}</code> — ${accInfo.accountName}` : "Chưa lấy được"}\n` +
      `⏱ Kiểm tra giao dịch mỗi <b>15 giây</b>\n` +
      `✅ Khi có giao dịch khớp <code>NAP {telegramId} {số tiền}</code>,\n` +
      `   bot sẽ tự động cộng tiền và thông báo cho user.`,
      { parse_mode: "HTML" },
    );
  });

  // ─── Tắt theo dõi ────────────────────────────────────────────────────────
  bot.action("bank_monitor_stop", async (ctx) => {
    await ctx.answerCbQuery();
    const tgId = ctx.from!.id;
    const monitor = bankMonitors.get(tgId);
    if (monitor?.isRunning()) monitor.stop();
    _depositMonitor?.stop();
    await ctx.reply(
      "⏹️ <b>Đã tắt theo dõi và tự động cộng tiền.</b>\n\nNạp tiền sẽ cần admin duyệt thủ công.",
      { parse_mode: "HTML" },
    );
  });

  // ─── Test thông báo ───────────────────────────────────────────────────────
  bot.action("bank_test", async (ctx) => {
    await ctx.answerCbQuery();
    const testMsg =
      `🔔 <b>TEST NOTIFICATION</b>\n\n` +
      `🏦 <b>Tài khoản:</b> <code>0987654321</code>\n` +
      `📅 <b>Thời gian:</b> ${new Date().toLocaleString("vi-VN")}\n` +
      `💳 <b>Loại:</b> 🟢 Nhận tiền (+)\n` +
      `💰 <b>Số tiền:</b> <b>${formatMoney(50000)}</b>\n` +
      `📝 <b>Nội dung:</b> <i>TEST NOTIFICATION HARU BOT</i>\n` +
      `🔖 <b>Mã GD:</b> <code>TEST-${Date.now()}</code>`;
    await ctx.reply(testMsg, { parse_mode: "HTML" });
  });

  // ─── Đăng xuất ───────────────────────────────────────────────────────────
  bot.action("bank_logout", async (ctx) => {
    await ctx.answerCbQuery();
    const tgId = ctx.from!.id;
    bankMonitors.get(tgId)?.stop();
    bankMonitors.delete(tgId);
    _depositMonitor?.stop();
    _depositMonitor = null;
    _depositMonitorAdminId = null;
    _adminDepositInfo = null;
    bankServices.delete(tgId);
    await deleteBankCreds(tgId);
    bankUserState.delete(tgId);
    await ctx.reply("🚪 <b>Đã đăng xuất khỏi MB Bank.\nTự động cộng tiền đã tắt.</b>", { parse_mode: "HTML" });
  });
}

// ─── Handle text messages trong login flow ───────────────────────────────────

export async function handleBankTextMessage(
  telegramId: number,
  text: string,
  bot: Telegraf,
  ctx: any,
): Promise<boolean> {
  const state = bankUserState.get(telegramId);
  if (!state?.step) return false;

  // Huỷ
  if (text === "/cancel") {
    bankUserState.delete(telegramId);
    await ctx.reply("❌ Đã huỷ.", { parse_mode: "HTML" });
    return true;
  }

  if (state.step === "await_username") {
    bankUserState.set(telegramId, { step: "await_password", pendingUsername: text.trim() });
    await ctx.reply(
      `✅ Username: <code>${text.trim()}</code>\n\nNhập <b>mật khẩu</b>:\n<i>Gõ /cancel để huỷ</i>`,
      { parse_mode: "HTML" },
    );
    return true;
  }

  if (state.step === "await_password") {
    const username = state.pendingUsername!;
    const password = text.trim();
    bankUserState.delete(telegramId);

    await ctx.reply(
      `🔄 <b>Đang đăng nhập MB Bank...</b>\n<i>Đang nhận diện captcha tự động, vui lòng chờ...</i>`,
      { parse_mode: "HTML" },
    );

    const bank = getBankService(telegramId);
    try {
      // Timeout 45s cho toàn bộ quá trình (ONNX load + 3 lần OCR + API call)
      const loginTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Quá thời gian chờ (45s). Vui lòng thử lại.")), 45_000),
      );
      const result = await Promise.race([bank.autoLogin(username, password), loginTimeout]);

      if (result.success) {
        await saveBankCreds(telegramId, { username, password });
        // Tự động lấy thông tin TK & bật DepositMonitor ngay sau khi đăng nhập
        const bank = getBankService(telegramId);
        await fetchAndCacheAdminAccount(bank);
        startDepositAutoMonitor(bank, bot, telegramId);
        const accInfo = _adminDepositInfo;
        await ctx.reply(
          `✅ <b>Đăng nhập MB Bank thành công!</b>\n\n` +
          `👤 Tài khoản: <b>${username}</b>\n` +
          (accInfo ? `🏦 Số TK nhận: <code>${accInfo.accountNumber}</code>\n` : "") +
          `\n🤖 <b>Tự động cộng tiền đã bật!</b>\n` +
          `Khi user chuyển khoản đúng nội dung, bot sẽ tự động duyệt.`,
          { parse_mode: "HTML" },
        );
        return true;
      }

      // OCR thất bại → gửi ảnh captcha cho user tự nhập
      if (result.needManualCaptcha && result.captchaBase64) {
        bankUserState.set(telegramId, {
          step: "await_captcha",
          pendingUsername: username,
          pendingPassword: password,
          pendingDeviceId: result.deviceId,
        });
        const imgBuf = Buffer.from(result.captchaBase64, "base64");
        await ctx.replyWithPhoto(
          { source: imgBuf },
          {
            caption:
              `⚠️ <b>Nhận diện captcha tự động thất bại.</b>\n\n` +
              `Nhìn vào ảnh trên và nhập <b>mã captcha</b> (6 ký tự):\n` +
              `<i>Gõ /cancel để huỷ</i>`,
            parse_mode: "HTML",
          },
        );
        return true;
      }

      await ctx.reply(
        `❌ <b>Đăng nhập thất bại</b>\n\n${result.message || "Kiểm tra lại tài khoản/mật khẩu."}\n\n` +
        `Bấm 🔐 <b>Đăng nhập MB Bank</b> để thử lại.`,
        { parse_mode: "HTML" },
      );
    } catch (err: any) {
      await ctx.reply(`❌ Lỗi kết nối: ${err.message}`, { parse_mode: "HTML" });
    }
    return true;
  }

  // User nhập captcha thủ công
  if (state.step === "await_captcha") {
    const captcha = text.trim();
    const { pendingUsername: username, pendingPassword: password, pendingDeviceId: deviceId } = state;
    bankUserState.delete(telegramId);

    if (!username || !password || !deviceId) {
      await ctx.reply("❌ Phiên đăng nhập hết hạn. Vui lòng thử lại.", { parse_mode: "HTML" });
      return true;
    }

    await ctx.reply(`🔄 <b>Đang đăng nhập với captcha: <code>${captcha}</code>...</b>`, { parse_mode: "HTML" });

    const bank = getBankService(telegramId);
    try {
      const result = await bank.loginManual(username, password, captcha, deviceId);
      if (result.success) {
        await saveBankCreds(telegramId, { username, password });
        await fetchAndCacheAdminAccount(bank);
        startDepositAutoMonitor(bank, bot, telegramId);
        const accInfo = _adminDepositInfo;
        await ctx.reply(
          `✅ <b>Đăng nhập MB Bank thành công!</b>\n\n` +
          `👤 Tài khoản: <b>${username}</b>\n` +
          (accInfo ? `🏦 Số TK nhận: <code>${accInfo.accountNumber}</code>\n` : "") +
          `\n🤖 <b>Tự động cộng tiền đã bật!</b>`,
          { parse_mode: "HTML" },
        );
      } else {
        await ctx.reply(
          `❌ <b>Đăng nhập thất bại:</b> ${result.message || "Captcha sai hoặc hết hạn."}\n\n` +
          `Bấm 🔐 <b>Đăng nhập MB Bank</b> để thử lại.`,
          { parse_mode: "HTML" },
        );
      }
    } catch (err: any) {
      await ctx.reply(`❌ Lỗi: ${err.message}`, { parse_mode: "HTML" });
    }
    return true;
  }

  // ─── Transfer state machine ─────────────────────────────────────────────

  if (state.step === "await_transfer_account") {
    const accountNo = text.trim().replace(/\s/g, "");
    const tf = state.transfer;
    if (!tf) { bankUserState.delete(telegramId); return true; }

    const bank = getBankService(telegramId);
    await ctx.reply(`🔍 <b>Đang tra cứu tài khoản...</b>`, { parse_mode: "HTML" });
    try {
      const info = await bank.inquiryAccount(accountNo, tf.bankCode);
      if (!info || !info.accountName) {
        await ctx.reply("❌ Không tìm thấy tài khoản. Kiểm tra lại số tài khoản hoặc ngân hàng.");
        return true;
      }
      bankUserState.set(telegramId, {
        ...state,
        step: "await_transfer_amount",
        transfer: { ...tf, toAccount: accountNo, toAccountName: info.accountName },
      });
      await ctx.reply(
        `✅ <b>Tìm thấy tài khoản:</b>\n\n` +
        `👤 <b>Chủ TK:</b> ${info.accountName}\n` +
        `🏦 <b>Số TK:</b> <code>${accountNo}</code>\n` +
        `🏛️ <b>Ngân hàng:</b> ${tf.bankName}\n\n` +
        `Nhập <b>số tiền</b> cần chuyển (VNĐ):\n` +
        `<i>Ví dụ: 50000 hoặc 1000000</i>`,
        { parse_mode: "HTML" },
      );
    } catch (err: any) {
      await ctx.reply(`❌ Lỗi tra cứu: ${err.message}`);
    }
    return true;
  }

  if (state.step === "await_transfer_amount") {
    const raw = text.trim().replace(/[.,\s]/g, "");
    const amount = parseInt(raw, 10);
    if (isNaN(amount) || amount < 1000) {
      await ctx.reply("❌ Số tiền không hợp lệ. Tối thiểu 1.000đ. Nhập lại:");
      return true;
    }
    const tf = state.transfer!;
    bankUserState.set(telegramId, {
      ...state,
      step: "await_transfer_desc",
      transfer: { ...tf, amount },
    });
    await ctx.reply(
      `💰 Số tiền: <b>${formatMoney(amount)}</b>\n\n` +
      `Nhập <b>nội dung chuyển khoản</b>:\n<i>Gõ /cancel để huỷ</i>`,
      { parse_mode: "HTML" },
    );
    return true;
  }

  if (state.step === "await_transfer_desc") {
    const description = text.trim().slice(0, 100);
    const tf = state.transfer!;
    const updatedTf = { ...tf, description };

    // Lấy tài khoản nguồn từ balance
    const bank = getBankService(telegramId);
    let fromAccount = tf.fromAccount || "";
    if (!fromAccount) {
      try {
        const bal = await bank.getBalance();
        fromAccount = bal?.accounts?.[0]?.number || "";
      } catch { /* ignore */ }
    }
    updatedTf.fromAccount = fromAccount;

    // Hiện xác nhận
    bankUserState.set(telegramId, {
      ...state,
      step: "await_transfer_otp",
      transfer: updatedTf,
    });

    await ctx.reply(
      `📋 <b>XÁC NHẬN CHUYỂN TIỀN</b>\n━━━━━━━━━━━━━━━━━\n` +
      `🏛️ <b>Ngân hàng:</b> ${tf.bankName}\n` +
      `👤 <b>Người nhận:</b> ${tf.toAccountName}\n` +
      `💳 <b>Số TK:</b> <code>${tf.toAccount}</code>\n` +
      `💰 <b>Số tiền:</b> <b>${formatMoney(updatedTf.amount!)}</b>\n` +
      `📝 <b>Nội dung:</b> <i>${description}</i>\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `🔄 <b>Đang khởi tạo lệnh chuyển...</b>`,
      { parse_mode: "HTML" },
    );

    // Khởi tạo lệnh chuyển tiền
    try {
      const result = await bank.initiateTransfer({
        fromAccount,
        toAccount: tf.toAccount!,
        toAccountName: tf.toAccountName!,
        bankCode: tf.bankCode,
        bankName: tf.bankName,
        amount: updatedTf.amount!,
        description,
      });

      if (result.success) {
        // Chuyển xong ngay (không cần OTP)
        bankUserState.delete(telegramId);
        await ctx.reply(
          `✅ <b>CHUYỂN TIỀN THÀNH CÔNG!</b>\n\n` +
          `💸 <b>${formatMoney(updatedTf.amount!)}</b> → ${tf.toAccountName}\n` +
          `🔖 Mã GD: <code>${result.transactionId || "N/A"}</code>`,
          { parse_mode: "HTML" },
        );
        return true;
      }

      if (result.requiresOtp) {
        bankUserState.set(telegramId, {
          ...state,
          step: "await_transfer_otp",
          transfer: { ...updatedTf, transactionId: result.transactionId },
        });
        await ctx.reply(
          `📱 <b>Nhập mã OTP</b>\n\n` +
          `MB Bank vừa gửi OTP về điện thoại của bạn.\n` +
          `Nhập mã OTP (6 chữ số) để xác nhận:\n` +
          `<i>Gõ /cancel để huỷ</i>`,
          { parse_mode: "HTML" },
        );
        return true;
      }

      // Lỗi thực sự
      bankUserState.delete(telegramId);
      await ctx.reply(`❌ <b>Chuyển tiền thất bại:</b>\n${result.message}`, { parse_mode: "HTML" });
    } catch (err: any) {
      bankUserState.delete(telegramId);
      await ctx.reply(`❌ <b>Lỗi:</b> ${err.message}`, { parse_mode: "HTML" });
    }
    return true;
  }

  if (state.step === "await_transfer_otp") {
    const otp = text.trim().replace(/\s/g, "");
    const tf = state.transfer!;
    bankUserState.delete(telegramId);

    if (!tf.transactionId) {
      await ctx.reply("❌ Phiên chuyển tiền hết hạn. Vui lòng thử lại.", { parse_mode: "HTML" });
      return true;
    }

    await ctx.reply(`🔄 <b>Đang xác nhận OTP...</b>`, { parse_mode: "HTML" });
    const bank = getBankService(telegramId);
    try {
      const result = await bank.confirmTransfer(tf.transactionId, otp);
      if (result.success) {
        await ctx.reply(
          `✅ <b>CHUYỂN TIỀN THÀNH CÔNG!</b>\n\n` +
          `💸 <b>${formatMoney(tf.amount!)}</b> → ${tf.toAccountName}\n` +
          `🏛️ ${tf.bankName} — <code>${tf.toAccount}</code>\n` +
          `📝 <i>${tf.description}</i>`,
          { parse_mode: "HTML" },
        );
      } else {
        await ctx.reply(
          `❌ <b>OTP sai hoặc hết hạn:</b>\n${result.message}`,
          { parse_mode: "HTML" },
        );
      }
    } catch (err: any) {
      await ctx.reply(`❌ Lỗi xác nhận: ${err.message}`, { parse_mode: "HTML" });
    }
    return true;
  }

  return false;
}
