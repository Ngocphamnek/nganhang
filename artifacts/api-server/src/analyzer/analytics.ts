/**
 * Analytics module — đo lường & đánh giá hiệu năng Advanced AI
 *
 * Luồng:
 *   1. fetchAndBuildAdvanced() gọi logPrediction() → ghi hàng vào prediction_logs
 *   2. Poller/watcher phát hiện phiên mới → gọi verifyPrediction() → điền actual_label + is_correct
 *   3. Admin /thongke → getAnalyticsStats() → hiển thị bảng tóm tắt
 *   4. Admin /xuatfile → exportExcel() → gửi file .xlsx
 */

import { db, predictionLogsTable } from "@workspace/db";
import { eq, and, isNull, isNotNull, desc, sql, gte } from "drizzle-orm";
import ExcelJS from "exceljs";

// ─── In-memory sequential counter cho Advanced AI (per game) ─────────────────

interface AdvancedCounter {
  n: number;                        // 1-100, sau đó reset về 1
  lastResult: "win" | "lose" | null;
}
const _advCounters = new Map<string, AdvancedCounter>();

/** Lấy counter hiện tại của Advanced AI cho một game. */
export function getAdvancedCounter(gameKey: string): AdvancedCounter | null {
  return _advCounters.get(gameKey) ?? null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Giờ hiện tại theo múi giờ Việt Nam (UTC+7) */
function vnHour(): number {
  return new Date(Date.now() + 7 * 3_600_000).getUTCHours();
}

// ─── Ghi nhận dự đoán ────────────────────────────────────────────────────────

export interface LogPredictionParams {
  gameKey:        string;
  sessionId:      number;
  action:         string;   // "BET" | "SKIP"
  predictedLabel: string;   // "" khi SKIP
  confidence:     number;
  trendScore:     number;
  freqScore:      number;
  revScore:       number;
}

/**
 * Ghi một dự đoán mới vào DB. Fire-and-forget — không throw ra ngoài.
 * Trả về id của hàng mới, hoặc null nếu lỗi.
 */
export async function logPrediction(p: LogPredictionParams): Promise<number | null> {
  try {
    const [row] = await db
      .insert(predictionLogsTable)
      .values({
        gameKey:        p.gameKey,
        sessionId:      p.sessionId,
        action:         p.action,
        predictedLabel: p.predictedLabel || null,
        confidence:     p.confidence,
        trendScore:     p.trendScore,
        freqScore:      p.freqScore,
        revScore:       p.revScore,
        hourOfDay:      vnHour(),
      })
      .returning({ id: predictionLogsTable.id });
    return row?.id ?? null;
  } catch {
    return null;
  }
}

// ─── Xác minh kết quả ────────────────────────────────────────────────────────

/**
 * Khi phiên kế tiếp về, tìm dự đoán BET cuối cùng chưa verify của game đó
 * và điền actual_label + is_correct + verifiedAt.
 *
 * Gọi trong game poller ngay sau khi phát hiện phiên mới.
 * Fire-and-forget — không ảnh hưởng bot nếu lỗi.
 */
export async function verifyPrediction(
  gameKey:     string,
  actualLabel: string,   // label thực của phiên kế tiếp
): Promise<void> {
  try {
    // Lấy hàng BET chưa verify gần nhất của game này
    const [row] = await db
      .select({ id: predictionLogsTable.id, predictedLabel: predictionLogsTable.predictedLabel })
      .from(predictionLogsTable)
      .where(
        and(
          eq(predictionLogsTable.gameKey, gameKey),
          eq(predictionLogsTable.action, "BET"),
          isNull(predictionLogsTable.isCorrect),
        ),
      )
      .orderBy(desc(predictionLogsTable.id))
      .limit(1);

    if (!row) return;

    const isCorrect = row.predictedLabel === actualLabel;
    await db
      .update(predictionLogsTable)
      .set({
        actualLabel,
        isCorrect,
        verifiedAt: new Date(),
      })
      .where(eq(predictionLogsTable.id, row.id));

    // Cập nhật in-memory counter
    const ctr = _advCounters.get(gameKey) ?? { n: 0, lastResult: null };
    ctr.n = ctr.n >= 100 ? 1 : ctr.n + 1;
    ctr.lastResult = isCorrect ? "win" : "lose";
    _advCounters.set(gameKey, ctr);
  } catch {
    // Không crash bot
  }
}

// ─── Thống kê ────────────────────────────────────────────────────────────────

export interface GameStats {
  gameKey:    string;
  total:      number;
  bets:       number;
  skips:      number;
  verified:   number;
  correct:    number;
  winRate:    number;    // %
  skipRate:   number;    // %
  avgConf:    number;    // điểm tự tin TB của BET đã verify
}

export interface HourStats {
  hour:     number;  // 0–23
  bets:     number;
  correct:  number;
  winRate:  number;
}

export interface ConfBandStats {
  band:    string;   // "65–69", "70–74", "75–79", "80+"
  bets:    number;
  correct: number;
  winRate: number;
}

export interface AnalyticsStats {
  period:          string;    // "7 ngày" | "30 ngày" | "tất cả"
  totalPredictions: number;
  totalBets:       number;
  totalSkips:      number;
  totalVerified:   number;
  totalCorrect:    number;
  overallWinRate:  number;
  overallSkipRate: number;
  byGame:          GameStats[];
  byHour:          HourStats[];
  byConfBand:      ConfBandStats[];
  generatedAt:     Date;
}

/**
 * Tính toán thống kê đầy đủ từ DB.
 * @param days  Số ngày lookback (undefined = tất cả)
 */
export async function getAnalyticsStats(days?: number): Promise<AnalyticsStats> {
  const sinceDate = days
    ? new Date(Date.now() - days * 86_400_000)
    : undefined;

  // Lấy toàn bộ hàng trong khoảng thời gian
  const rows = await db
    .select()
    .from(predictionLogsTable)
    .where(sinceDate ? gte(predictionLogsTable.createdAt, sinceDate) : undefined)
    .orderBy(desc(predictionLogsTable.createdAt));

  const period = days ? `${days} ngày` : "tất cả";
  const bets      = rows.filter(r => r.action === "BET");
  const skips     = rows.filter(r => r.action === "SKIP");
  const verified  = bets.filter(r => r.isCorrect !== null);
  const correct   = verified.filter(r => r.isCorrect === true);

  // ── By game ──────────────────────────────────────────────────────────────
  const gameKeys = [...new Set(rows.map(r => r.gameKey))];
  const byGame: GameStats[] = gameKeys.map(key => {
    const gRows     = rows.filter(r => r.gameKey === key);
    const gBets     = gRows.filter(r => r.action === "BET");
    const gSkips    = gRows.filter(r => r.action === "SKIP");
    const gVerified = gBets.filter(r => r.isCorrect !== null);
    const gCorrect  = gVerified.filter(r => r.isCorrect === true);
    const avgConf   = gVerified.length
      ? Math.round(gVerified.reduce((s, r) => s + r.confidence, 0) / gVerified.length)
      : 0;
    return {
      gameKey:  key,
      total:    gRows.length,
      bets:     gBets.length,
      skips:    gSkips.length,
      verified: gVerified.length,
      correct:  gCorrect.length,
      winRate:  gVerified.length ? Math.round((gCorrect.length / gVerified.length) * 100) : 0,
      skipRate: gRows.length ? Math.round((gSkips.length / gRows.length) * 100) : 0,
      avgConf,
    };
  }).sort((a, b) => b.bets - a.bets);

  // ── By hour (VN time) ─────────────────────────────────────────────────────
  const hourMap = new Map<number, { bets: number; correct: number }>();
  for (const r of bets) {
    const h = r.hourOfDay ?? 0;
    const cur = hourMap.get(h) ?? { bets: 0, correct: 0 };
    cur.bets++;
    if (r.isCorrect === true) cur.correct++;
    hourMap.set(h, cur);
  }
  const byHour: HourStats[] = [...hourMap.entries()]
    .map(([hour, v]) => ({
      hour,
      bets:    v.bets,
      correct: v.correct,
      winRate: v.bets ? Math.round((v.correct / v.bets) * 100) : 0,
    }))
    .sort((a, b) => a.hour - b.hour);

  // ── By confidence band ────────────────────────────────────────────────────
  const bands: Array<[string, number, number]> = [
    ["65–69", 65, 69], ["70–74", 70, 74], ["75–79", 75, 79], ["80+", 80, 999],
  ];
  const byConfBand: ConfBandStats[] = bands.map(([label, lo, hi]) => {
    const band     = verified.filter(r => r.confidence >= lo && r.confidence <= hi);
    const bandOk   = band.filter(r => r.isCorrect === true);
    return {
      band:    label,
      bets:    band.length,
      correct: bandOk.length,
      winRate: band.length ? Math.round((bandOk.length / band.length) * 100) : 0,
    };
  });

  return {
    period,
    totalPredictions: rows.length,
    totalBets:        bets.length,
    totalSkips:       skips.length,
    totalVerified:    verified.length,
    totalCorrect:     correct.length,
    overallWinRate:   verified.length ? Math.round((correct.length / verified.length) * 100) : 0,
    overallSkipRate:  rows.length ? Math.round((skips.length / rows.length) * 100) : 0,
    byGame,
    byHour,
    byConfBand,
    generatedAt: new Date(),
  };
}

// ─── Xuất Excel ──────────────────────────────────────────────────────────────

const GAME_TITLE: Record<string, string> = {
  taixiu:    "Tài Xỉu",
  taixiumd5: "Tài Xỉu MD5",
  rongho:    "Rồng Hổ",
  xucxac:    "Xúc Xắc",
};

/** Màu header cho bảng Excel */
const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern", pattern: "solid",
  fgColor: { argb: "FF1A1A2E" },
};
const HEADER_FONT: Partial<ExcelJS.Font> = {
  color: { argb: "FFFFFFFF" }, bold: true, size: 11,
};
const GREEN_FILL: ExcelJS.Fill = {
  type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAD3" },
};
const RED_FILL: ExcelJS.Fill = {
  type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE8E6" },
};
const YELLOW_FILL: ExcelJS.Fill = {
  type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3CD" },
};

