import { Telegraf, Markup, session } from "telegraf";
import { message } from "telegraf/filters";
import {
  getAutoplaySession,
  createAutoplaySession,
  startAutoplayLogin,
  startAutoplayLoop,
  destroyAutoplaySession,
  buildStatusMsg,
  controlKeyboard,
  fetchBalance,
  GAME_BOT_USERNAME,
} from "../autoplay/player";
import { analyzeGame, GAME_META, GAME_APIS, fetchLatestId, fetchAndBuildAdvanced, invalidateSessionCache, type AdvancedPrediction } from "../analyzer/games";
import { getAnalyticsStats, exportExcel } from "../analyzer/analytics";
import { startXucXacWatcher, resetXucXacWatcher, buildXucXacStatsMsg } from "../analyzer/xucxac";
import { getMainClient, startInteractiveAuth } from "../mtproto/client";
import { logger } from "../lib/logger";
import {
  getMainMenuKeyboard,
  profileKeyboard,
  gameMenuKeyboard,
  depositKeyboard,
  supportKeyboard,
  isAdmin,
} from "./keyboard";
import {
  getOrCreateUser,
  getUser,
  getActiveKeyProducts,
  getDepositHistory,
  getBuyKeyHistory,
  getKeyUsageHistory,
  getUserActiveKeys,
  activateKey,
  buyKey,
  processReferral,
} from "./db";
import {
  isDepositBonusActive,
  isKeyDiscountActive,
  getEvent1Slots,
  getEvent3Slots,
  DEPOSIT_BONUS_PCT,
  KEY_DISCOUNT_PCT,
} from "./events";
import { registerBankHandlers, handleBankTextMessage, isBankLoginPending, getAdminDepositInfo, isDepositMonitorRunning, loadStaticDepositInfo, setStaticBankAccount, clearStaticBankAccount, autoRestoreBankSession, getPendingStartupCaptcha, handleStartupCaptcha } from "./bank";
import { generateDepositCode, createDepositSession, cancelUserSession, SESSION_TTL_MS } from "./deposit-session";
import { buildVietQRUrl } from "../bank/qr-generator";

interface BotSessionData {
  waitingForKey?: boolean;
  waitingForDeposit?: boolean;
}

type BotContext = import("telegraf").Context & { session: BotSessionData };

// ─── Admin auth state (module-level, persists across requests) ───────────────

function createDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface AuthState {
  phase: "phone" | "code" | "password";
  phoneDeferred: ReturnType<typeof createDeferred<string>>;
  codeDeferred: ReturnType<typeof createDeferred<string>>;
  passwordDeferred: ReturnType<typeof createDeferred<string>>;
  chatId: number;
}

const authStates = new Map<number, AuthState>();

// ─── Game auto-update watcher ────────────────────────────────────────────────

interface GameWatcher {
  lastId: number;
  subs: Map<number, number>;        // chatId → messageId
}
const gameWatchers   = new Map<string, GameWatcher>();
const userActiveGame = new Map<number, string>();   // chatId → active game key

// ─── Prediction message store ─────────────────────────────────────────────────
// Lưu message dự đoán đang chờ kết quả, per game per chat
interface PredMsg {
  messageId:      number;
  predictedLabel: string;
  sessionId:      number;   // sessionId tại thời điểm dự đoán (phiên HIỆN TẠI)
}
// gameKey → chatId → PredMsg
const predMsgStore = new Map<string, Map<number, PredMsg>>();

function setPredMsg(gameKey: string, chatId: number, pm: PredMsg) {
  if (!predMsgStore.has(gameKey)) predMsgStore.set(gameKey, new Map());
  predMsgStore.get(gameKey)!.set(chatId, pm);
}
function getPredMsg(gameKey: string, chatId: number): PredMsg | undefined {
  return predMsgStore.get(gameKey)?.get(chatId);
}
function clearPredMsg(gameKey: string, chatId: number) {
  predMsgStore.get(gameKey)?.delete(chatId);
}

/** Gỡ user khỏi game cũ, đăng ký vào game mới — mỗi user chỉ 1 game */
function registerGameViewer(key: string, chatId: number, messageId: number) {
  // Xoá khỏi game cũ nếu khác
  const prev = userActiveGame.get(chatId);
  if (prev && prev !== key) {
    gameWatchers.get(prev)?.subs.delete(chatId);
  }
  userActiveGame.set(chatId, key);

  if (!gameWatchers.has(key)) {
    gameWatchers.set(key, { lastId: 0, subs: new Map() });
  }
  gameWatchers.get(key)!.subs.set(chatId, messageId);
}

// ─── Auto-delete messages older than 1 hour ──────────────────────────────────

interface TrackedMsg { chatId: number; messageId: number; sentAt: number }
const trackedMessages: TrackedMsg[] = [];

function trackMessage(chatId: number, messageId: number) {
  trackedMessages.push({ chatId, messageId, sentAt: Date.now() });
}

// Dùng chung bởi cả poller lẫn xucxac real-time handler
function gameKeyboard(key: string) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.url("🌐 Vào sanvip.blog", "https://sanvip.blog")],
    [Markup.button.callback("🔄 Làm mới ngay", `refresh_game_${key}`), Markup.button.callback("🛑 Dừng", `stop_game_${key}`)],
  ];
  if (key === "xucxac") {
    rows.push([Markup.button.callback("🤖 Auto Chơi", "ap_start")]);
  }
  return Markup.inlineKeyboard(rows);
}

// Tạo thanh tiến trình ASCII — khớp với blueprint của user
function buildProgressBar(percent: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 10);
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

/**
 * Định dạng khối HTML từ AdvancedPrediction để append vào cuối message phân tích.
 * - SKIP: thông báo nhẹ rằng AI không đủ tín hiệu — phiên mới vẫn được cập nhật bình thường.
 * - BET:  hiển thị đầy đủ dự đoán, tỷ lệ tin cậy, chỉ báo, khuyến nghị vốn.
 */
