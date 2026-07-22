/**
 * Transaction Monitor — theo dõi giao dịch MB Bank và thông báo qua Telegram
 */

import type { Telegraf } from "telegraf";
import { CoreBankService } from "./core-bank";
import { formatMoney } from "./format";
import { logger } from "../lib/logger";

export class TransactionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private seenTxIds = new Set<string>();
  private readonly MAX_SEEN = 2000;
  private running = false;
  private intervalMs: number;

  constructor(
    private readonly bank: CoreBankService,
    private readonly bot: Telegraf,
    private readonly chatId: number,
    intervalSeconds = 15,
  ) {
    this.intervalMs = Math.max(10, intervalSeconds) * 1000;
  }

  isRunning(): boolean { return this.running; }

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info({ chatId: this.chatId }, "Bank monitor started");
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    logger.info({ chatId: this.chatId }, "Bank monitor stopped");
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.checkTransactions();
    } catch (err: any) {
      logger.warn({ chatId: this.chatId, err: err.message }, "Monitor tick error");
    } finally {
      if (this.running) {
        this.timer = setTimeout(() => this.tick(), this.intervalMs);
      }
    }
  }

  private async checkTransactions(): Promise<void> {
    let session = this.bank.getSession();
    if (!session?.sessionId) {
      if (!this.bank.hasCredentials()) return;
      const ok = await this.bank.reAuthenticate();
      if (!ok) return;
      session = this.bank.getSession();
      if (!session?.sessionId) return;
    }

    const balance = await this.bank.getBalance();
    const accounts = balance?.accounts ?? [];
    if (!accounts.length) return;

    const mainAccount = accounts[0].number;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    const yesterday = new Date(now.getTime() - 86400000);
    const yestStr = `${pad(yesterday.getDate())}/${pad(yesterday.getMonth() + 1)}/${yesterday.getFullYear()}`;

    const txList = await this.bank.getTransactions(mainAccount, yestStr, todayStr);
    const chron = [...txList].reverse();

    for (const tx of chron) {
      const txId = tx.refNo || `${tx.transactionDate}-${tx.creditAmount}-${tx.debitAmount}`;
      if (this.seenTxIds.has(txId)) continue;

      if (this.seenTxIds.size >= this.MAX_SEEN) {
        const arr = [...this.seenTxIds];
        arr.slice(0, this.MAX_SEEN / 2).forEach(id => this.seenTxIds.delete(id));
      }
      this.seenTxIds.add(txId);

      await this.sendNotification(tx, mainAccount);
    }
  }

  private async sendNotification(tx: any, accountNo: string): Promise<void> {
    const isCredit = tx.creditAmount > 0;
    const amount = isCredit ? tx.creditAmount : tx.debitAmount;
    const emoji = isCredit ? "🟢" : "🔴";
    const typeStr = isCredit ? "Nhận tiền (+)" : "Trừ tiền (-)";

    const msg =
      `🔔 <b>BIẾN ĐỘNG SỐ DƯ</b>\n\n` +
      `🏦 <b>Tài khoản:</b> <code>${accountNo}</code>\n` +
      `📅 <b>Thời gian:</b> ${tx.transactionDate}\n` +
      `💳 <b>Loại:</b> ${emoji} ${typeStr}\n` +
      `💰 <b>Số tiền:</b> <b>${formatMoney(amount)}</b>\n` +
      `📝 <b>Nội dung:</b> <i>${tx.description || "—"}</i>\n` +
      `🔖 <b>Mã GD:</b> <code>${tx.refNo || "—"}</code>`;

    try {
      await this.bot.telegram.sendMessage(this.chatId, msg, { parse_mode: "HTML" });
    } catch (err: any) {
      logger.warn({ chatId: this.chatId, err: err.message }, "Failed to send bank notification");
    }
  }
}
