/**
 * Auto-play engine for Xúc Xắc
 * Manages per-user Telegram sessions and the betting loop.
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Markup } from "telegraf";
import { fetchXucXacSessions, computeRawPredictions } from "../analyzer/xucxac";
import { logger } from "../lib/logger";

// ─── Config ───────────────────────────────────────────────────────────────────

const API_ID   = parseInt(process.env["TELEGRAM_API_ID"]   ?? "35029605");
const API_HASH = process.env["TELEGRAM_API_HASH"]           ?? "1915336c87ee8bf9d948253e9e9b9c1a";

export const GAME_BOT_USERNAME   = "naprutclmmnew_bot";
export const GAME_GROUP_USERNAME = "plgamingxclmm";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AutoplayPhase =
  | "disclaimer"
  | "login_phone"
  | "login_code"
  | "login_password"
  | "config_mode"
  | "config_amount"
  | "config_doors"
  | "config_target"
  | "running"
  | "paused"
  | "stopped";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject:  (e: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!:  (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

export interface AutoplaySession {
  chatId:     number;
  telegramId: number;
  phase:      AutoplayPhase;
  client:     TelegramClient | null;
  // Auth deferreds
  phoneDeferred: Deferred<string> | null;
  codeDeferred:  Deferred<string> | null;
  passDeferred:  Deferred<string> | null;
  // Config
  mode:          "fixed" | "auto" | null;
  fixedAmount:   number | null;
  doors:         1 | 2 | null;
  targetBalance: number | null;
  // Runtime
  initialBalance: number;
  currentBalance: number;
  sessionCount:   number;
  wins:           number;
  losses:         number;
  lastSessionId:  number;
  stopRequested:  boolean;
  useGroup:       boolean;
  loopActive:     boolean;
  // Send message to user
  notify: (text: string, extra?: any) => Promise<void>;
}

// ─── Session store ────────────────────────────────────────────────────────────

const sessions = new Map<number, AutoplaySession>();

export function getAutoplaySession(telegramId: number): AutoplaySession | null {
  return sessions.get(telegramId) ?? null;
}

export function createAutoplaySession(
  chatId:     number,
  telegramId: number,
  notify:     (text: string, extra?: any) => Promise<void>,
): AutoplaySession {
  const sess: AutoplaySession = {
    chatId, telegramId,
    phase: "disclaimer",
    client: null,
    phoneDeferred: null, codeDeferred: null, passDeferred: null,
    mode: null, fixedAmount: null, doors: null, targetBalance: null,
    initialBalance: 0, currentBalance: 0,
    sessionCount: 0, wins: 0, losses: 0, lastSessionId: 0,
    stopRequested: false, useGroup: false, loopActive: false,
    notify,
  };
  sessions.set(telegramId, sess);
  return sess;
}

export function destroyAutoplaySession(telegramId: number) {
  const sess = sessions.get(telegramId);
  if (sess?.client) {
    sess.client.disconnect().catch(() => {});
    sess.client = null;
  }
  sessions.delete(telegramId);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/** Kick off user-level Telegram auth. Fires notify callbacks to guide the user. */
