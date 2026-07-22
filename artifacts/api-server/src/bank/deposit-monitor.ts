/**
 * DepositMonitor — Theo dõi giao dịch MB Bank và tự động cộng tiền cho user
 *
 * Flow:
 *   1. Poll giao dịch tài khoản admin mỗi 15 giây
 *   2. Với mỗi giao dịch MỚI có tiền VÀO (+):
 *      - Parse nội dung: NAP {telegramId} {amount}
 *      - Gọi addBalance() → cộng vào số dư user
 *      - Tặng thêm bonus nếu đang trong khung giờ sự kiện
 *      - Gửi thông báo cho user + admin
 */

import { Markup, type Telegraf } from "telegraf";
import { CoreBankService } from "./core-bank";
import { formatMoney } from "./format";
import { logger } from "../lib/logger";
import { addBalance, getActiveKeyProducts } from "../bot/db";
import { isDepositBonusActive, DEPOSIT_BONUS_PCT } from "../bot/events";
import { consumeDepositSession } from "../bot/deposit-session";

/** Regex khớp mã HARU88XXXXXXXX (8 ký tự, không dấu gạch) trong nội dung chuyển khoản */
const HARU_REGEX = /\bHARU88([A-Z0-9]{8})\b/i;

function parseHaruCode(description: string): string | null {
  const m = HARU_REGEX.exec(description);
  if (!m) return null;
  return `HARU88${m[1].toUpperCase()}`;
}

export class DepositMonitor {
  private timer: NodeJS.Timeout | null = null;
  private seenTxIds = new Set<string>();
  private readonly MAX_SEEN = 2000;
  private running = false;
  private readonly intervalMs: number;

  constructor(
    private readonly bank: CoreBankService,
    private readonly bot: Telegraf,
    private readonly adminChatId: number,
    intervalSeconds = 15,
  ) {
    this.intervalMs = Math.max(10, intervalSeconds) * 1000;
  }