function buildAdvancedBlock(prediction: AdvancedPrediction): string {
  if (prediction.action === "SKIP") {
    return (
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 <b>Advanced AI:</b> Chưa đủ tín hiệu mạnh cho phiên này.\n` +
      `<i>💡 ${prediction.reason}</i>`
    );
  }

  const predEmoji: Record<string, string> = {
    "Tài": "🔴", "Xỉu": "🔵",
    "Chẵn": "⚪", "Lẻ": "⚫",
    "Rồng": "🐉", "Hổ": "🐅",
  };
  const icon = predEmoji[prediction.prediction] ?? "🎯";

  const counterLine = prediction.counterN !== null && prediction.counterResult !== null
    ? `\n📈 <b>Lần gần nhất:</b> ${prediction.counterResult === "win" ? `✅ thắng ${prediction.counterN}` : `❌ thua ${prediction.counterN}`}`
    : "";

  return (
    `\n━━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 <b>PHÂN TÍCH NÂNG CAO (Advanced AI)</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎯 <b>Bot dự đoán:</b> ${icon} <b>${prediction.prediction.toUpperCase()}</b>\n` +
    `📊 <b>Tỷ lệ tự tin:</b> ${prediction.confidence}%  ${buildProgressBar(prediction.confidence)}\n` +
    `💡 <b>Chỉ báo:</b> ${prediction.indicators}\n` +
    `💰 <b>Khuyến nghị vào vốn:</b> ${prediction.capitalAdvice}\n` +
    `⚡ <b>Điểm:</b> Trend ${prediction.trendScore}/40 · Tần suất ${prediction.freqScore}/35 · Phá cầu ${prediction.revScore}/25` +
    counterLine
  );
}

// ─── Build message cho dự đoán đang chờ kết quả ─────────────────────────────
function buildPendingPredMsg(meta: { title: string; emoji: string }, pred: import("../analyzer/games").AdvancedPrediction): string {
  const predEmoji: Record<string, string> = {
    "Tài": "🔴", "Xỉu": "🔵", "Chẵn": "⚪", "Lẻ": "⚫", "Rồng": "🐉", "Hổ": "🐅",
  };
  const icon = predEmoji[pred.prediction] ?? "🎯";
  return (
    `${meta.emoji} <b>DỰ ĐOÁN PHIÊN TIẾP THEO — ${meta.title.toUpperCase()}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 <b>Bot dự đoán:</b> ${icon} <b>${pred.prediction.toUpperCase()}</b>\n` +
    `📊 <b>Độ tin cậy:</b> ${pred.confidence}%  ${buildProgressBar(pred.confidence)}\n` +
    `💡 <b>Chỉ báo:</b> ${pred.indicators}\n` +
    `💰 <b>Vào vốn:</b> ${pred.capitalAdvice}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⏳ <i>Đang chờ kết quả phiên kế tiếp...</i>`
  );
}

// ─── Edit message dự đoán cũ → hiện kết quả thắng/thua ──────────────────────
function buildResultPredMsg(
  meta: { title: string; emoji: string },
  predictedLabel: string,
  actualLabel: string,
): string {
  const predEmoji: Record<string, string> = {
    "Tài": "🔴", "Xỉu": "🔵", "Chẵn": "⚪", "Lẻ": "⚫", "Rồng": "🐉", "Hổ": "🐅",
  };
  const isWin    = predictedLabel === actualLabel;
  const predIcon = predEmoji[predictedLabel] ?? "🎯";
  const actIcon  = predEmoji[actualLabel]    ?? "🎯";
  const resultLine = isWin
    ? `✅ <b>KẾT QUẢ: THẮNG!</b>  (Thực tế: ${actIcon} <b>${actualLabel}</b>)`
    : `❌ <b>KẾT QUẢ: THUA</b>  (Thực tế: ${actIcon} <b>${actualLabel}</b>)`;

  return (
    `${meta.emoji} <b>DỰ ĐOÁN — ${meta.title.toUpperCase()}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 <b>Bot dự đoán:</b> ${predIcon} <b>${predictedLabel.toUpperCase()}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    resultLine
  );
}

async function pushGameUpdate(bot: Telegraf<BotContext>, key: string) {
  const watcher = gameWatchers.get(key);
  if (!watcher || watcher.subs.size === 0) return;

  const meta = GAME_META[key] ?? { title: key, emoji: "🎮" };

  // ── Xoá cache → fetch dữ liệu phiên MỚI ─────────────────────────────────
  invalidateSessionCache(key);

  // Gọi song song: analyzeGame + fetchAndBuildAdvanced dùng chung session cache MỚI
  let analysisText: string;
  let advanced: import("../analyzer/games").AdvancedPrediction | null = null;
  try {
    const [mainText, adv] = await Promise.all([
      analyzeGame(key),
      key === "taixiumd5" ? Promise.resolve(null) : fetchAndBuildAdvanced(key),
    ]);
    advanced = adv;
    analysisText = (advanced ? mainText + buildAdvancedBlock(advanced) : mainText)
      + `\n\n<i>🔄 Bot tự động cập nhật khi có phiên mới</i>`;
  } catch (err: any) {
    logger.warn({ key, err: err?.message }, "Advanced analysis failed in pushGameUpdate, falling back");
    analysisText = (await analyzeGame(key)) + `\n\n<i>🔄 Bot tự động cập nhật khi có phiên mới</i>`;
  }

  // actualLabel: kết quả thực của phiên VỪA VỀ (để xác định thắng/thua dự đoán cũ)
  const actualLabel    = advanced?.actualLabel ?? null;
  const latestSessId   = advanced?.latestSessionId ?? null;

  const kbd     = gameKeyboard(key);
  const entries = [...watcher.subs.entries()];

  await Promise.allSettled(entries.map(async ([chatId, oldMsgId]) => {
    // ── Kiểm tra key còn hạn không ───────────────────────────────────────
    const activeKeys = await getUserActiveKeys(chatId);
    if (activeKeys.length === 0) {
      try { await bot.telegram.deleteMessage(chatId, oldMsgId); } catch { /* đã xóa */ }
      try {
        await bot.telegram.sendMessage(chatId,
          `📢 <b>PHIÊN CẬP NHẬT CUỐI — KEY ĐÃ HẾT HẠN</b>\n━━━━━━━━━━━━━━━━━\n${analysisText}`,
          { parse_mode: "HTML" },
        );
      } catch { /* ok */ }
      try {
        await bot.telegram.sendMessage(chatId,
          `⏰ <b>KEY CỦA BẠN ĐÃ HẾT HẠN!</b>\n━━━━━━━━━━━━━━━━━\n` +
          `🔒 Tính năng phân tích game đã bị tạm khoá.\n\n` +
          `Vui lòng mua hoặc nhập key mới để tiếp tục xem phân tích!`,
          { parse_mode: "HTML", ...Markup.inlineKeyboard([
            [Markup.button.callback("🛒 Mua key ngay", "go_buy_key")],
            [Markup.button.callback("🔑 Nhập key có sẵn", "go_enter_key")],
          ]) },
        );
      } catch { /* ok */ }
      watcher.subs.delete(chatId);
      userActiveGame.delete(chatId);
      clearPredMsg(key, chatId);
      return;
    }

    // ── Bước 1: Edit message dự đoán CŨ → hiển thị kết quả thắng/thua ───
    if (actualLabel) {
      const prev = getPredMsg(key, chatId);
      if (prev) {
        try {
          const resultText = buildResultPredMsg(meta, prev.predictedLabel, actualLabel);
          await bot.telegram.editMessageText(chatId, prev.messageId, undefined, resultText, { parse_mode: "HTML" });
        } catch { /* message quá cũ hoặc không edit được */ }
        clearPredMsg(key, chatId);
      }
    }

    // ── Bước 2: Gửi/cập nhật message phân tích ───────────────────────────
    try { await bot.telegram.deleteMessage(chatId, oldMsgId); } catch { /* đã xóa */ }
    try {
      const newMsg = await bot.telegram.sendMessage(chatId, analysisText, { parse_mode: "HTML", ...kbd });
      watcher.subs.set(chatId, newMsg.message_id);
      trackMessage(chatId, newMsg.message_id);
    } catch (sendErr: any) {
      if (sendErr?.code === 403 || sendErr?.description?.includes("chat not found")) {
        watcher.subs.delete(chatId);
        userActiveGame.delete(chatId);
        clearPredMsg(key, chatId);
      }
      logger.warn({ chatId, key, err: sendErr?.message }, "Failed to push game update");
      return;
    }

    // ── Bước 3: Gửi message dự đoán MỚI cho phiên tiếp theo (nếu BET) ───
    if (advanced?.action === "BET" && advanced.prediction && latestSessId !== null) {
      try {
        const predText = buildPendingPredMsg(meta, advanced);
        const predMsg  = await bot.telegram.sendMessage(chatId, predText, { parse_mode: "HTML" });
        setPredMsg(key, chatId, {
          messageId:      predMsg.message_id,
          predictedLabel: advanced.prediction,
          sessionId:      latestSessId,
        });
        trackMessage(chatId, predMsg.message_id);
      } catch (predErr: any) {
        logger.warn({ chatId, key, err: predErr?.message }, "Failed to send prediction message");
      }
    }

    // ── Bước 4 (xucxac): Gửi tin nhắn thống kê thắng/thua riêng ─────────
    if (key === "xucxac") {
      try {
        const statsText = buildXucXacStatsMsg();
        if (statsText) {
          await bot.telegram.sendMessage(chatId, statsText, { parse_mode: "HTML" });
        }
      } catch (statsErr: any) {
        logger.warn({ chatId, err: statsErr?.message }, "Failed to send xucxac stats message");
      }
    }
  }));
}

// ─── helpers ────────────────────────────────────────────────────────────────

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TIER_EMOJI: Record<string, string> = {
  "Key Test":      "🟢",
  "Key Phổ Thông": "🔵",
  "Key VIP":       "🟣",
  "Key SVIP":      "🔴",
  "Key SSVIP":     "💜",
  "Key SSSVIP":    "👑",
};

const TIER_CODE: Record<string, string> = {
  "Key Test":      "TEST",
  "Key Phổ Thông": "PHOT",
  "Key VIP":       "VIPX",
  "Key SVIP":      "SVIP",
  "Key SSVIP":     "SSVP",
  "Key SSSVIP":    "SSSV",
};

/** Nhãn thời hạn đẹp theo số ngày */
function durationLabel(days: number): string {
  if (days === 1)   return "1 ngày";
  if (days === 7)   return "7 ngày";
  if (days === 30)  return "30 ngày";
  if (days === 180) return "6 tháng";
  if (days === 365) return "1 năm";
  if (days === 540) return "18 tháng";
  return `${days} ngày`;
}

function daysRemaining(expiresAt: Date | null | undefined): number {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000));
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("vi-VN");
}