export async function startAutoplayLogin(telegramId: number): Promise<void> {
  const sess = sessions.get(telegramId);
  if (!sess) return;

  sess.phase         = "login_phone";
  sess.phoneDeferred = createDeferred<string>();
  sess.codeDeferred  = createDeferred<string>();
  sess.passDeferred  = createDeferred<string>();

  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
    connectionRetries: 3,
    retryDelay: 1000,
    autoReconnect: true,
  });

  try {
    await client.connect();
  } catch (err: any) {
    await sess.notify(`❌ Không kết nối được Telegram. Kiểm tra TELEGRAM_API_ID và TELEGRAM_API_HASH.\nLỗi: ${err?.message ?? "unknown"}`);
    destroyAutoplaySession(telegramId);
    return;
  }

  // Run start() in background — it drives through callbacks
  client.start({
    phoneNumber: () => sess.phoneDeferred!.promise,
    phoneCode: async () => {
      sess.phase = "login_code";
      await sess.notify(
        `📲 <b>Nhập mã OTP</b> Telegram vừa gửi về điện thoại của bạn:\n\n` +
        `<i>Gửi mã vào đây (không cần gõ gì khác)</i>`,
      );
      return sess.codeDeferred!.promise;
    },
    password: async () => {
      sess.phase = "login_password";
      await sess.notify(`🔒 <b>Tài khoản có bật 2FA.</b>\nNhập mật khẩu xác thực 2 bước của bạn:`);
      return sess.passDeferred!.promise;
    },
    onError: (err: any) => { throw err; },
  }).then(async () => {
    sess.client = client;
    logger.info({ telegramId }, "Autoplay: user login success");

    // Fetch balance
    let balance = 0;
    let balanceFmt = "Không lấy được";
    try {
      balance    = await fetchBalance(sess);
      balanceFmt = balance.toLocaleString("vi-VN") + " VND";
      sess.initialBalance = balance;
      sess.currentBalance = balance;
    } catch {
      sess.useGroup = true;
      balanceFmt = "? (sẽ chơi qua nhóm)";
    }

    sess.phase = "config_mode";
    await sess.notify(
      `✅ <b>Đăng nhập thành công!</b>\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `💰 <b>Số dư hiện tại:</b> <code>${balanceFmt}</code>\n\n` +
      `⚙️ <b>Chọn chế độ đặt cược:</b>`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("📌 Cố định", "ap_mode_fixed"),
          Markup.button.callback("🤖 Tự động (5% vốn)", "ap_mode_auto"),
        ],
        [Markup.button.callback("❌ Huỷ", "ap_cancel")],
      ]),
    );
  }).catch(async (err: any) => {
    logger.error({ err, telegramId }, "Autoplay login error");
    sess.phase = "stopped";
    await sess.notify(`❌ <b>Đăng nhập thất bại!</b>\nLý do: ${err?.message ?? "Lỗi không xác định"}\n\nVui lòng thử lại.`);
    destroyAutoplaySession(telegramId);
  });
}

// ─── Balance ──────────────────────────────────────────────────────────────────

export async function fetchBalance(sess: AutoplaySession): Promise<number> {
  if (!sess.client) throw new Error("no_client");

  const entity = await sess.client.getEntity(GAME_BOT_USERNAME).catch(() => { throw new Error("cannot_reach_bot"); });

  // /start (init bot if needed)
  try { await sess.client.sendMessage(entity, { message: "/start" }); } catch { /* ok */ }
  await sleep(2000);

  // /sd — get balance
  await sess.client.sendMessage(entity, { message: "/sd" });
  await sleep(3000);

  const msgs = await sess.client.getMessages(entity, { limit: 6 });
  for (const msg of msgs) {
    const text: string = (msg as any).message ?? "";
    if ((msg as any).out || !text) continue;
    const bal = parseBalance(text);
    if (bal !== null) return bal;
  }
  throw new Error("cannot_parse_balance");
}

function parseBalance(text: string): number | null {
  // Try several patterns used by Vietnamese game bots
  const pats = [
    /số dư[^:]*:\s*([\d,.]+)/i,
    /balance[^:]*:\s*([\d,.]+)/i,
    /💰[^:]*:\s*([\d,.]+)/i,
    /([\d,.]{4,})\s*(?:vnđ|vnd|đ)\b/i,
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (!m) continue;
    // Remove thousand separators (VN uses dấu chấm as thousand sep)
    const cleaned = m[1].replace(/\./g, "").replace(/,/g, "");
    const n = parseInt(cleaned);
    if (!isNaN(n) && n >= 0) return n;
  }
  return null;
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

export function buildStatusMsg(sess: AutoplaySession, lastResult?: string): string {
  const cur    = sess.currentBalance.toLocaleString("vi-VN");
  const profit = sess.currentBalance - sess.initialBalance;
  const pFmt   = (profit >= 0 ? "+" : "") + profit.toLocaleString("vi-VN");
  const pEmoji = profit > 0 ? "📈" : profit < 0 ? "📉" : "➡️";
  const tgt    = sess.targetBalance ? sess.targetBalance.toLocaleString("vi-VN") + " VND" : "Chưa đặt";

  return (
    `🎲 <b>AUTO CHƠI XÚC XẮC</b>\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `💰 <b>Số dư:</b> <code>${cur} VND</code>\n` +
    `🎯 <b>Mục tiêu:</b> <code>${tgt}</code>\n` +
    `${pEmoji} <b>Lãi/Lỗ:</b> <code>${pFmt} VND</code>\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>Thống kê:</b> ${sess.sessionCount} phiên  ·  ✅ ${sess.wins}  ·  ❌ ${sess.losses}\n` +
    (lastResult ? `🔔 <b>Vừa rồi:</b> ${lastResult}\n` : ``) +
    `━━━━━━━━━━━━━━━━━`
  );
}

export function controlKeyboard(paused = false) {
  return Markup.inlineKeyboard([
    [
      paused
        ? Markup.button.callback("▶️ Tiếp tục", "ap_resume")
        : Markup.button.callback("⏸ Dừng", "ap_pause"),
      Markup.button.callback("🚪 Đăng xuất & Kết thúc", "ap_logout"),
    ],
  ]);
}

// ─── Betting loop ─────────────────────────────────────────────────────────────

export async function startAutoplayLoop(telegramId: number): Promise<void> {
  const sess = sessions.get(telegramId);
  if (!sess?.client) return;
  if (sess.loopActive) return;

  sess.loopActive    = true;
  sess.stopRequested = false;
  sess.phase         = "running";

  logger.info({ telegramId, mode: sess.mode, doors: sess.doors }, "Autoplay loop started");

  try {
    while (!sess.stopRequested) {
      // ── Wait for new xucxac session ────────────────────────────────────
      const newId = await waitForNewSession(sess, 180_000);
      if (newId === null) {
        if (sess.stopRequested) break;
        // timeout, just retry
        continue;
      }

      // ── Get predictions ────────────────────────────────────────────────
      let txPred: "Tài" | "Xỉu" = "Tài";
      let clPred: "Chẵn" | "Lẻ" = "Chẵn";
      try {
        const recent = await fetchXucXacSessions(30);
        const preds  = computeRawPredictions(recent);
        if (preds) { txPred = preds.tx; clPred = preds.cl; }
      } catch { /* use defaults */ }

      // ── Wait while paused ──────────────────────────────────────────────
      while (!sess.stopRequested && sess.phase === "paused") await sleep(1000);
      if (sess.stopRequested) break;

      // ── In group mode wait 10s before placing bet ──────────────────────
      if (sess.useGroup) {
        await sleep(10_000);
        if (sess.stopRequested) break;
      }

      const betAmt = computeBetAmount(sess);
      if (betAmt <= 0 || betAmt > sess.currentBalance) {
        await sess.notify(
          `💸 <b>Số dư không đủ để đặt cược!</b>\n` +
          `Số dư: <code>${sess.currentBalance.toLocaleString("vi-VN")} VND</code>\n\nBot đã dừng tự động.`,
        );
        break;
      }

      // ── Send bets ──────────────────────────────────────────────────────
      const ok = await sendBets(sess, txPred, clPred, betAmt);
      if (!ok) {
        await sess.notify(`💸 <b>Bot game báo số dư không đủ!</b>\nBot đã dừng tự động.`);
        break;
      }

      // ── Wait for next session (result) ─────────────────────────────────
      const resolvedId = await waitForNewSession(sess, 120_000);
      if (resolvedId === null && sess.stopRequested) break;

      // ── Refresh balance via /sd ────────────────────────────────────────
      let newBal = sess.currentBalance;
      try { newBal = await fetchBalance(sess); } catch { /* keep old */ }

      const prev = sess.currentBalance;
      sess.currentBalance = newBal;
      sess.sessionCount++;

      const diff = newBal - prev;
      let lastResult: string;
      if (diff > 0)      { sess.wins++;   lastResult = `✅ <b>Thắng +${diff.toLocaleString("vi-VN")} VND</b>`; }
      else if (diff < 0) { sess.losses++; lastResult = `❌ <b>Thua ${diff.toLocaleString("vi-VN")} VND</b>`; }
      else               {                lastResult = `➡️ Hòa`; }

      // ── Check target ───────────────────────────────────────────────────
      if (sess.targetBalance !== null && newBal >= sess.targetBalance) {
        await sess.notify(
          buildStatusMsg(sess, lastResult) + `\n\n` +
          `🎉 <b>ĐÃ ĐẠT MỤC TIÊU!</b>\nBot đã tự động dừng và đăng xuất.`,
        );
        break;
      }

      if (newBal <= 0) {
        await sess.notify(buildStatusMsg(sess, lastResult) + `\n\n😢 <b>Hết tiền! Bot dừng tự động.</b>`);
        break;
      }

      // ── Send status update with stop / continue / logout buttons ───────
      if (!sess.stopRequested) {
        await sess.notify(buildStatusMsg(sess, lastResult), controlKeyboard(sess.phase === "paused"));
      }
    }
  } catch (err: any) {
    logger.error({ err, telegramId }, "Autoplay loop error");
    await sess.notify(`❌ <b>Lỗi:</b> ${err?.message ?? "unknown"}\nBot đã dừng.`).catch(() => {});
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  sess.loopActive = false;
  sess.phase      = "stopped";
  const finalProfit = sess.currentBalance - sess.initialBalance;
  await sess.notify(
    `🏁 <b>KẾT THÚC AUTO CHƠI</b>\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>Tổng:</b> ${sess.sessionCount} phiên  ·  ✅ ${sess.wins}  ·  ❌ ${sess.losses}\n` +
    `💰 <b>Số dư cuối:</b> <code>${sess.currentBalance.toLocaleString("vi-VN")} VND</code>\n` +
    `${finalProfit >= 0 ? "📈" : "📉"} <b>Lãi/Lỗ:</b> <code>${(finalProfit >= 0 ? "+" : "") + finalProfit.toLocaleString("vi-VN")} VND</code>`,
  ).catch(() => {});

  destroyAutoplaySession(telegramId);
}

// ── Wait for a new xucxac session ID ─────────────────────────────────────────

async function waitForNewSession(sess: AutoplaySession, timeoutMs = 180_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const prevId   = sess.lastSessionId;

  while (Date.now() < deadline) {
    if (sess.stopRequested) return null;
    try {
      const recent  = await fetchXucXacSessions(3);
      const latestId = recent[0]?.sessionId ?? 0;
      if (latestId > prevId) {
        sess.lastSessionId = latestId;
        return latestId;
      }
    } catch { /* retry */ }
    await sleep(5_000);
  }
  return null;
}

// ── Compute bet amount ────────────────────────────────────────────────────────

function computeBetAmount(sess: AutoplaySession): number {
  if (sess.mode === "fixed" && sess.fixedAmount) return sess.fixedAmount;
  // Auto: 5% of balance rounded to nearest 1,000
  const raw = Math.floor(sess.currentBalance * 0.05);
  return Math.max(1_000, Math.round(raw / 1_000) * 1_000);
}

// ── Send bets ─────────────────────────────────────────────────────────────────

async function sendBets(
  sess:    AutoplaySession,
  txPred:  "Tài" | "Xỉu",
  clPred:  "Chẵn" | "Lẻ",
  amount:  number,
): Promise<boolean> {
  const txCmd = txPred === "Tài" ? `t ${amount}` : `x ${amount}`;
  const clCmd = clPred === "Chẵn" ? `c ${amount}` : `l ${amount}`;

  if (!sess.useGroup) {
    const ok = await sendBetsToBot(sess, txCmd, clCmd);
    if (ok) return true;
    // Fallback to group
    sess.useGroup = true;
    await sess.notify(`⚠️ Không gửi được lệnh cho @${GAME_BOT_USERNAME} → chuyển sang chế độ nhóm.`);
  }
  return sendBetsToGroup(sess, txCmd, clCmd);
}

async function sendBetsToBot(sess: AutoplaySession, txCmd: string, clCmd: string): Promise<boolean> {
  if (!sess.client) return false;
  try {
    const entity = await sess.client.getEntity(GAME_BOT_USERNAME);

    // Bet 1: Tài / Xỉu
    await sess.client.sendMessage(entity, { message: txCmd });
    await sleep(2_000);
    const reply1 = await latestIncoming(sess.client, entity);
    if (reply1 && isInsufficient(reply1)) return false;

    // Bet 2: Chẵn / Lẻ (only for 2-door mode)
    if (sess.doors === 2) {
      await sess.client.sendMessage(entity, { message: clCmd });
      await sleep(2_000);
      const reply2 = await latestIncoming(sess.client, entity);
      if (reply2 && isInsufficient(reply2)) return false;
    }

    return true;
  } catch (err: any) {
    logger.warn({ err: err?.message }, "sendBetsToBot failed");
    return false;
  }
}

async function sendBetsToGroup(sess: AutoplaySession, txCmd: string, clCmd: string): Promise<boolean> {
  if (!sess.client) return false;
  try {
    const grpEntity = await sess.client.getEntity(GAME_GROUP_USERNAME);

    // Bet 1: Tài / Xỉu
    await sess.client.sendMessage(grpEntity, { message: txCmd });
    await sleep(1_000);

    // Bet 2: Chẵn / Lẻ (only for 2-door mode)
    if (sess.doors === 2) {
      await sess.client.sendMessage(grpEntity, { message: clCmd });
      await sleep(1_000);
    }

    // Wait 5s then check bot DM for confirmation
    await sleep(5_000);
    try {
      const botEnt = await sess.client.getEntity(GAME_BOT_USERNAME);
      const reply  = await latestIncoming(sess.client, botEnt);
      if (reply && isInsufficient(reply)) return false;
    } catch { /* non-critical */ }

    return true;
  } catch (err: any) {
    logger.error({ err: err?.message }, "sendBetsToGroup failed");
    return false;
  }
}

async function latestIncoming(client: TelegramClient, entity: any): Promise<string | null> {
  try {
    const msgs = await client.getMessages(entity, { limit: 3 });
    const msg  = msgs.find((m: any) => !m.out);
    return (msg as any)?.message ?? null;
  } catch {
    return null;
  }
}

function isInsufficient(text: string): boolean {
  return /không đủ|insufficient|hết tiền|không có đủ/i.test(text);
}