  isRunning(): boolean { return this.running; }

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info({ adminChatId: this.adminChatId }, "DepositMonitor started");
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    logger.info({ adminChatId: this.adminChatId }, "DepositMonitor stopped");
  }

  private schedule(): void {
    if (this.running) this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try { await this.checkTransactions(); }
    catch (err: any) { logger.warn({ err: err.message }, "DepositMonitor tick error"); }
    finally { this.schedule(); }
  }

  private async checkTransactions(): Promise<void> {
    // Đảm bảo session còn sống
    let session = this.bank.getSession();
    if (!session?.sessionId) {
      if (!this.bank.hasCredentials()) return;
      const ok = await this.bank.reAuthenticate();
      if (!ok) return;
      session = this.bank.getSession();
      if (!session?.sessionId) return;
    }

    // Lấy số tài khoản chính
    const balance = await this.bank.getBalance();
    const accounts = balance?.accounts ?? [];
    if (!accounts.length) return;
    const mainAccount = accounts[0].number;

    // Khoảng ngày: hôm nay + hôm qua (đề phòng giao dịch đêm)
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    const todayStr = fmt(now);
    const yestStr = fmt(new Date(now.getTime() - 86_400_000));

    const txList = await this.bank.getTransactions(mainAccount, yestStr, todayStr);

    // Duyệt theo thứ tự thời gian (cũ → mới)
    const chron = [...txList].reverse();

    for (const tx of chron) {
      const txId = tx.refNo || `${tx.transactionDate}-${tx.creditAmount}-${tx.debitAmount}-${tx.description}`;

      // Chỉ xử lý giao dịch TIỀN VÀO chưa thấy
      if (this.seenTxIds.has(txId)) continue;

      // Quản lý kích thước set
      if (this.seenTxIds.size >= this.MAX_SEEN) {
        const arr = [...this.seenTxIds];
        arr.slice(0, this.MAX_SEEN / 2).forEach(id => this.seenTxIds.delete(id));
      }
      this.seenTxIds.add(txId);

      // Chỉ xử lý giao dịch CÓ TIỀN VÀO
      if (!(tx.creditAmount > 0)) continue;

      await this.processCredit(tx, txId);
    }
  }

  private async processCredit(tx: any, txId: string): Promise<void> {
    const desc = (tx.description ?? "") as string;
    const code = parseHaruCode(desc);

    if (!code) {
      // Giao dịch không có mã HARU88 — bỏ qua, TransactionMonitor đã thông báo biến động rồi
      return;
    }

    // Tìm phiên nạp khớp với mã
    const session = consumeDepositSession(code);
    if (!session) {
      await this.notifyAdmin(
        `⚠️ <b>Mã nạp không tìm thấy hoặc đã hết hạn</b>\n` +
        `Mã: <code>${code}</code>\n` +
        `💰 +${formatMoney(tx.creditAmount)}\n` +
        `📝 <i>${desc}</i>\n` +
        `💡 Cần cộng thủ công nếu cần.`,
      );
      return;
    }

    const { telegramId, amount: expectedAmount } = session;
    const actualAmount = tx.creditAmount as number;

    // Từ chối nếu số tiền không khớp chính xác
    if (Math.abs(actualAmount - expectedAmount) > 1) {
      await this.notifyAdmin(
        `⚠️ <b>Số tiền KHÔNG KHỚP — không cộng tự động!</b>\n` +
        `Phiên yêu cầu: <b>${formatMoney(expectedAmount)} VND</b>\n` +
        `Thực nhận: <b>${formatMoney(actualAmount)} VND</b>\n` +
        `Mã: <code>${code}</code> · User: <code>${telegramId}</code>\n\n` +
        `💡 Cần xử lý thủ công nếu muốn cộng tiền.`,
      );
      // Thông báo cho user biết lý do
      try {
        await this.bot.telegram.sendMessage(
          telegramId,
          `⚠️ <b>Nạp tiền KHÔNG thành công!</b>\n\n` +
          `Số tiền bạn chuyển (<b>${formatMoney(actualAmount)} VND</b>) không khớp với phiên nạp (<b>${formatMoney(expectedAmount)} VND</b>).\n\n` +
          `Vui lòng liên hệ admin để được xử lý.\n` +
          `🔖 Mã phiên: <code>${code}</code>`,
          { parse_mode: "HTML" },
        );
      } catch { /* ignore */ }
      return;
    }

    // Tính bonus sự kiện
    const bonusActive = isDepositBonusActive();
    const bonusAmount = bonusActive ? Math.floor(actualAmount * DEPOSIT_BONUS_PCT / 100) : 0;
    const totalCredit = actualAmount + bonusAmount;

    try {
      await addBalance(
        telegramId,
        totalCredit,
        `Nạp tiền qua MB Bank${bonusActive ? ` (+${DEPOSIT_BONUS_PCT}% bonus)` : ""} [${code}]`,
        txId,
      );
    } catch (err: any) {
      logger.error({ telegramId, code, txId, err: err.message }, "DepositMonitor: addBalance failed");
      await this.notifyAdmin(
        `❌ <b>Cộng tiền thất bại!</b>\n` +
        `User: <code>${telegramId}</code> · Mã: <code>${code}</code>\n` +
        `Số tiền: ${formatMoney(actualAmount)}\n` +
        `Lỗi: ${err.message}`,
      );
      return;
    }

    // Thông báo cho user
    let userMsg =
      `✅ <b>NẠP TIỀN THÀNH CÔNG!</b>\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `💰 <b>Đã cộng: +${formatMoney(actualAmount)} VND</b>\n`;
    if (bonusActive && bonusAmount > 0) {
      userMsg += `🎁 <b>Bonus sự kiện: +${formatMoney(bonusAmount)} VND (+${DEPOSIT_BONUS_PCT}%)</b>\n`;
    }
    userMsg +=
      `📊 <b>Tổng cộng: +${formatMoney(totalCredit)} VND</b>\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `🔖 Mã: <code>${code}</code>\n` +
      `📅 ${tx.transactionDate || new Date().toLocaleDateString("vi-VN")}\n\n` +
      `🛒 <b>Chọn gói key bên dưới để kích hoạt ngay!</b>`;

    // Lấy danh sách key đang bán để hiện nút mua luôn
    try {
      const products = await getActiveKeyProducts();
      if (products.length > 0) {
        const TIER_EMOJI: Record<string, string> = {
          "Key Test":      "🟢",
          "Key Phổ Thông": "🔵",
          "Key VIP":       "🟣",
          "Key SVIP":      "🔴",
          "Key SSVIP":     "💜",
          "Key SSSVIP":    "👑",
        };
        const buttons = products.map((p) => {
          const emoji = TIER_EMOJI[p.name] ?? "⚪";
          const price = parseFloat(p.price as string).toLocaleString("vi-VN");
          const days = p.durationDays;
          const dur = days === 1 ? "1 ngày" : days === 7 ? "7 ngày" : days === 30 ? "30 ngày"
            : days === 180 ? "6 tháng" : days === 365 ? "1 năm" : days === 540 ? "18 tháng" : `${days} ngày`;
          return [Markup.button.callback(`${emoji} ${p.name} — ${price}đ / ${dur}`, `buy_${p.id}`)];
        });
        await this.bot.telegram.sendMessage(telegramId, userMsg, {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard(buttons),
        });
      } else {
        await this.bot.telegram.sendMessage(telegramId, userMsg, { parse_mode: "HTML" });
      }
    } catch (err: any) {
      logger.warn({ telegramId, err: err.message }, "DepositMonitor: cannot notify user");
    }

    // Thông báo admin
    await this.notifyAdmin(
      `✅ <b>Tự động cộng tiền thành công</b>\n` +
      `👤 User: <code>${telegramId}</code>\n` +
      `🔖 Mã: <code>${code}</code>\n` +
      `💰 Nhận: ${formatMoney(actualAmount)}${bonusActive ? ` + ${formatMoney(bonusAmount)} bonus` : ""}\n` +
      `📊 Tổng: <b>${formatMoney(totalCredit)} VND</b>`,
    );

    logger.info({ telegramId, code, actualAmount, bonusAmount, txId }, "DepositMonitor: auto-credited");
  }

  private async notifyAdmin(text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(this.adminChatId, text, { parse_mode: "HTML" });
    } catch (err: any) {
      logger.warn({ err: err.message }, "DepositMonitor: cannot notify admin");
    }
  }
}