function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  const dt = new Date(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

// Tất cả gói đều chơi full game
const TIER_GAMES: Record<string, string> = {
  "Key Test":      "✅ Tất cả game",
  "Key Phổ Thông": "✅ Tất cả game",
  "Key VIP":       "✅ Tất cả game",
  "Key SVIP":      "✅ Tất cả game",
  "Key SSVIP":     "✅ Tất cả game",
  "Key SSSVIP":    "✅ Tất cả game",
};

function fmtMoney(v: string | number): string {
  return parseFloat(String(v)).toLocaleString("vi-VN");
}

function discountedPrice(original: number, pct: number): number {
  return Math.floor(original * (1 - pct / 100));
}

/** Gửi QR nạp tiền + tạo phiên 8 phút. Thay thế hoàn toàn depositInstructions cũ. */
async function sendDepositQR(ctx: BotContext, telegramId: number, amount: number): Promise<void> {
  const bonusActive = isDepositBonusActive();
  const formatted = amount.toLocaleString("vi-VN");
  const code = generateDepositCode();
  const acc = getAdminDepositInfo();
  const autoMode = isDepositMonitorRunning();

  // Thời gian hết hạn (8 phút từ bây giờ)
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const expiryStr = expiresAt.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

  const bonusBanner = bonusActive
    ? `\n🎁 <b>SỰ KIỆN NẠP +${DEPOSIT_BONUS_PCT}%!</b> Bot cộng thêm ${DEPOSIT_BONUS_PCT}% 🎉\n`
    : "";

  let caption: string;
  let isPhoto = false;

  if (acc) {
    caption =
      `💳 <b>NẠP ${formatted} VND</b>\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      bonusBanner +
      `🏦 <b>${acc.bankName}</b> · <code>${acc.accountNumber}</code>\n` +
      `👤 <b>${acc.accountName}</b>\n` +
      `💰 Số tiền: <b>${formatted} VND</b>\n\n` +
      `📝 <b>Nội dung chuyển khoản:</b>\n` +
      `<code>${code}</code>\n\n` +
      `⏳ Phiên hết hạn lúc <b>${expiryStr}</b> (8 phút)\n` +
      (autoMode
        ? `🤖 <b>Bot tự động duyệt trong ≤30 giây sau khi nhận tiền!</b>`
        : `⚠️ Liên hệ admin để được duyệt thủ công.`);
  } else {
    caption =
      `💳 <b>NẠP ${formatted} VND</b>\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      bonusBanner +
      `⚠️ Chưa cấu hình tài khoản nhận tiền. Admin dùng /setbank để thiết lập.\n\n` +
      `📝 <b>Nội dung chuyển khoản:</b>\n` +
      `<code>${code}</code>\n\n` +
      `⏳ Phiên hết hạn lúc <b>${expiryStr}</b> (8 phút)`;
  }

  // Thử gửi QR ảnh (chỉ khi có thông tin TK)
  let messageId: number;
  if (acc) {
    try {
      // Gửi URL trực tiếp để Telegram tự tải ảnh — tránh vấn đề Buffer upload
      const qrUrl = buildVietQRUrl(acc.accountNumber, acc.accountName, amount, code);
      const sent = await ctx.replyWithPhoto(
        qrUrl,
        { caption, parse_mode: "HTML" },
      );
      messageId = sent.message_id;
      isPhoto = true;
    } catch (qrErr: any) {
      // Log lỗi để debug
      logger.error({ err: qrErr?.message ?? String(qrErr), stack: qrErr?.stack }, "QR sendPhoto failed — falling back to text");
      // Fallback: gửi text nếu QR API lỗi
      const sent = await ctx.reply(caption, { parse_mode: "HTML" });
      messageId = sent.message_id;
    }
  } else {
    const sent = await ctx.reply(caption, { parse_mode: "HTML" });
    messageId = sent.message_id;
  }

  const chatId = ctx.chat!.id;
  const tgApi = ctx.telegram;
  const expiredCaption =
    `❌ <b>PHIÊN NẠP TIỀN ĐÃ HẾT HẠN</b>\n\n` +
    `Mã: <code>${code}</code>\n\n` +
    `Bấm 💳 <b>Nạp tiền</b> để tạo phiên mới.`;

  // Tạo session 8 phút
  createDepositSession(
    code,
    telegramId,
    amount,
    chatId,
    messageId,
    isPhoto,
    async () => {
      try {
        if (isPhoto) {
          await tgApi.editMessageCaption(chatId, messageId, undefined, expiredCaption, { parse_mode: "HTML" });
        } else {
          await tgApi.editMessageText(chatId, messageId, undefined, expiredCaption, { parse_mode: "HTML" });
        }
      } catch {
        try {
          await tgApi.sendMessage(chatId, expiredCaption, { parse_mode: "HTML" });
        } catch { /* ignore */ }
      }
    },
  );
}

// ─── bot ────────────────────────────────────────────────────────────────────

export function createBot(token: string) {
  const bot = new Telegraf<BotContext>(token);

  bot.use(session({ defaultSession: (): BotSessionData => ({}) }));

  // ────────── /start (+ referral deep link) ──────────
  bot.start(async (ctx) => {
    const tg = ctx.from!;
    const user = await getOrCreateUser(tg.id, tg.username, tg.first_name, tg.last_name);

    // Xử lý referral: /start ref_123456789
    const payload = (ctx as any).startPayload as string | undefined;
    if (payload?.startsWith("ref_")) {
      const referrerId = parseInt(payload.slice(4));
      if (!isNaN(referrerId)) {
        const credited = await processReferral(tg.id, referrerId);
        if (credited) {
          try {
            await ctx.telegram.sendMessage(
              referrerId,
              `🎉 <b>Bạn vừa nhận thưởng giới thiệu!</b>\n` +
              `Người dùng mới đã tham gia qua link của bạn.\n` +
              `💰 +1,000 VND đã được cộng vào tài khoản!`,
              { parse_mode: "HTML" },
            );
          } catch { /* referrer có thể chưa start bot */ }
        }
      }
    }

    await ctx.reply(
      `🎮 <b>Chào mừng ${esc(tg.first_name)} đến với HARU Bot!</b>\n\nChọn một chức năng bên dưới để bắt đầu 👇`,
      { parse_mode: "HTML", ...getMainMenuKeyboard(tg.id) },
    );

    // Hiện luôn danh sách gói key ngay từ đầu
    await sendBuyKeyMenu(ctx);
  });

  // ────────── /help ──────────
  bot.help((ctx) =>
    ctx.reply(
      `ℹ️ <b>Hướng dẫn sử dụng:</b>\n\n` +
      `👤 <b>Xem hồ sơ</b> — Thông tin tài khoản, key đang dùng\n` +
      `🎉 <b>Sự kiện</b> — Chương trình khuyến mãi\n` +
      `💳 <b>Nạp tiền</b> — Nạp tiền vào tài khoản\n` +
      `🔑 <b>Nhập key</b> — Kích hoạt key bạn đã có\n` +
      `🛒 <b>Mua key</b> — Mua key với số dư\n` +
      `🆘 <b>Hỗ trợ</b> — Liên hệ admin\n` +
      `🎮 <b>Game</b> — Danh sách game hỗ trợ`,
      { parse_mode: "HTML" },
    ),
  );

  // ────────── 👤 Xem hồ sơ ──────────
  bot.hears("👤 Xem hồ sơ", async (ctx) => {
    const tg = ctx.from!;
    const [user, activeKeys] = await Promise.all([
      getOrCreateUser(tg.id, tg.username, tg.first_name, tg.last_name),
      getUserActiveKeys(tg.id),
    ]);

    const fullName = esc([tg.first_name, tg.last_name].filter(Boolean).join(" ")) || "—";
    const username = tg.username ? `@${esc(tg.username)}` : "Chưa đặt";
    const joinDate = fmtDate(user.createdAt);
    const balance = fmtMoney(user.balance as string);

    let keySection = "🔑 <b>Key đang dùng:</b> Không có\n";
    if (activeKeys.length > 0) {
      keySection = "";
      for (const { key, product } of activeKeys) {
        const emoji = TIER_EMOJI[product.name] ?? "⚪";
        const days = daysRemaining(key.expiresAt as Date | null);
        const expiry = fmtDateTime(key.expiresAt as Date | null);
        keySection +=
          `🔑 <b>Key đang dùng:</b>\n` +
          `   ${emoji} ${esc(product.name)}\n` +
          `   <code>${esc(key.keyCode)}</code>\n` +
          `   ⏳ Còn <b>${days} ngày</b>\n` +
          `   📅 Hết hạn lúc: <b>${expiry}</b>\n`;
      }
    }

    await ctx.reply(
      `╔══════════════════════╗\n` +
      `║   👤  HỒ SƠ CỦA BẠN   ║\n` +
      `╚══════════════════════╝\n\n` +
      `📛 <b>Tên:</b> ${fullName}\n` +
      `🆔 <b>Telegram ID:</b> <code>${tg.id}</code>\n` +
      `💬 <b>Username:</b> ${username}\n` +
      `📅 <b>Tham gia:</b> ${joinDate}\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 <b>Số dư:</b> <code>${balance} VND</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${keySection}` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 Xem lịch sử bên dưới 👇`,
      { parse_mode: "HTML", reply_markup: profileKeyboard.reply_markup },
    );
  });

  // ────────── Lịch sử nạp ──────────
  bot.action("hist_deposit", async (ctx) => {
    const history = await getDepositHistory(ctx.from!.id, 10);
    let text = `📥 <b>LỊCH SỬ NẠP TIỀN</b>\n━━━━━━━━━━━━━━━━━\n`;
    if (history.length === 0) {
      text += "Chưa có lần nạp nào.";
    } else {
      for (const t of history) {
        text += `• ${fmtDate(t.createdAt)} — <b>+${fmtMoney(t.amount)} VND</b>`;
        if (t.description?.includes("Thưởng giới thiệu")) text += " 🎁";
        text += "\n";
      }
    }
    await ctx.answerCbQuery();
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: profileKeyboard.reply_markup });
  });

  // ────────── Lịch sử mua key ──────────
  bot.action("hist_buy", async (ctx) => {
    const history = await getBuyKeyHistory(ctx.from!.id, 10);
    let text = `🛒 <b>LỊCH SỬ MUA KEY</b>\n━━━━━━━━━━━━━━━━━\n`;
    if (history.length === 0) {
      text += "Chưa mua key nào.";
    } else {
      for (const t of history) {
        const amt = Math.abs(parseFloat(t.amount as string)).toLocaleString("vi-VN");
        text +=
          `• ${fmtDate(t.createdAt)} — ${esc(t.description ?? "Mua key")}\n` +
          `  💸 <b>${amt} VND</b>  🔑 <code>${esc(t.referenceId ?? "—")}</code>\n`;
      }
    }
    await ctx.answerCbQuery();
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: profileKeyboard.reply_markup });
  });

  // ────────── Lịch sử sử dụng key ──────────
  bot.action("hist_keys", async (ctx) => {
    const history = await getKeyUsageHistory(ctx.from!.id, 10);
    let text = `🔑 <b>LỊCH SỬ SỬ DỤNG KEY</b>\n━━━━━━━━━━━━━━━━━\n`;
    if (history.length === 0) {
      text += "Chưa sử dụng key nào.";
    } else {
      const now = new Date();
      for (const { key, product } of history) {
        const emoji = TIER_EMOJI[product.name] ?? "⚪";
        const expired = key.expiresAt && new Date(key.expiresAt) < now;
        text +=
          `${emoji} <b>${esc(product.name)}</b>\n` +
          `   <code>${esc(key.keyCode)}</code>\n` +
          `   📅 Dùng: ${fmtDate(key.usedAt as Date | null)}  ·  Hết: ${fmtDate(key.expiresAt as Date | null)}\n` +
          `   ${expired ? "❌ Hết hạn" : "✅ Còn hạn"}\n\n`;
      }
    }
    await ctx.answerCbQuery();
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: profileKeyboard.reply_markup });
  });

  // ────────── 🎉 Sự kiện ──────────
  bot.hears("🎉 Sự kiện", async (ctx) => {
    await sendEventScreen(ctx);
  });

  async function sendEventScreen(ctx: BotContext) {
    const now = new Date();
    const { slot1: e1s1, slot2: e1s2 } = getEvent1Slots();
    const { slot1: e3s1, slot2: e3s2 } = getEvent3Slots();

    const ev1Active = now >= e1s1.start && now <= e1s1.end || now >= e1s2.start && now <= e1s2.end;
    const ev3Active = now >= e3s1.start && now <= e3s1.end || now >= e3s2.start && now <= e3s2.end;

    const ev1Badge = ev1Active ? "🔴 <b>ĐANG DIỄN RA</b>" : "⚪ Chưa đến giờ";
    const ev3Badge = ev3Active ? "🔴 <b>ĐANG DIỄN RA</b>" : "⚪ Chưa đến giờ";

    const text =
      `🎉 <b>SỰ KIỆN ĐANG DIỄN RA</b>\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `🎁 <b>Sự kiện 1 — Nạp tiền tặng ${DEPOSIT_BONUS_PCT}%</b>\n` +
      `   ${ev1Badge}\n` +
      `   📅 Khung giờ hôm nay:\n` +
      `   • ${e1s1.label}\n` +
      `   • ${e1s2.label}\n` +
      `   💡 Nạp trong khung giờ này được cộng thêm <b>${DEPOSIT_BONUS_PCT}%</b>\n\n` +
      `👥 <b>Sự kiện 2 — Giới thiệu bạn bè</b>\n` +
      `   🟢 Luôn áp dụng\n` +
      `   💡 Mỗi người bạn giới thiệu = tặng <b>1,000 VND</b>\n\n` +
      `⚡ <b>Sự kiện 3 — Flash Sale key -${KEY_DISCOUNT_PCT}%</b>\n` +
      `   ${ev3Badge}\n` +
      `   📅 Khung giờ hôm nay:\n` +
      `   • ${e3s1.label}\n` +
      `   • ${e3s2.label}\n` +
      `   💡 Tất cả gói key giảm <b>${KEY_DISCOUNT_PCT}%</b> trong khung giờ này\n\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `👇 Chọn sự kiện để tham gia:`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback("💳 Sự kiện 1 — Nạp tiền", "event_1"),
        Markup.button.callback("👥 Sự kiện 2 — Giới thiệu", "event_2"),
      ],
      [Markup.button.callback("🛒 Sự kiện 3 — Mua key", "event_3")],
    ]);

    await ctx.reply(text, { parse_mode: "HTML", ...keyboard });
  }

  bot.action("event_1", async (ctx) => {
    const bonusActive = isDepositBonusActive();
    const { slot1, slot2 } = getEvent1Slots();
    const banner = bonusActive
      ? `\n🔥 <b>SỰ KIỆN ĐANG DIỄN RA — NẠP ĐƯỢC TẶNG THÊM ${DEPOSIT_BONUS_PCT}%!</b>\n`
      : `\nℹ️ Khung giờ tặng thưởng hôm nay: <b>${slot1.label}</b> và <b>${slot2.label}</b>\n`;
    await ctx.answerCbQuery();
    await ctx.reply(
      `💳 <b>NẠP TIỀN VÀO TÀI KHOẢN</b>\n━━━━━━━━━━━━━━━━━${banner}\nChọn mệnh giá hoặc tự nhập:`,
      { parse_mode: "HTML", ...depositKeyboard },
    );
  });

  bot.action("event_2", async (ctx) => {
    const tg = ctx.from!;
    const botInfo = await ctx.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=ref_${tg.id}`;
    await ctx.answerCbQuery();
    await ctx.reply(
      `👥 <b>GIỚI THIỆU BẠN BÈ — NHẬN 1,000 VND/NGƯỜI</b>\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `🔗 <b>Link giới thiệu của bạn:</b>\n` +
      `<code>${link}</code>\n\n` +
      `📋 <b>Cách hoạt động:</b>\n` +
      `   1️⃣ Gửi link trên cho bạn bè\n` +
      `   2️⃣ Bạn bè nhấn link & bắt đầu dùng bot\n` +
      `   3️⃣ Bạn nhận ngay <b>1,000 VND</b> vào số dư\n\n` +
      `💡 Không giới hạn số người — giới thiệu càng nhiều càng nhiều tiền!\n` +
      `⚠️ Mỗi người chỉ được tính một lần.`,
      { parse_mode: "HTML" },
    );
  });

  bot.action("event_3", async (ctx) => {
    await ctx.answerCbQuery();
    await sendBuyKeyMenu(ctx);
  });

  // ────────── 💳 Nạp tiền ──────────
  bot.hears("💳 Nạp tiền", async (ctx) => {
    const bonusActive = isDepositBonusActive();
    const { slot1, slot2 } = getEvent1Slots();
    const banner = bonusActive
      ? `\n🔥 <b>SỰ KIỆN ĐANG DIỄN RA — NẠP ĐƯỢC TẶNG THÊM ${DEPOSIT_BONUS_PCT}%!</b>\n`
      : `\nℹ️ Khung giờ tặng thưởng hôm nay: <b>${slot1.label}</b> và <b>${slot2.label}</b>\n`;
    await ctx.reply(
      `💳 <b>NẠP TIỀN VÀO TÀI KHOẢN</b>\n━━━━━━━━━━━━━━━━━${banner}\nChọn mệnh giá hoặc tự nhập:`,
      { parse_mode: "HTML", ...depositKeyboard },
    );
  });

  bot.action(/deposit_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const amount = parseInt(ctx.match[1]);
    await sendDepositQR(ctx, ctx.from!.id, amount);
  });

  bot.action("deposit_custom", async (ctx) => {
    ctx.session.waitingForDeposit = true;
    await ctx.answerCbQuery();
    await ctx.reply(
      `✏️ <b>NHẬP SỐ TIỀN MUỐN NẠP</b>\n━━━━━━━━━━━━━━━━━\n` +
      `Gửi số tiền bạn muốn nạp (VND):\n\n<i>Ví dụ: 300000</i>`,
      { parse_mode: "HTML" },
    );
  });

  // ────────── 🔑 Nhập key ──────────
  bot.hears("🔑 Nhập key", async (ctx) => {
    ctx.session.waitingForKey = true;
    await ctx.reply(
      `🔑 <b>NHẬP KEY KÍCH HOẠT</b>\n━━━━━━━━━━━━━━━━━\n` +
      `Vui lòng gửi key vào chat bên dưới:\n\n<i>Ví dụ: HARU-TEST-XXXX-XXXX</i>`,
      { parse_mode: "HTML" },
    );
  });

  // ────────── 🛒 Mua key ──────────
  bot.hears("🛒 Mua key", async (ctx) => {
    await sendBuyKeyMenu(ctx);
  });

  async function sendBuyKeyMenu(ctx: BotContext) {
    const products = await getActiveKeyProducts();
    if (products.length === 0) {
      await ctx.reply(
        `🛒 <b>MUA KEY</b>\n━━━━━━━━━━━━━━━━━\n😔 Hiện chưa có sản phẩm nào.`,
        { parse_mode: "HTML", ...getMainMenuKeyboard(ctx.from!.id) },
      );
      return;
    }

    const discountActive = isKeyDiscountActive();
    const { slot1: e3s1, slot2: e3s2 } = getEvent3Slots();

    const buttons = products.map((p) => {
      const emoji = TIER_EMOJI[p.name] ?? "⚪";
      const origPrice = parseFloat(p.price as string);
      const finalPrice = discountActive ? discountedPrice(origPrice, KEY_DISCOUNT_PCT) : origPrice;
      const label = discountActive
        ? `${emoji} ${p.name} — ~~${fmtMoney(origPrice)}đ~~ → ${fmtMoney(finalPrice)}đ`
        : `${emoji} ${p.name} — ${fmtMoney(origPrice)}đ / ${durationLabel(p.durationDays)}`;
      return [Markup.button.callback(label, `buy_${p.id}`)];
    });
    buttons.push([Markup.button.callback("◀️ Quay lại", "back_main")]);

    let detail = "";
    for (const p of products) {
      const emoji = TIER_EMOJI[p.name] ?? "⚪";
      const prefix = TIER_CODE[p.name] ?? "KEY";
      const origPrice = parseFloat(p.price as string);
      const games = p.description ? esc(p.description) : (TIER_GAMES[p.name] ?? "Xem game phân tích");
      if (discountActive) {
        const finalPrice = discountedPrice(origPrice, KEY_DISCOUNT_PCT);
        detail +=
          `${emoji} <b>${esc(p.name)}</b>  ·  <code>HARU-${prefix}-XXXX-XXXX</code>\n` +
          `   ~~${fmtMoney(origPrice)}đ~~ → <b>${fmtMoney(finalPrice)}đ</b>  ·  ⏰ ${durationLabel(p.durationDays)}\n` +
          `   🎮 <i>${games}</i>\n\n`;
      } else {
        detail +=
          `${emoji} <b>${esc(p.name)}</b>  ·  <code>HARU-${prefix}-XXXX-XXXX</code>\n` +
          `   💰 ${fmtMoney(origPrice)}đ  ·  ⏰ ${durationLabel(p.durationDays)}\n` +
          `   🎮 <i>${games}</i>\n\n`;
      }
    }

    const discountBanner = discountActive
      ? `\n⚡ <b>🔥 FLASH SALE ĐANG DIỄN RA — GIẢM ${KEY_DISCOUNT_PCT}% TẤT CẢ GÓI!</b>\n`
      : `\nℹ️ Khung giờ Flash Sale hôm nay: <b>${e3s1.label}</b> và <b>${e3s2.label}</b>\n`;

    await ctx.reply(
      `🛒 <b>DANH SÁCH GÓI KEY</b>\n━━━━━━━━━━━━━━━━━${discountBanner}\n${detail}Chọn gói bạn muốn mua 👇`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) },
    );
  }

  bot.action(/buy_(\d+)/, async (ctx) => {
    const productId = parseInt(ctx.match[1]);
    const tg = ctx.from!;

    const products = await getActiveKeyProducts();
    const product = products.find((p) => p.id === productId);
    if (!product) {
      await ctx.answerCbQuery("❌ Sản phẩm không tồn tại", { show_alert: true });
      return;
    }

    const discountActive = isKeyDiscountActive();
    const origPrice = parseFloat(product.price as string);
    const finalPrice = discountActive ? discountedPrice(origPrice, KEY_DISCOUNT_PCT) : origPrice;

    const result = await buyKey(tg.id, productId, discountActive ? finalPrice : undefined);

    if (!result.success) {
      await ctx.answerCbQuery(`❌ ${result.reason}`, { show_alert: true });
      return;
    }

    const emoji = TIER_EMOJI[result.product?.name ?? ""] ?? "⚪";
    const discountLine = discountActive
      ? `🏷 <b>Giá gốc:</b> ${fmtMoney(origPrice)}đ  →  <b>Giá sale:</b> ${fmtMoney(finalPrice)}đ (-${KEY_DISCOUNT_PCT}%)\n`
      : `💰 <b>Đã thanh toán:</b> ${fmtMoney(finalPrice)}đ\n`;
    const gamesLine = result.product
      ? `🎮 <b>Truy cập game:</b> <i>${TIER_GAMES[result.product.name] ?? "Xem game phân tích"}</i>\n`
      : "";

    await ctx.editMessageText(
      `✅ <b>MUA KEY THÀNH CÔNG!</b>\n━━━━━━━━━━━━━━━━━\n` +
      `${emoji} Gói: <b>${esc(result.product?.name)}</b>\n` +
      discountLine +
      gamesLine +
      `🔑 <b>Key của bạn:</b>\n<code>${esc(result.key?.keyCode)}</code>\n\n` +
      `📌 Nhấn <b>🔑 Nhập key</b> và gửi mã trên để kích hoạt!`,
      { parse_mode: "HTML" },
    );
    await ctx.answerCbQuery("✅ Mua key thành công!");
  });

  // ────────── 🆘 Hỗ trợ ──────────
  bot.hears("🆘 Hỗ trợ", async (ctx) => {
    await ctx.reply(
      `🆘 <b>HỖ TRỢ KHÁCH HÀNG</b>\n━━━━━━━━━━━━━━━━━\n` +
      `⏰ Giờ hỗ trợ: 8:00 – 22:00 hàng ngày\n` +
      `⚡ Phản hồi trong vòng 15 phút`,
      { parse_mode: "HTML", ...supportKeyboard },
    );
  });

  // ────────── 🎮 Game ──────────
  bot.hears("🎮 Game", async (ctx) => {
    await ctx.reply(
      `🎮 <b>DANH SÁCH GAME HỖ TRỢ</b>\n━━━━━━━━━━━━━━━━━\nChọn game để xem thông tin:`,
      { parse_mode: "HTML", ...gameMenuKeyboard },
    );
  });

  // ── Shortcut actions từ màn hình khoá ──────────────────────────────────────
  bot.action("go_buy_key", async (ctx) => {
    await ctx.answerCbQuery();
    await sendBuyKeyMenu(ctx);
  });

  bot.action("go_enter_key", async (ctx) => {
    ctx.session.waitingForKey = true;
    await ctx.answerCbQuery();
    await ctx.reply(
      `🔑 <b>NHẬP KEY KÍCH HOẠT</b>\n━━━━━━━━━━━━━━━━━\n` +
      `Vui lòng gửi key vào chat bên dưới:\n\n<i>Ví dụ: HARU-TEST-XXXX-XXXX</i>`,
      { parse_mode: "HTML" },
    );
  });

  bot.action(/game_(taixiumd5|taixiu|rongho|xucxac)/, async (ctx) => {
    const key  = ctx.match[1];
    const meta = GAME_META[key];
    if (!meta) { await ctx.answerCbQuery(); return; }

    const chatId = ctx.chat!.id;
    const msgId  = (ctx.callbackQuery as any).message?.message_id as number;

    // ── Kiểm tra key còn hạn không ──────────────────────────────────────────
    const activeKeys = await getUserActiveKeys(ctx.from!.id);
    if (activeKeys.length === 0) {
      await ctx.answerCbQuery("🔒 Cần key để xem phân tích!", { show_alert: true });
      await ctx.editMessageText(
        `🔒 <b>TÍNH NĂNG BỊ KHÓA</b>\n━━━━━━━━━━━━━━━━━\n` +
        `${meta.emoji} <b>${esc(meta.title)}</b>\n\n` +
        `⚠️ Bạn cần có <b>key còn hạn</b> để xem phân tích game.\n\n` +
        `📦 <b>Các gói key hiện có:</b>\n` +
        `   🟢 <b>Key Test</b> — 10.000đ / 1 ngày\n` +
        `   🔵 <b>Key Phổ Thông</b> — 50.000đ / 7 ngày\n` +
        `   🟣 <b>Key VIP</b> — 145.000đ / 30 ngày\n` +
        `   🔴 <b>Key SVIP</b> — 599.000đ / 6 tháng\n` +
        `   💜 <b>Key SSVIP</b> — 799.000đ / 1 năm\n` +
        `   👑 <b>Key SSSVIP</b> — 999.000đ / 18 tháng\n`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard([
          [Markup.button.callback("🛒 Mua key ngay", "go_buy_key")],
          [Markup.button.callback("🔑 Nhập key có sẵn", "go_enter_key")],
          [Markup.button.callback("◀️ Quay lại", "back_game")],
        ]) },
      );
      return;
    }

    await ctx.answerCbQuery("Đang tải...");
    await ctx.editMessageText(
      `${meta.emoji} <b>${meta.title}</b>\n━━━━━━━━━━━━━━━━━\n⏳ Đang lấy dữ liệu...`,
      { parse_mode: "HTML" },
    );

    try {
      // Gọi song song 3 tác vụ: phân tích cơ bản, phân tích nâng cao, lấy session ID mới nhất
      // TXMD5 có phân tích riêng tích hợp sẵn → không cần advanced block chung
      const [mainText, advanced, latestId] = await Promise.all([
        analyzeGame(key),
        key === "taixiumd5" ? Promise.resolve(null) : fetchAndBuildAdvanced(key),
        fetchLatestId(key),
      ]);

      const fullText = (advanced ? mainText + buildAdvancedBlock(advanced) : mainText)
        + `\n\n<i>🔄 Bot tự động cập nhật khi có phiên mới</i>`;
      await ctx.editMessageText(fullText, { parse_mode: "HTML", ...gameKeyboard(key) });
      trackMessage(chatId, msgId);

      registerGameViewer(key, chatId, msgId);
      const watcher = gameWatchers.get(key)!;
      if (latestId) watcher.lastId = Number(latestId);
    } catch (err: any) {
      logger.warn({ key, err: err?.message }, "game action handler error");
      try {
        // Fallback: hiển thị chỉ phân tích cơ bản nếu advanced lỗi
        const [mainText, latestId] = await Promise.all([analyzeGame(key), fetchLatestId(key)]);
        const fallbackText = mainText + `\n\n<i>🔄 Bot tự động cập nhật khi có phiên mới</i>`;
        await ctx.editMessageText(fallbackText, { parse_mode: "HTML", ...gameKeyboard(key) });
        trackMessage(chatId, msgId);
        registerGameViewer(key, chatId, msgId);
        const watcher = gameWatchers.get(key)!;
        if (latestId) watcher.lastId = Number(latestId);
      } catch {
        await ctx.editMessageText("❌ Không tải được dữ liệu. Vui lòng thử lại.", { parse_mode: "HTML" });
      }
    }
  });

  bot.action(/refresh_game_(\w+)/, async (ctx) => {
    const key  = ctx.match[1];
    const meta = GAME_META[key];
    if (!meta) { await ctx.answerCbQuery(); return; }

    const chatId = ctx.chat!.id;
    const msgId  = (ctx.callbackQuery as any).message?.message_id as number;

    await ctx.answerCbQuery("Đang cập nhật...");

    try {
      // Gọi song song: phân tích cơ bản + nâng cao + lấy session ID mới nhất
      // TXMD5 có phân tích riêng tích hợp sẵn → không cần advanced block chung
      const [mainText, advanced, latestId] = await Promise.all([
        analyzeGame(key),
        key === "taixiumd5" ? Promise.resolve(null) : fetchAndBuildAdvanced(key),
        fetchLatestId(key),
      ]);

      const fullText = (advanced ? mainText + buildAdvancedBlock(advanced) : mainText)
        + `\n\n<i>🔄 Bot tự động cập nhật khi có phiên mới</i>`;
      await ctx.editMessageText(fullText, { parse_mode: "HTML", ...gameKeyboard(key) });
      trackMessage(chatId, msgId);

      registerGameViewer(key, chatId, msgId);
      const watcher = gameWatchers.get(key)!;
      if (latestId) watcher.lastId = Number(latestId);
    } catch (err: any) {
      // Fallback: phân tích cơ bản nếu advanced lỗi — bot không crash
      logger.warn({ key, err: err?.message }, "refresh_game handler error");
      try {
        const [mainText, latestId] = await Promise.all([analyzeGame(key), fetchLatestId(key)]);
        const fallbackText = mainText + `\n\n<i>🔄 Bot tự động cập nhật khi có phiên mới</i>`;
        await ctx.editMessageText(fallbackText, { parse_mode: "HTML", ...gameKeyboard(key) });
        trackMessage(chatId, msgId);
        registerGameViewer(key, chatId, msgId);
        const watcher = gameWatchers.get(key)!;
        if (latestId) watcher.lastId = Number(latestId);
      } catch {
        await ctx.answerCbQuery("❌ Lỗi cập nhật, vui lòng thử lại", { show_alert: true });
      }
    }
  });

  bot.action(/stop_game_(\w+)/, async (ctx) => {
    const key    = ctx.match[1];
    const chatId = ctx.chat!.id;
    const msgId  = (ctx.callbackQuery as any).message?.message_id as number;

    // Gỡ user khỏi watcher
    const watcher = gameWatchers.get(key);
    if (watcher) {
      watcher.subs.delete(chatId);
    }
    userActiveGame.delete(chatId);
    clearPredMsg(key, chatId);

    await ctx.answerCbQuery("✅ Đã dừng theo dõi");
    try {
      await bot.telegram.deleteMessage(chatId, msgId);
    } catch { /* đã xóa */ }
    const meta = GAME_META[key];
    await ctx.reply(
      `🛑 <b>Đã dừng theo dõi ${meta?.emoji ?? ""} ${meta?.title ?? key}</b>\n` +
      `Bấm <b>🎮 Game</b> để xem lại bất kỳ lúc nào.`,
      { parse_mode: "HTML" },
    );
  });

  bot.action("back_game", async (ctx) => {
    await ctx.editMessageText(
      `🎮 <b>DANH SÁCH GAME</b>\n━━━━━━━━━━━━━━━━━\nChọn game bạn muốn chơi:`,
      { parse_mode: "HTML", ...gameMenuKeyboard },
    );
    await ctx.answerCbQuery();
  });

  bot.action("back_main", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("🏠 Về menu chính", getMainMenuKeyboard(ctx.from!.id));
  });

  // ══════════ 🤖 AUTO CHƠI — Autoplay handlers ══════════════════════════════

  // Helper: create a notify function that sends to a specific chatId
  function makeNotify(chatId: number) {
    return async (text: string, extra?: any) => {
      try {
        await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML", ...extra });
      } catch (err: any) {
        logger.warn({ err: err?.message, chatId }, "autoplay notify failed");
      }
    };
  }

  /** Entry point — shown in Xúc Xắc game screen */
  bot.action("ap_start", async (ctx) => {
    const tg     = ctx.from!;
    const chatId = ctx.chat!.id;
    await ctx.answerCbQuery();

    // Must have a valid key
    const activeKeys = await getUserActiveKeys(tg.id);
    if (activeKeys.length === 0) {
      await ctx.reply(
        `🔒 <b>Cần key để dùng Auto Chơi!</b>\nMua hoặc nhập key để tiếp tục.`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard([
          [Markup.button.callback("🛒 Mua key ngay", "go_buy_key")],
        ]) },
      );
      return;
    }

    // Cancel existing session if any
    const existing = getAutoplaySession(tg.id);
    if (existing) {
      existing.stopRequested = true;
      destroyAutoplaySession(tg.id);
    }

    await ctx.reply(
      `🤖 <b>AUTO CHƠI XÚC XẮC</b>\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `⚠️ <b>LƯU Ý QUAN TRỌNG:</b>\n` +
      `• Bot <b>KHÔNG CAM ĐOAN</b> thắng — game mang tính may rủi.\n` +
      `• Bạn tự chịu trách nhiệm về số tiền đặt cược.\n` +
      `• Bot dùng tài khoản Telegram cá nhân của bạn để đặt cược trong @${GAME_BOT_USERNAME}.\n\n` +
      `Nếu đồng ý và muốn tiếp tục, nhập số điện thoại Telegram của bạn:\n` +
      `<i>Ví dụ: +84901234567</i>\n\n` +
      `Gõ /huyap để hủy bất kỳ lúc nào`,
      { parse_mode: "HTML" },
    );

    createAutoplaySession(chatId, tg.id, makeNotify(chatId));
    const sess = getAutoplaySession(tg.id)!;
    sess.phase = "login_phone";

    // Kick off async login — it will callback via notify
    startAutoplayLogin(tg.id).catch(() => {});
  });

  /** Cancel / logout */
  bot.command("huyap", async (ctx) => {
    const tg = ctx.from!;
    const sess = getAutoplaySession(tg.id);
    if (sess) {
      sess.stopRequested = true;
      destroyAutoplaySession(tg.id);
      await ctx.reply("✅ Đã huỷ Auto Chơi và đăng xuất.");
    } else {
      await ctx.reply("ℹ️ Không có phiên Auto Chơi nào đang chạy.");
    }
  });

  bot.action("ap_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    const tg = ctx.from!;
    destroyAutoplaySession(tg.id);
    await ctx.editMessageText("❌ Đã huỷ Auto Chơi.", { parse_mode: "HTML" });
  });

  /** Mode selection */
  bot.action("ap_mode_fixed", async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getAutoplaySession(ctx.from!.id);
    if (!sess) { await ctx.editMessageText("❌ Phiên đã hết hạn. Thử lại từ đầu."); return; }
    sess.mode  = "fixed";
    sess.phase = "config_amount";
    await ctx.editMessageText(
      `📌 <b>Chế độ cố định</b>\n━━━━━━━━━━━━━━━━━\nNhập số tiền đặt cố định mỗi phiên (VND):\n\n<i>Ví dụ: 50000</i>`,
      { parse_mode: "HTML" },
    );
  });

  bot.action("ap_mode_auto", async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getAutoplaySession(ctx.from!.id);
    if (!sess) { await ctx.editMessageText("❌ Phiên đã hết hạn. Thử lại từ đầu."); return; }
    sess.mode  = "auto";
    sess.phase = "config_doors";
    await ctx.editMessageText(
      `🤖 <b>Chế độ tự động (5% vốn/phiên)</b>\n━━━━━━━━━━━━━━━━━\nChọn số cửa đặt cược:`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([
        [
          Markup.button.callback("1️⃣ 1 Cửa (Tài/Xỉu)", "ap_doors_1"),
          Markup.button.callback("2️⃣ 2 Cửa (TX + CL)", "ap_doors_2"),
        ],
        [Markup.button.callback("❌ Huỷ", "ap_cancel")],
      ]) },
    );
  });

  /** Doors selection */
  bot.action("ap_doors_1", async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getAutoplaySession(ctx.from!.id);
    if (!sess) { await ctx.editMessageText("❌ Phiên đã hết hạn. Thử lại từ đầu."); return; }
    sess.doors = 1;
    sess.phase = "config_target";
    const balFmt = sess.currentBalance > 0
      ? `Số dư hiện tại: <code>${sess.currentBalance.toLocaleString("vi-VN")} VND</code>\n`
      : "";
    await ctx.editMessageText(
      `1️⃣ <b>1 Cửa — Bot đặt Tài/Xỉu theo dự đoán</b>\n━━━━━━━━━━━━━━━━━\n${balFmt}` +
      `Nhập <b>mục tiêu số dư</b> muốn đạt (VND).\nKhi đạt được bot sẽ tự dừng:\n\n<i>Ví dụ: 500000</i>`,
      { parse_mode: "HTML" },
    );
  });

  bot.action("ap_doors_2", async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getAutoplaySession(ctx.from!.id);
    if (!sess) { await ctx.editMessageText("❌ Phiên đã hết hạn. Thử lại từ đầu."); return; }
    sess.doors = 2;
    sess.phase = "config_target";
    const balFmt = sess.currentBalance > 0
      ? `Số dư hiện tại: <code>${sess.currentBalance.toLocaleString("vi-VN")} VND</code>\n`
      : "";
    await ctx.editMessageText(
      `2️⃣ <b>2 Cửa — Bot đặt Tài/Xỉu + Chẵn/Lẻ theo dự đoán</b>\n━━━━━━━━━━━━━━━━━\n${balFmt}` +
      `Nhập <b>mục tiêu số dư</b> muốn đạt (VND).\nKhi đạt được bot sẽ tự dừng:\n\n<i>Ví dụ: 500000</i>`,
      { parse_mode: "HTML" },
    );
  });

  /** Runtime controls */
  bot.action("ap_pause", async (ctx) => {
    await ctx.answerCbQuery("⏸ Đã dừng");
    const sess = getAutoplaySession(ctx.from!.id);
    if (!sess) return;
    sess.phase = "paused";
    await ctx.editMessageText(
      buildStatusMsg(sess) + `\n\n⏸ <b>Đang tạm dừng...</b>`,
      { parse_mode: "HTML", ...controlKeyboard(true) },
    );
  });

  bot.action("ap_resume", async (ctx) => {
    await ctx.answerCbQuery("▶️ Đang chạy lại");
    const sess = getAutoplaySession(ctx.from!.id);
    if (!sess) return;
    sess.phase = "running";
    await ctx.editMessageText(
      buildStatusMsg(sess) + `\n\n▶️ <b>Đang tiếp tục...</b>`,
      { parse_mode: "HTML", ...controlKeyboard(false) },
    );
  });

  bot.action("ap_logout", async (ctx) => {
    await ctx.answerCbQuery("🚪 Đang đăng xuất...");
    const sess = getAutoplaySession(ctx.from!.id);
    if (!sess) return;
    sess.stopRequested = true;
    // destroyAutoplaySession will be called by the loop when it exits
    await ctx.editMessageText(
      buildStatusMsg(sess) + `\n\n🚪 <b>Đang đăng xuất...</b>`,
      { parse_mode: "HTML" },
    );
  });

  // ══════════════════════════════════════════════════════════════════════════

  // ────────── 📊 Admin — Thống kê Analytics ──────────
  // /thongke        → tất cả thời gian
  // /thongke 7      → 7 ngày gần nhất
  // /thongke 30     → 30 ngày gần nhất
  bot.command("thongke", async (ctx) => {
    const tg = ctx.from!;
    if (!isAdmin(tg.id)) return;

    const arg  = ctx.message.text.trim().split(/\s+/)[1];
    const days = arg ? parseInt(arg) : undefined;
    if (days !== undefined && (isNaN(days) || days <= 0)) {
      await ctx.reply("❌ Sử dụng: /thongke [số ngày]\nVí dụ: /thongke 7  hoặc  /thongke 30");
      return;
    }

    const loadingMsg = await ctx.reply("⏳ Đang tính toán thống kê...");

    try {
      const s = await getAnalyticsStats(days);

      // ── Tổng quan ──
      const winBar = buildProgressBar(s.overallWinRate);
      const header =
        `📊 <b>ANALYTICS — ${s.period.toUpperCase()}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 Tổng dự đoán: <b>${s.totalPredictions}</b>  (BET: <b>${s.totalBets}</b> · SKIP: <b>${s.totalSkips}</b>)\n` +
        `✅ Đã xác minh: <b>${s.totalVerified}</b>  |  Đúng: <b>${s.totalCorrect}</b>\n` +
        `🎯 Tỷ lệ thắng: <b>${s.overallWinRate}%</b>  ${winBar}\n` +
        `⏭ Tỷ lệ SKIP:  <b>${s.overallSkipRate}%</b>\n`;

      // ── Theo Game ──
      const byGameLines = s.byGame.length
        ? s.byGame.map(g => {
            const icon = g.winRate >= 60 ? "🟢" : g.winRate >= 50 ? "🟡" : "🔴";
            return `  ${icon} <b>${g.gameKey}</b>: ${g.verified}v · ${g.winRate}% thắng · skip ${g.skipRate}%`;
          }).join("\n")
        : "  (chưa có dữ liệu)";

      // ── Theo Band ──
      const byBandLines = s.byConfBand
        .filter(b => b.bets > 0)
        .map(b => {
          const icon = b.winRate >= 60 ? "🟢" : b.winRate >= 50 ? "🟡" : "🔴";
          return `  ${icon} [${b.band}] ${b.bets} BET · <b>${b.winRate}%</b> thắng`;
        }).join("\n") || "  (chưa có dữ liệu)";

      // ── Giờ vàng (top 3 win rate, tối thiểu 3 BET) ──
      const goldHours = s.byHour
        .filter(h => h.bets >= 3)
        .sort((a, b) => b.winRate - a.winRate)
        .slice(0, 3)
        .map(h => `  🕐 ${String(h.hour).padStart(2,"0")}:00 — ${h.winRate}% thắng (${h.bets} BET)`)
        .join("\n") || "  (cần thêm dữ liệu)";

      const text =
        header +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🎮 <b>Theo Game:</b>\n${byGameLines}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📈 <b>Band tin cậy:</b>\n${byBandLines}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🏆 <b>Giờ vàng (VN):</b>\n${goldHours}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 /xuatfile [ngày] để tải Excel chi tiết`;

      await ctx.telegram.editMessageText(tg.id, loadingMsg.message_id, undefined, text, { parse_mode: "HTML" });
    } catch (err: any) {
      logger.error({ err }, "/thongke error");
      await ctx.telegram.editMessageText(tg.id, loadingMsg.message_id, undefined,
        `❌ Lỗi tính toán: ${esc(err?.message ?? "unknown")}`, { parse_mode: "HTML" });
    }
  });

  // /xuatfile        → xuất Excel tất cả thời gian
  // /xuatfile 7      → 7 ngày
  // /xuatfile 30     → 30 ngày
  bot.command("xuatfile", async (ctx) => {
    const tg = ctx.from!;
    if (!isAdmin(tg.id)) return;

    const arg  = ctx.message.text.trim().split(/\s+/)[1];
    const days = arg ? parseInt(arg) : undefined;
    if (days !== undefined && (isNaN(days) || days <= 0)) {
      await ctx.reply("❌ Sử dụng: /xuatfile [số ngày]\nVí dụ: /xuatfile 30");
      return;
    }

    const loadingMsg = await ctx.reply(`⏳ Đang tạo file Excel${days ? ` (${days} ngày)` : ""}...`);
    try {
      const buffer = await exportExcel(days);
      const now    = new Date(Date.now() + 7 * 3_600_000);
      const pad    = (n: number) => String(n).padStart(2, "0");
      const stamp  = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}`;
      const label  = days ? `${days}d` : "all";
      const fname  = `haru_analytics_${label}_${stamp}.xlsx`;

      await ctx.replyWithDocument(
        { source: buffer, filename: fname },
        {
          caption:
            `📊 <b>Haru Bot Analytics</b>\n` +
            `📅 Kỳ: ${days ? `${days} ngày` : "tất cả"}\n` +
            `🗓 Xuất: ${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)} (giờ VN)\n\n` +
            `5 sheets: Tổng quan · Theo Game · Theo Giờ · Band Tin cậy · Chi tiết`,
          parse_mode: "HTML",
        },
      );

      // Xóa tin nhắn loading
      try { await ctx.telegram.deleteMessage(tg.id, loadingMsg.message_id); } catch { /* ok */ }
    } catch (err: any) {
      logger.error({ err }, "/xuatfile error");
      await ctx.telegram.editMessageText(tg.id, loadingMsg.message_id, undefined,
        `❌ Lỗi tạo file: ${esc(err?.message ?? "unknown")}`, { parse_mode: "HTML" });
    }
  });

  // ────────── 🔐 Admin — Đăng nhập MTProto ──────────
  bot.hears("🔐 Đăng nhập", async (ctx) => {
    const tg = ctx.from!;
    if (!isAdmin(tg.id)) return;

    if (authStates.has(tg.id)) {
      await ctx.reply("⏳ Đang trong quá trình đăng nhập. Nhập mã theo hướng dẫn hoặc gõ /huydk để hủy.");
      return;
    }

    const client = await getMainClient();
    if (client) {
      try {
        const me = await client.getMe() as any;
        const name = [me.firstName, me.lastName].filter(Boolean).join(" ");
        const uname = me.username ? ` (@${me.username})` : "";
        const phone = me.phone ? `\n📱 <code>+${me.phone}</code>` : "";
        await ctx.reply(
          `✅ <b>Đã đăng nhập</b>\n━━━━━━━━━━━━━━━━━\n👤 <b>${esc(name)}${esc(uname)}</b>${phone}`,
          { parse_mode: "HTML" },
        );
      } catch {
        await ctx.reply("✅ Đã đăng nhập (không lấy được thông tin tài khoản).");
      }
      return;
    }

    const chatId = ctx.chat!.id;
    const phoneDeferred = createDeferred<string>();
    const codeDeferred  = createDeferred<string>();
    const passDeferred  = createDeferred<string>();

    authStates.set(tg.id, {
      phase: "phone",
      phoneDeferred,
      codeDeferred,
      passwordDeferred: passDeferred,
      chatId,
    });

    await ctx.reply(
      `🔐 <b>Đăng nhập tài khoản Telegram</b>\n━━━━━━━━━━━━━━━━━\n` +
      `Nhập số điện thoại để đọc kênh lịch sử:\n<i>Ví dụ: +84901234567</i>\n\n` +
      `Gõ /huydk để hủy`,
      { parse_mode: "HTML" },
    );

    startInteractiveAuth({
      onNeedPhone: () => phoneDeferred.promise,
      onNeedCode: async () => {
        const state = authStates.get(tg.id);
        if (state) state.phase = "code";
        await bot.telegram.sendMessage(chatId,
          "📲 <b>Nhập mã OTP</b> Telegram vừa gửi về điện thoại của bạn:",
          { parse_mode: "HTML" },
        );
        return codeDeferred.promise;
      },
      onNeedPassword: async () => {
        const state = authStates.get(tg.id);
        if (state) state.phase = "password";
        await bot.telegram.sendMessage(chatId, "🔒 Nhập mật khẩu xác minh 2 bước (2FA):");
        return passDeferred.promise;
      },
    }).then(async (result) => {
      authStates.delete(tg.id);
      if (result === "success") {
        // Khởi động real-time watcher ngay sau khi auth xong
        resetXucXacWatcher();
        tryStartXucXacRealtime().catch(() => {});

        try {
          const loggedClient = await getMainClient();
          const me = loggedClient ? await loggedClient.getMe() as any : null;
          const name = me ? [me.firstName, me.lastName].filter(Boolean).join(" ") : "?";
          const uname = me?.username ? ` (@${me.username})` : "";
          const phone = me?.phone ? `\n📱 <code>+${me.phone}</code>` : "";
          await bot.telegram.sendMessage(chatId,
            `✅ <b>Đăng nhập thành công!</b>\n━━━━━━━━━━━━━━━━━\n👤 <b>${name}${uname}</b>${phone}\n\n` +
            `📡 <b>Xúc Xắc real-time watcher đã được kích hoạt.</b>`,
            { parse_mode: "HTML" },
          );
        } catch {
          await bot.telegram.sendMessage(chatId,
            "✅ <b>Đăng nhập thành công!</b>",
            { parse_mode: "HTML" },
          );
        }
      } else {
        await bot.telegram.sendMessage(chatId, "❌ Đăng nhập thất bại. Vui lòng thử lại.");
      }
    }).catch(async (err) => {
      authStates.delete(tg.id);
      logger.error({ err }, "Admin auth error");
      await bot.telegram.sendMessage(chatId, `❌ Lỗi: ${esc(err?.message ?? "unknown")}`);
    });
  });

  // Admin: cancel auth
  bot.command("huydk", (ctx) => {
    const tg = ctx.from!;
    if (!isAdmin(tg.id)) return;
    if (authStates.has(tg.id)) {
      const s = authStates.get(tg.id)!;
      const err = new Error("Cancelled by user");
      s.phoneDeferred.reject(err);
      s.codeDeferred.reject(err);
      s.passwordDeferred.reject(err);
      authStates.delete(tg.id);
    }
    ctx.reply("✅ Đã hủy quá trình đăng nhập.");
  });

  // Tải cấu hình STK tĩnh từ DB (chạy nền, không block)
  loadStaticDepositInfo().catch(() => {});

  // Tự động đăng nhập lại MB Bank nếu có credentials đã lưu → QR nạp tiền luôn hoạt động
  setTimeout(() => autoRestoreBankSession(bot).catch(() => {}), 3000);

  // ────────── /setbank — Cài số tài khoản nhận tiền (admin) ──────────
  bot.command("setbank", async (ctx) => {
    const tg = ctx.from!;
    if (!isAdmin(tg.id)) return;

    // Cú pháp: /setbank <STK> <TênTK> [TênNgânHàng]
    // Ví dụ:   /setbank 0987654321 NGUYEN VAN A MB Bank
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length < 2) {
      await ctx.reply(
        `❌ <b>Cú pháp sai!</b>\n\n` +
        `Dùng: <code>/setbank &lt;STK&gt; &lt;TênTK&gt; [TênNgânHàng]</code>\n\n` +
        `Ví dụ:\n` +
        `<code>/setbank 0987654321 NGUYEN VAN A MB Bank</code>\n` +
        `<code>/setbank 1234567890 TRAN THI B Vietcombank</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const accountNumber = args[0];
    // Tên tài khoản là args[1..n-1] nếu không có tên NH, hoặc args[1..n-2] nếu có
    // Heuristic: nếu arg cuối là tên ngân hàng phổ biến thì tách ra
    const KNOWN_BANKS = ["mb bank", "vietcombank", "techcombank", "bidv", "agribank", "vietinbank", "tpbank", "vpbank", "acb", "sacombank", "hdbank", "ocb", "msb", "seabank", "shinhan", "cake"];
    const lastArg = args.slice(-1)[0].toLowerCase();
    let bankName = "MB Bank";
    let nameParts = args.slice(1);
    // Thử ghép 2 args cuối để check tên NH
    if (args.length >= 3) {
      const lastTwo = args.slice(-2).join(" ").toLowerCase();
      if (KNOWN_BANKS.some(b => lastTwo === b || lastArg === b.split(" ").pop())) {
        bankName = args.slice(-2).join(" ");
        nameParts = args.slice(1, -2);
        if (nameParts.length === 0) nameParts = args.slice(1, -1);
      }
    }
    const accountName = nameParts.join(" ").toUpperCase();

    await setStaticBankAccount({ accountNumber, accountName, bankName });
    await ctx.reply(
      `✅ <b>Đã cài số tài khoản nhận tiền!</b>\n\n` +
      `🏦 Ngân hàng: <b>${bankName}</b>\n` +
      `💳 STK: <code>${accountNumber}</code>\n` +
      `👤 Tên TK: <b>${accountName}</b>\n\n` +
      `Bot sẽ tự động tạo mã QR và hướng dẫn nạp tiền cho user.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("clearbank", async (ctx) => {
    if (!isAdmin(ctx.from!.id)) return;
    await clearStaticBankAccount();
    await ctx.reply("✅ Đã xóa cấu hình số tài khoản tĩnh.", { parse_mode: "HTML" });
  });

  // ────────── MB Bank handlers (phải trước bot.on text để hears() không bị che) ──────────
  registerBankHandlers(bot);

  // ────────── Xử lý text ──────────
  bot.on(message("text"), async (ctx) => {
    const tg = ctx.from!;
    const text = ctx.message.text.trim();

    // ── Autoplay: intercept text khi đang trong các bước setup ──────────────
    const apSess = getAutoplaySession(tg.id);
    if (apSess) {
      // Auth phases
      if (apSess.phase === "login_phone") {
        apSess.phoneDeferred?.resolve(text);
        return;
      }
      if (apSess.phase === "login_code") {
        apSess.codeDeferred?.resolve(text);
        return;
      }
      if (apSess.phase === "login_password") {
        apSess.passDeferred?.resolve(text);
        return;
      }
      // Config phases
      if (apSess.phase === "config_amount") {
        const raw = text.replace(/[.,\s]/g, "");
        const amt = parseInt(raw);
        if (isNaN(amt) || amt < 1_000) {
          await ctx.reply("❌ Số tiền không hợp lệ (tối thiểu 1,000 VND). Nhập lại:");
          return;
        }
        apSess.fixedAmount = amt;
        apSess.phase       = "config_doors";
        await ctx.reply(
          `📌 Đặt cố định <b>${amt.toLocaleString("vi-VN")} VND</b>/phiên.\n━━━━━━━━━━━━━━━━━\nChọn số cửa đặt cược:`,
          { parse_mode: "HTML", ...Markup.inlineKeyboard([
            [
              Markup.button.callback("1️⃣ 1 Cửa (Tài/Xỉu)", "ap_doors_1"),
              Markup.button.callback("2️⃣ 2 Cửa (TX + CL)", "ap_doors_2"),
            ],
            [Markup.button.callback("❌ Huỷ", "ap_cancel")],
          ]) },
        );
        return;
      }
      if (apSess.phase === "config_target") {
        const raw    = text.replace(/[.,\s]/g, "");
        const target = parseInt(raw);
        if (isNaN(target) || target <= 0) {
          await ctx.reply("❌ Mục tiêu không hợp lệ. Nhập lại (VND):");
          return;
        }
        apSess.targetBalance = target;
        apSess.phase         = "running";

        await ctx.reply(
          `🚀 <b>BẮT ĐẦU AUTO CHƠI!</b>\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `📌 Chế độ: <b>${apSess.mode === "fixed" ? `Cố định ${apSess.fixedAmount?.toLocaleString("vi-VN")} VND` : "Tự động 5% vốn"}</b>\n` +
          `🚪 Số cửa: <b>${apSess.doors}</b>\n` +
          `🎯 Mục tiêu: <b>${target.toLocaleString("vi-VN")} VND</b>\n\n` +
          `Bot đang đợi phiên tiếp theo để đặt cược...\n` +
          `Gõ /huyap để dừng bất kỳ lúc nào.`,
          { parse_mode: "HTML", ...controlKeyboard(false) },
        );

        // Start loop in background
        startAutoplayLoop(tg.id).catch(logger.error);
        return;
      }
    }

    // Admin đang trong luồng đăng nhập MTProto
    if (isAdmin(tg.id) && authStates.has(tg.id)) {
      const state = authStates.get(tg.id)!;
      if (state.phase === "phone") {
        state.phoneDeferred.resolve(text);
      } else if (state.phase === "code") {
        state.codeDeferred.resolve(text);
      } else if (state.phase === "password") {
        state.passwordDeferred.resolve(text);
      }
      return;
    }

    // Đang chờ nhập captcha startup (OCR thất bại khi khởi động)
    if (getPendingStartupCaptcha(tg.id)) {
      await handleStartupCaptcha(tg.id, text, bot, ctx);
      return;
    }

    // Đang trong luồng đăng nhập MB Bank
    if (isBankLoginPending(tg.id)) {
      await handleBankTextMessage(tg.id, text, bot, ctx);
      return;
    }

    // Đang chờ nhập số tiền nạp
    if (ctx.session.waitingForDeposit) {
      ctx.session.waitingForDeposit = false;
      const raw = text.replace(/[.,\s]/g, "");
      const amount = parseInt(raw);

      if (isNaN(amount) || amount < 10_000) {
        await ctx.reply(
          `❌ <b>Số tiền không hợp lệ!</b>\nVui lòng nhập số tiền tối thiểu 10.000 VND.\n\n<i>Ví dụ: 300000</i>`,
          { parse_mode: "HTML" },
        );
        return;
      }

      await sendDepositQR(ctx, tg.id, amount);
      return;
    }

    // Đang chờ nhập key
    if (ctx.session.waitingForKey) {
      ctx.session.waitingForKey = false;
      const result = await activateKey(text, tg.id);

      if (!result.success) {
        await ctx.reply(
          `❌ <b>Kích hoạt thất bại!</b>\n━━━━━━━━━━━━━━━━━\nLý do: ${esc(result.reason)}\n\nKiểm tra lại key hoặc liên hệ <b>🆘 Hỗ trợ</b>`,
          { parse_mode: "HTML", ...getMainMenuKeyboard(tg.id) },
        );
        return;
      }

      const days = daysRemaining(result.expiresAt ?? null);
      const expiry = fmtDateTime(result.expiresAt ?? null);
      const emoji = TIER_EMOJI[result.product?.name ?? ""] ?? "⚪";
      const stackLine = result.stacked && result.oldExpiry
        ? `📅 <b>Cộng dồn từ:</b> ${fmtDateTime(result.oldExpiry)} → <b>${expiry}</b>\n`
        : `📅 <b>Hết hạn lúc:</b> <b>${expiry}</b>\n`;
      const gamesAccess = result.product
        ? `\n🎮 <b>Game được truy cập:</b>\n<i>${TIER_GAMES[result.product.name] ?? "Xem game phân tích"}</i>\n`
        : "";

      await ctx.reply(
        `✅ <b>KEY KÍCH HOẠT THÀNH CÔNG!</b>\n━━━━━━━━━━━━━━━━━\n` +
        `${emoji} Gói: <b>${esc(result.product?.name ?? "Standard")}</b>\n` +
        `🔑 Key: <code>${esc(text.toUpperCase())}</code>\n` +
        `⏳ Còn <b>${days} ngày</b>\n` +
        stackLine +
        gamesAccess +
        (result.stacked ? `\n🎯 <b>Thời hạn đã được cộng dồn!</b>\n` : ``) +
        `\n🎉 Nhấn 🎮 <b>Game</b> để bắt đầu xem phân tích!`,
        { parse_mode: "HTML", ...getMainMenuKeyboard(tg.id) },
      );
      return;
    }

    await ctx.reply("Chọn chức năng từ menu bên dưới 👇", getMainMenuKeyboard(tg.id));
  });

  // ────────── Error handling ──────────
  bot.catch((err: unknown) => {
    logger.error({ err }, "Telegraf error");
  });

  // ────────── Xúc Xắc real-time watcher (MTProto event) ──────────
  /**
   * Khởi động event-based watcher cho xúc xắc.
   * Gọi sau khi MTProto client sẵn sàng (bot start hoặc sau auth thành công).
   */
  async function tryStartXucXacRealtime() {
    const started = await startXucXacWatcher(async (session) => {
      const watcher = gameWatchers.get("xucxac");
      if (!watcher) return;
      // Cập nhật lastId ngay khi nhận tin nhắn mới
      if (session.sessionId <= watcher.lastId) return;
      watcher.lastId = session.sessionId;
      logger.info({ sessionId: session.sessionId }, "XucXac real-time: new session — pushing");
      await pushGameUpdate(bot, "xucxac");
    });
    if (started) {
      logger.info("XucXac MTProto real-time watcher registered");
    }
  }

  // Thử ngay khi bot khởi động (nếu đã có session lưu sẵn)
  tryStartXucXacRealtime().catch(() => {});

  // ────────── Auto-delete messages older than 60 min (check every 15 min) ─────
  setInterval(async () => {
    const cutoff = Date.now() - 60 * 60_000; // 60 phút
    const expired = trackedMessages.filter(m => m.sentAt < cutoff);
    for (const m of expired) {
      try { await bot.telegram.deleteMessage(m.chatId, m.messageId); } catch { /* already gone */ }
    }
    if (expired.length > 0) {
      trackedMessages.splice(0, trackedMessages.length, ...trackedMessages.filter(m => m.sentAt >= cutoff));
      logger.info({ count: expired.length }, "Auto-deleted expired game messages");
    }
  }, 15 * 60_000);

  // ────────── Key expiry checker (60s — thông báo user khi key hết giữa chừng) ─
  setInterval(async () => {
    for (const [gameKey, watcher] of gameWatchers) {
      if (watcher.subs.size === 0) continue;
      const entries = [...watcher.subs.entries()];
      for (const [chatId, oldMsgId] of entries) {
        try {
          const activeKeys = await getUserActiveKeys(chatId);
          if (activeKeys.length > 0) continue;
          // Key vừa hết → xoá khỏi watcher và thông báo
          watcher.subs.delete(chatId);
          userActiveGame.delete(chatId);
          try { await bot.telegram.deleteMessage(chatId, oldMsgId); } catch { /* ok */ }
          const meta = GAME_META[gameKey];
          await bot.telegram.sendMessage(chatId,
            `⏰ <b>KEY CỦA BẠN ĐÃ HẾT HẠN!</b>\n━━━━━━━━━━━━━━━━━\n` +
            `🔒 Tính năng ${meta?.emoji ?? ""} <b>${meta?.title ?? gameKey}</b> đã bị tạm khoá.\n\n` +
            `Vui lòng mua hoặc nhập key mới để tiếp tục xem phân tích!`,
            { parse_mode: "HTML", ...Markup.inlineKeyboard([
              [Markup.button.callback("🛒 Mua key ngay", "go_buy_key")],
              [Markup.button.callback("🔑 Nhập key có sẵn", "go_enter_key")],
            ]) },
          );
          logger.info({ chatId, gameKey }, "Key expired — removed from watcher and notified");
        } catch { /* user blocked bot hoặc lỗi mạng */ }
      }
    }
  }, 60_000);

  // ────────── Game auto-update poller (8s — tất cả trừ xucxac) ───────────
  setInterval(async () => {
    for (const [key, watcher] of gameWatchers) {
      // Xúc Xắc đã được xử lý bằng real-time event → bỏ qua ở đây
      if (key === "xucxac") continue;
      if (watcher.subs.size === 0) continue;
      try {
        const rawId = await fetchLatestId(key);
        if (rawId === null) continue;
        const latestId = Number(rawId);
        if (latestId === watcher.lastId) continue;

        logger.info({ key, latestId, prev: watcher.lastId }, "New game session — pushing update");
        watcher.lastId = latestId;
        await pushGameUpdate(bot, key);
      } catch (pollErr: any) {
        logger.warn({ key, err: pollErr?.message }, "Game poller error");
      }
    }
  }, 8_000);

  return bot;
}