function applyHeader(row: ExcelJS.Row) {
  row.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin" }, bottom: { style: "thin" },
      left: { style: "thin" }, right: { style: "thin" },
    };
  });
  row.height = 28;
}

function applyDataRow(row: ExcelJS.Row, winRate?: number) {
  const fill = winRate === undefined ? undefined
    : winRate >= 60 ? GREEN_FILL
    : winRate >= 50 ? YELLOW_FILL
    : RED_FILL;
  row.eachCell(cell => {
    if (fill) cell.fill = fill;
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = {
      top: { style: "hair" }, bottom: { style: "hair" },
      left: { style: "hair" }, right: { style: "hair" },
    };
  });
  row.height = 22;
}

/**
 * Tạo buffer Excel (.xlsx) chứa 4 sheet:
 *   1. Tổng quan (Overview)
 *   2. Theo Game
 *   3. Theo Giờ (VN)
 *   4. Theo Band Tin cậy
 *   5. Lịch sử chi tiết (raw log, 2000 hàng gần nhất)
 */
export async function exportExcel(days?: number): Promise<Buffer> {
  const stats = await getAnalyticsStats(days);

  // Lấy raw log cho sheet chi tiết (tối đa 2000 hàng mới nhất)
  const sinceDate = days ? new Date(Date.now() - days * 86_400_000) : undefined;
  const rawRows = await db
    .select()
    .from(predictionLogsTable)
    .where(sinceDate ? gte(predictionLogsTable.createdAt, sinceDate) : undefined)
    .orderBy(desc(predictionLogsTable.createdAt))
    .limit(2000);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Haru Bot Analytics";
  wb.created = new Date();

  // ── Sheet 1: Tổng quan ───────────────────────────────────────────────────
  const s1 = wb.addWorksheet("📊 Tổng quan");
  s1.columns = [
    { width: 30 }, { width: 20 },
  ];

  const titleRow = s1.addRow(["🤖 HARU BOT — ANALYTICS REPORT", ""]);
  titleRow.getCell(1).font = { bold: true, size: 14 };
  s1.mergeCells("A1:B1");
  s1.addRow([`Kỳ phân tích: ${stats.period}`, `Xuất lúc: ${fmtDateTime(stats.generatedAt)}`]);
  s1.addRow([]);

  const overviewData: [string, string | number][] = [
    ["Tổng số dự đoán",         stats.totalPredictions],
    ["Số BET (phát tín hiệu)",  stats.totalBets],
    ["Số SKIP (bỏ qua)",        stats.totalSkips],
    ["Tỷ lệ SKIP",              `${stats.overallSkipRate}%`],
    ["Đã xác minh kết quả",     stats.totalVerified],
    ["Dự đoán đúng",            stats.totalCorrect],
    ["Tỷ lệ thắng tổng",       `${stats.overallWinRate}%`],
  ];
  const hRow = s1.addRow(["Chỉ số", "Giá trị"]);
  applyHeader(hRow);
  for (const [label, val] of overviewData) {
    const r = s1.addRow([label, val]);
    applyDataRow(r);
  }

  // ── Sheet 2: Theo Game ───────────────────────────────────────────────────
  const s2 = wb.addWorksheet("🎮 Theo Game");
  s2.columns = [
    { width: 16 }, { width: 10 }, { width: 10 }, { width: 10 },
    { width: 12 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 12 },
  ];
  const h2 = s2.addRow(["Game", "Tổng", "BET", "SKIP", "Đã verify", "Đúng", "Thắng %", "SKIP %", "ĐTin TB"]);
  applyHeader(h2);
  for (const g of stats.byGame) {
    const r = s2.addRow([
      GAME_TITLE[g.gameKey] ?? g.gameKey,
      g.total, g.bets, g.skips, g.verified, g.correct,
      `${g.winRate}%`, `${g.skipRate}%`, g.avgConf,
    ]);
    applyDataRow(r, g.winRate);
  }

  // ── Sheet 3: Theo Giờ ────────────────────────────────────────────────────
  const s3 = wb.addWorksheet("🕐 Theo Giờ VN");
  s3.columns = [{ width: 14 }, { width: 10 }, { width: 10 }, { width: 12 }];
  const h3 = s3.addRow(["Giờ (VN)", "BET", "Đúng", "Thắng %"]);
  applyHeader(h3);
  for (const h of stats.byHour) {
    const r = s3.addRow([
      `${String(h.hour).padStart(2, "0")}:00 – ${String(h.hour).padStart(2, "0")}:59`,
      h.bets, h.correct, `${h.winRate}%`,
    ]);
    applyDataRow(r, h.winRate);
  }
  // Thêm hàng tổng
  const s3Total = s3.addRow([
    "TỔNG",
    stats.totalBets,
    stats.totalCorrect,
    `${stats.overallWinRate}%`,
  ]);
  s3Total.font = { bold: true };

  // ── Sheet 4: Theo Band Tin Cậy ───────────────────────────────────────────
  const s4 = wb.addWorksheet("📈 Band Tin Cậy");
  s4.columns = [{ width: 14 }, { width: 10 }, { width: 10 }, { width: 12 }];
  const h4 = s4.addRow(["Điểm tin cậy", "BET", "Đúng", "Thắng %"]);
  applyHeader(h4);
  for (const b of stats.byConfBand) {
    const r = s4.addRow([b.band, b.bets, b.correct, `${b.winRate}%`]);
    applyDataRow(r, b.winRate);
  }

  // ── Sheet 5: Lịch sử chi tiết ────────────────────────────────────────────
  const s5 = wb.addWorksheet("📋 Chi tiết");
  s5.columns = [
    { header: "ID",         key: "id",     width: 8  },
    { header: "Game",       key: "game",   width: 14 },
    { header: "Phiên #",    key: "sid",    width: 10 },
    { header: "Action",     key: "action", width: 8  },
    { header: "Dự đoán",    key: "pred",   width: 10 },
    { header: "Thực tế",    key: "actual", width: 10 },
    { header: "Điểm TC",    key: "conf",   width: 10 },
    { header: "Trend",      key: "trend",  width: 8  },
    { header: "Freq",       key: "freq",   width: 8  },
    { header: "Rev",        key: "rev",    width: 8  },
    { header: "Kết quả",    key: "ok",     width: 10 },
    { header: "Giờ VN",     key: "hour",   width: 10 },
    { header: "Thời gian",  key: "ts",     width: 20 },
    { header: "Xác minh",   key: "vts",    width: 20 },
  ];
  applyHeader(s5.getRow(1));

  for (const row of rawRows) {
    const isOk = row.isCorrect === true ? "✅ Đúng"
      : row.isCorrect === false ? "❌ Sai"
      : "⏳ Chờ";
    const r = s5.addRow({
      id:     row.id,
      game:   GAME_TITLE[row.gameKey] ?? row.gameKey,
      sid:    row.sessionId,
      action: row.action,
      pred:   row.predictedLabel ?? "—",
      actual: row.actualLabel ?? "—",
      conf:   row.confidence,
      trend:  row.trendScore ?? "—",
      freq:   row.freqScore ?? "—",
      rev:    row.revScore ?? "—",
      ok:     isOk,
      hour:   row.hourOfDay !== null && row.hourOfDay !== undefined
        ? `${String(row.hourOfDay).padStart(2, "0")}:xx`
        : "—",
      ts:  fmtDateTime(row.createdAt),
      vts: row.verifiedAt ? fmtDateTime(row.verifiedAt) : "—",
    });
    const fill = row.isCorrect === true ? GREEN_FILL
      : row.isCorrect === false ? RED_FILL
      : undefined;
    if (fill) {
      r.eachCell(cell => {
        cell.fill = fill;
      });
    }
    r.alignment = { vertical: "middle", horizontal: "center" };
    r.height = 20;
  }

  // Freeze header rows
  for (const ws of [s2, s3, s4, s5]) {
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  return wb.xlsx.writeBuffer() as Promise<Buffer>;
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  const vn = new Date(d.getTime() + 7 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${vn.getUTCFullYear()}-${pad(vn.getUTCMonth() + 1)}-${pad(vn.getUTCDate())} ` +
         `${pad(vn.getUTCHours())}:${pad(vn.getUTCMinutes())}:${pad(vn.getUTCSeconds())}`;
}
