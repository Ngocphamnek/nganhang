import { getMainClient } from "./client";
import { logger } from "../lib/logger";
import { db, botSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface RoundResult {
  session: number;
  dice: [number, number, number] | null;
  total: number | null;
  outcome: "Tài" | "Xỉu";
}

export interface Analysis {
  latest: RoundResult[];
  streak: { type: "Tài" | "Xỉu"; count: number };
  stats: { tai: number; xiu: number; total: number };
  taiPct: number;
  xiuPct: number;
  pattern: string;
  suggestion: string;
  lastSession: number | null;
  channel: string;
}

// ─── Read channel from DB (fallback to hardcoded default) ────────────────────

const DEFAULT_CHANNEL = "lichsuphienclmmgg";

async function getTxcChannel(): Promise<string> {
  try {
    const [row] = await db
      .select()
      .from(botSettingsTable)
      .where(eq(botSettingsTable.key, "txc_channel"));
    return row?.value?.trim() || DEFAULT_CHANNEL;
  } catch {
    return DEFAULT_CHANNEL;
  }
}

// ─── Parsers for common Vietnamese TXC channel formats ───────────────────────

function parseMessage(text: string): RoundResult | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();

  const sessionMatch = t.match(/(?:phiên\s*#?|#)(\d+)/i) ?? t.match(/^(\d{4,})/);
  const session = sessionMatch ? parseInt(sessionMatch[1]) : NaN;

  const outcomeMatch = t.match(/\b(t[àa]i|xỉu|xiu)\b/i);
  if (!outcomeMatch) return null;
  const outcome: "Tài" | "Xỉu" = /^(t[àa]i)/i.test(outcomeMatch[1]) ? "Tài" : "Xỉu";

  const diceMatch =
    t.match(/(\d)\s*[-|]\s*(\d)\s*[-|]\s*(\d)/) ??
    t.match(/(\d)\s+(\d)\s+(\d)\s*=\s*\d+/) ??
    t.match(/xúc xắc[:\s]+(\d)[^\d]+(\d)[^\d]+(\d)/i);

  let dice: [number, number, number] | null = null;
  let total: number | null = null;

  if (diceMatch) {
    const d1 = parseInt(diceMatch[1]);
    const d2 = parseInt(diceMatch[2]);
    const d3 = parseInt(diceMatch[3]);
    if (d1 >= 1 && d1 <= 6 && d2 >= 1 && d2 <= 6 && d3 >= 1 && d3 <= 6) {
      dice = [d1, d2, d3];
      total = d1 + d2 + d3;
    }
  }

  if (!total) {
    const totalMatch = t.match(/(?:tổng|total)[:\s]+(\d+)/i) ?? t.match(/=(\d+)/);
    total = totalMatch ? parseInt(totalMatch[1]) : null;
  }

  return {
    session: isNaN(session) ? 0 : session,
    dice,
    total,
    outcome,
  };
}

// ─── Pattern detection ────────────────────────────────────────────────────────

function detectPattern(results: RoundResult[]): string {
  if (results.length < 4) return "Chưa đủ dữ liệu";

  const outcomes = results.map((r) => r.outcome);

  let alternating = true;
  for (let i = 1; i < Math.min(6, outcomes.length); i++) {
    if (outcomes[i] === outcomes[i - 1]) { alternating = false; break; }
  }
  if (alternating) return "Xen kẽ (T-X-T-X)";

  let streak = 1;
  let maxStreak = 1;
  let maxType = outcomes[0];
  for (let i = 1; i < outcomes.length; i++) {
    if (outcomes[i] === outcomes[i - 1]) {
      streak++;
      if (streak > maxStreak) { maxStreak = streak; maxType = outcomes[i]; }
    } else {
      streak = 1;
    }
  }
  if (maxStreak >= 4) return `Cầu dài ${maxType} (${maxStreak} phiên liên tiếp)`;
  if (maxStreak === 3) return `Cầu 3 ${maxType} liên tiếp`;

  let twoTwo = true;
  for (let i = 0; i + 3 < Math.min(8, outcomes.length); i += 2) {
    if (outcomes[i] !== outcomes[i + 1] || outcomes[i] === outcomes[i + 2]) {
      twoTwo = false; break;
    }
  }
  if (twoTwo && outcomes.length >= 6) return "Cầu đôi (TT-XX-TT-XX)";

  return "Không rõ quy luật";
}

function makeSuggestion(
  streak: { type: "Tài" | "Xỉu"; count: number },
  taiPct: number,
): string {
  if (streak.count >= 5)
    return `⚡ Cầu ${streak.type} dài (${streak.count}), xem xét đặt ${streak.type === "Tài" ? "Xỉu" : "Tài"} — tuy nhiên cầu có thể tiếp tục!`;
  if (streak.count >= 3)
    return `🔥 Đang có cầu ${streak.type} ${streak.count} phiên — theo cầu hoặc chờ gãy`;
  if (taiPct >= 60) return "📈 Tài đang chiếm ưu thế (>60%) trong phiên gần đây";
  if (taiPct <= 40) return "📉 Xỉu đang chiếm ưu thế (>60%) trong phiên gần đây";
  return "⚖️ Tỷ lệ Tài/Xỉu cân bằng — phân tích thêm để quyết định";
}

// ─── Main export ──────────────────────────────────────────────────────────────

const FETCH_LIMIT = 60;

export async function fetchAndAnalyze(limit = 30): Promise<Analysis | null> {
  const client = await getMainClient();
  if (!client) return null;

  const channel = await getTxcChannel();

  try {
    const messages = await client.getMessages(channel, { limit: FETCH_LIMIT });

    const results: RoundResult[] = [];
    for (const msg of messages) {
      const text = (msg as any).text ?? (msg as any).message ?? "";
      if (!text) continue;
      const parsed = parseMessage(text);
      if (parsed) results.push(parsed);
      if (results.length >= limit) break;
    }

    if (results.length === 0) return null;

    const taiCount = results.filter((r) => r.outcome === "Tài").length;
    const xiuCount = results.length - taiCount;
    const taiPct = Math.round((taiCount / results.length) * 100);
    const xiuPct = 100 - taiPct;

    const first = results[0].outcome;
    let streakCount = 0;
    for (const r of results) {
      if (r.outcome === first) streakCount++;
      else break;
    }
    const streak = { type: first, count: streakCount };

    const pattern = detectPattern(results);
    const suggestion = makeSuggestion(streak, taiPct);
    const lastSession = results[0]?.session || null;

    return {
      latest: results.slice(0, 20),
      streak,
      stats: { tai: taiCount, xiu: xiuCount, total: results.length },
      taiPct,
      xiuPct,
      pattern,
      suggestion,
      lastSession,
      channel,
    };
  } catch (err) {
    logger.error({ err }, "fetchAndAnalyze failed");
    return null;
  }
}

/** Format analysis as HTML for Telegram bot reply */
export function formatAnalysis(a: Analysis): string {
  const bar = (count: number, total: number, char: string): string => {
    const filled = Math.round((count / total) * 10);
    return char.repeat(filled) + "░".repeat(10 - filled);
  };

  const recentRow = a.latest
    .slice(0, 15)
    .map((r) => (r.outcome === "Tài" ? "🔴" : "🔵"))
    .join(" ");

  return (
    `🎲 <b>PHÂN TÍCH TÀI XỈU — ${a.channel}</b>\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    (a.lastSession ? `📌 Phiên gần nhất: <b>#${a.lastSession}</b>\n\n` : "\n") +
    `📊 <b>15 phiên gần nhất:</b>\n` +
    `${recentRow}\n` +
    `🔴 Tài  🔵 Xỉu\n\n` +
    `📈 <b>Thống kê ${a.stats.total} phiên:</b>\n` +
    `🔴 Tài:  ${bar(a.stats.tai, a.stats.total, "🟥")} ${a.taiPct}%\n` +
    `🔵 Xỉu: ${bar(a.stats.xiu, a.stats.total, "🟦")} ${a.xiuPct}%\n\n` +
    `🔥 <b>Cầu hiện tại:</b> ${a.streak.type} × ${a.streak.count} phiên\n` +
    `🧩 <b>Quy luật:</b> ${a.pattern}\n\n` +
    `💡 <b>Nhận xét:</b> ${a.suggestion}\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `⚠️ <i>Chỉ mang tính tham khảo — không đảm bảo kết quả</i>`
  );
}
