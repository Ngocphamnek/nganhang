// ─── Game analyzers — api.s6688v.xyz ────────────────────────────────────────

import { createHash } from "node:crypto";
import {
  runTournament,
  formatTournamentSection,
} from "./tournament";

function md5hex(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

export const GAME_APIS: Record<string, string> = {
  taixiu:    "https://api.s6688v.xyz/tx_session_history_list",
  taixiumd5: "https://api.s6688v.xyz/txmd5_session_history_list",
  rongho:    "https://api.s6688v.xyz/lh_session_history_list",
  // xucxac: dữ liệu từ Telegram @lichsuphienclmmgg — không dùng API web
};

export const GAME_META: Record<string, { title: string; emoji: string }> = {
  taixiu:    { title: "Tài Xỉu",     emoji: "🎲" },
  taixiumd5: { title: "Tài Xỉu MD5", emoji: "🔐" },
  rongho:    { title: "Rồng Hổ",      emoji: "🐉" },
  xucxac:    { title: "Xúc Xắc",      emoji: "🎲" },
};

interface Session { rs: number[]; sessionId: number; time: number; _id?: string }
interface ApiResp  { d: Session[] }

// ─── Prediction accuracy tracking ────────────────────────────────────────────

interface PredRec { sessionId: number; label: string; prob: number }
const predStore = new Map<string, PredRec>();           // key → last stored prediction
const accMap    = new Map<string, { ok: number; total: number }>();

export function getPredStats(key: string) { return accMap.get(key) ?? null; }

/** Check nếu predStore có dự đoán cũ → xác minh đúng/sai với sessions mới */
function verifyPred(
  key: string,
  sessions: Session[],
  labelFn: (s: Session) => string | null,
): void {
  const prev = predStore.get(key);
  if (!prev || sessions.length === 0) return;
  // sessions sorted newest-first; find first session chronologically after prev.sessionId
  const newer = sessions.filter(s => s.sessionId > prev.sessionId);
  if (newer.length === 0) return;
  const firstNew = newer[newer.length - 1]; // smallest id among those > prev
  const actual   = labelFn(firstNew);
  if (actual === null) return; // skip unclassifiable (Hòa v.v.)
  const acc = accMap.get(key) ?? { ok: 0, total: 0 };
  acc.total++;
  if (actual === prev.label) acc.ok++;
  accMap.set(key, acc);
}

function storePred(key: string, sessionId: number, label: string, prob: number): void {
  predStore.set(key, { sessionId, label, prob });
}

function accLine(key: string): string {
  const a = accMap.get(key);
  if (!a || a.total === 0) return "";
  const p = ((a.ok / a.total) * 100).toFixed(1);
  const bar10 = "▓".repeat(Math.round(a.ok / a.total * 10)) + "░".repeat(10 - Math.round(a.ok / a.total * 10));
  return `\n📊 <b>Bot accuracy:</b> ${a.ok}/${a.total} đúng  <b>${p}%</b>  ${bar10}`;
}

// ─── fetch: lấy tối đa lịch sử ───────────────────────────────────────────────

async function fetchSessions(url: string): Promise<Session[]> {
  const attempts = [
    `${url}?limit=1000&size=1000&pageSize=1000`,
    `${url}?limit=500`,
    url,
  ];
  for (const target of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(target, { signal: controller.signal });
      if (!res.ok) continue;
      const data: ApiResp = await res.json();
      const rows = data.d ?? [];
      if (rows.length > 0) return rows;
    } catch { /* try next */ } finally { clearTimeout(timer); }
  }
  return [];
}

// ─── Session cache 30s: tránh double-fetch khi analyzeGame + fetchAndBuildAdvanced gọi song song ──
const _sessionCache = new Map<string, { data: Session[]; ts: number }>();
const SESSION_CACHE_TTL = 30_000; // 30 giây

/**
 * Fetch sessions với cache ngắn hạn.
 * Nếu cùng key đã được fetch trong 30s qua → trả về cache ngay, không gọi mạng.
 */
async function fetchSessionsCached(url: string, cacheKey: string): Promise<Session[]> {
  const hit = _sessionCache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < SESSION_CACHE_TTL) return hit.data;
  const data = await fetchSessions(url);
  // Chỉ cache khi có dữ liệu thực (tránh cache lỗi)
  if (data.length > 0) _sessionCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

/**
 * Xoá cache phiên của một game cụ thể.
 * Gọi từ pushGameUpdate ngay khi poller phát hiện phiên MỚI
 * → đảm bảo analyzeGame + fetchAndBuildAdvanced luôn fetch dữ liệu tươi,
 *   không hiển thị phiên cũ dù cache vẫn còn TTL.
 * Hai hàm vẫn SHARE một lần fetch nhờ cơ chế cache được set lại ngay sau đó.
 */
export function invalidateSessionCache(key: string): void {
  _sessionCache.delete(key);
}

/** Lấy sessionId mới nhất — dùng cho poller */
export async function fetchLatestId(key: string): Promise<number | null> {
  if (key === "xucxac") {
    const { fetchLatestXucXacId } = await import("./xucxac");
    return fetchLatestXucXacId();
  }
  const url = GAME_APIS[key];
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${url}?limit=1`, { signal: controller.signal });
    if (!res.ok) return null;
    const data: ApiResp = await res.json();
    return data.d?.[0]?.sessionId ?? null;
  } catch { return null; } finally { clearTimeout(timer); }
}

// ─── shared helpers ──────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
  return total ? `${((n / total) * 100).toFixed(1)}%` : "0%";
}

function bar(n: number, total: number, w = 10): string {
  const f = total ? Math.round((n / total) * w) : 0;
  return "▓".repeat(f) + "░".repeat(w - f);
}

// ─── AI-enhanced cầu analysis (Markov + streak + weight) ─────────────────────

interface CauResult {
  type: string;
  currentLabel: string;
  currentCount: number;
  longestLabel: string;
  longestCount: number;
  prediction: string;
  predictedLabel: string;
  confidence: string;
  probability: number;
}

function analyzeCau(labels: string[], opposites: Record<string, string>): CauResult {
  const empty: CauResult = {
    type: "—", currentLabel: "—", currentCount: 0,
    longestLabel: "—", longestCount: 0,
    prediction: "—", predictedLabel: "—", confidence: "—", probability: 50,
  };
  if (!labels.length) return empty;

  // ── Current streak ──
  const currentLabel = labels[0];
  let currentCount = 1;
  for (let i = 1; i < labels.length; i++) {
    if (labels[i] === currentLabel) currentCount++;
    else break;
  }

  // ── Longest streak ──
  let longestLabel = labels[0], longestCount = 1, tmp = 1;
  for (let i = 1; i < labels.length; i++) {
    if (labels[i] === labels[i - 1]) {
      tmp++;
      if (tmp > longestCount) { longestCount = tmp; longestLabel = labels[i]; }
    } else { tmp = 1; }
  }

  // ── Alternating rate (last 10) ──
  const slice10 = labels.slice(0, Math.min(10, labels.length));
  let alt = 0;
  for (let i = 0; i < slice10.length - 1; i++) if (slice10[i] !== slice10[i + 1]) alt++;
  const altRate = (slice10.length - 1) > 0 ? alt / (slice10.length - 1) : 0;

  // ── Cau type ──
  let type: string;
  if      (currentCount >= 3) type = "Cầu thẳng";
  else if (altRate >= 0.7)    type = "Cầu 1-1 (xen kẽ)";
  else if (altRate <= 0.3)    type = "Cầu liên tiếp";
  else                        type = "Cầu gãy";

  const other = opposites[currentLabel] ?? currentLabel;
  const allKeys = Object.keys(opposites);

  // ── Markov transition matrix (newest-first → i+1 is older, i is newer) ──
  const trans: Record<string, Record<string, number>> = {};
  for (const k of allKeys) { trans[k] = {}; for (const k2 of allKeys) trans[k][k2] = 0; }
  for (let i = 0; i < labels.length - 1; i++) {
    const from = labels[i + 1]; // older state
    const to   = labels[i];     // newer (what followed)
    if (trans[from]) trans[from][to] = (trans[from][to] ?? 0) + 1;
  }

  // Recent-weighted transition (last 30, weight ×3)
  const transW: Record<string, Record<string, number>> = {};
  for (const k of allKeys) { transW[k] = {}; for (const k2 of allKeys) transW[k][k2] = 0; }
  const recent30 = labels.slice(0, Math.min(30, labels.length));
  for (let i = 0; i < recent30.length - 1; i++) {
    const from = recent30[i + 1];
    const to   = recent30[i];
    if (transW[from]) transW[from][to] = (transW[from][to] ?? 0) + 3;
  }

  // Blend trans + transW
  const blended: Record<string, Record<string, number>> = {};
  for (const k of allKeys) {
    blended[k] = {};
    for (const k2 of allKeys) blended[k][k2] = (trans[k]?.[k2] ?? 0) + (transW[k]?.[k2] ?? 0);
  }

  // Markov probability for current label
  const fromCur   = blended[currentLabel] ?? {};
  const totalT    = Object.values(fromCur).reduce((s, v) => s + v, 0);
  let markovLabel = currentLabel;
  let markovProb  = 50;
  if (totalT > 0) {
    const pStay   = ((fromCur[currentLabel] ?? 0) / totalT) * 100;
    const pSwitch = ((fromCur[other] ?? 0) / totalT) * 100;
    markovLabel = pSwitch > pStay ? other : currentLabel;
    markovProb  = Math.max(pStay, pSwitch);
  }

  // ── Blend Markov + streak signals ──
  let finalLabel = markovLabel;
  let finalProb  = markovProb;

  if (currentCount >= 7) {
    // Extremely long streak → strong reversal warning
    finalLabel = other;
    finalProb  = Math.min(80, 65 + currentCount);
  } else if (currentCount >= 5) {
    // Long streak → lean toward reversal
    finalLabel = other;
    finalProb  = Math.max(finalProb, Math.min(78, 58 + currentCount * 2.5));
  } else if (altRate >= 0.8) {
    // Very strong alternating → switch
    finalLabel = other;
    finalProb  = Math.min(75, 55 + altRate * 22);
  } else if (altRate >= 0.7 && finalLabel !== other) {
    // Moderate alternating — nudge toward other
    finalLabel = other;
    finalProb  = Math.max(finalProb, Math.min(70, 52 + altRate * 20));
  }

  // Clamp: never claim more than 80% confidence (random game, honesty matters)
  finalProb = Math.min(80, Math.max(52, Math.round(finalProb)));

  let confidence: string;
  if      (finalProb >= 72) confidence = "🟢 Cao";
  else if (finalProb >= 63) confidence = "🟡 Trung bình";
  else                      confidence = "🔴 Thấp";

  return {
    type, currentLabel, currentCount, longestLabel, longestCount,
    prediction: `${finalLabel} (${finalProb}%)`,
    predictedLabel: finalLabel,
    confidence,
    probability: finalProb,
  };
}

// ─── Tài Xỉu / Tài Xỉu MD5 ──────────────────────────────────────────────────

function txLabel(rs: number[]): "Tài" | "Xỉu" {
  return rs[0] + rs[1] + rs[2] >= 11 ? "Tài" : "Xỉu";
}
function txEmoji(l: string): string { return l === "Tài" ? "🔴" : "🔵"; }

// ─── Pattern 100 phiên — phương pháp riêng ────────────────────────────────────
// Logic:
//   1. Lấy phiên mới nhất [xx1, xx2, xx3]
//   2. Với mỗi vị trí p: tìm trong 100 phiên TRƯỚC phiên mới nhất session nào có xxP = giá trị hiện tại
//   3. Khi tìm thấy, lấy giá trị xxP của phiên TRƯỚC PHIÊN ĐÓ (cũ hơn 1) → dự đoán xxP kế tiếp
//   4. Độ tin cậy: 3/3 vị trí có tín hiệu = chắc chắn hơn; 2/3 = không chắc chắn
// ─────────────────────────────────────────────────────────────────────────────

const DICE_ICON_ARR = ["","⚀","⚁","⚂","⚃","⚄","⚅"];

function buildPatternPrediction(sessions: Session[]): string {
  // Cần ít nhất 3 phiên: sessions[0]=hiện tại, sessions[1..100]=history, sessions[i+1]=có thể cần
  if (sessions.length < 3) return "";

  const current = sessions[0];
  // Tìm trong 100 phiên ngay trước phiên hiện tại (sessions[1..100])
  // Khi match tại sessions[i], "trước phiên đó" = sessions[i+1]
  const histEnd = Math.min(101, sessions.length); // sessions[1..100], cần sessions[i+1] nên histEnd=101
  const history = sessions.slice(1, histEnd);     // history[0..histEnd-2]

  type PosResult = {
    currentVal: number;
    predictedVal: number | null;
    matchedSessionId: number | null;
    beforeSessionId: number | null;
  };

  const results: PosResult[] = [];

  for (let p = 0; p < 3; p++) {
    const targetVal = current.rs[p];
    const res: PosResult = { currentVal: targetVal, predictedVal: null, matchedSessionId: null, beforeSessionId: null };

    // Tìm phiên đầu tiên trong 100 phiên trước có xxP = targetVal
    for (let i = 0; i < Math.min(100, history.length); i++) {
      if (history[i].rs[p] === targetVal) {
        // Tìm thấy ở history[i] (= sessions[i+1])
        // "Trước phiên đó" = phiên cũ hơn history[i] = history[i+1]
        if (i + 1 < history.length) {
          res.matchedSessionId = history[i].sessionId;
          res.predictedVal     = history[i + 1].rs[p];
          res.beforeSessionId  = history[i + 1].sessionId;
        } else {
          // history[i] là phiên cuối cùng, không có phiên trước → không predict
          res.matchedSessionId = history[i].sessionId;
        }
        break;
      }
    }

    results.push(res);
  }

  const matchCount = results.filter(r => r.predictedVal !== null).length;

  const lines: string[] = [
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🔬 <b>PHÂN TÍCH PATTERN 100 PHIÊN</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📌 <b>Phiên hiện tại #${current.sessionId}:</b>  [${current.rs.join("-")}]  →  Tổng <b>${current.rs.reduce((a,b)=>a+b,0)}</b>  ${txEmoji(txLabel(current.rs))} <b>${txLabel(current.rs)}</b>`,
    ``,
    `🔍 <b>Dò pattern trong 100 phiên trước:</b>`,
  ];

  for (let p = 0; p < 3; p++) {
    const r = results[p];
    const posLabel = `XX${p + 1}`;
    const curIcon  = DICE_ICON_ARR[r.currentVal] ?? String(r.currentVal);
    if (r.predictedVal !== null) {
      const predIcon = DICE_ICON_ARR[r.predictedVal] ?? String(r.predictedVal);
      lines.push(
        `  ${curIcon} <b>${posLabel}=${r.currentVal}</b>` +
        ` → khớp tại <code>#${r.matchedSessionId}</code>` +
        ` → phiên trước đó: ${predIcon} <b>${r.predictedVal}</b>` +
        ` (từ <code>#${r.beforeSessionId}</code>) ✅`,
      );
    } else if (r.matchedSessionId !== null) {
      lines.push(
        `  ${curIcon} <b>${posLabel}=${r.currentVal}</b>` +
        ` → khớp tại <code>#${r.matchedSessionId}</code> nhưng không có phiên trước đó ⚠️`,
      );
    } else {
      lines.push(
        `  ${curIcon} <b>${posLabel}=${r.currentVal}</b> → không tìm thấy trong 100 phiên ❌`,
      );
    }
  }

  lines.push(``);

  if (matchCount === 0) {
    lines.push(`⚠️ <b>Không tìm thấy pattern</b> — Không đủ tín hiệu, bỏ qua phiên này.`);
    return lines.join("\n");
  }

  // Tính tổng dự đoán — vị trí không có tín hiệu dùng giá trị hiện tại (bảo thủ)
  const predictedDice = results.map(r => r.predictedVal ?? r.currentVal);
  const predictedSum  = predictedDice.reduce((a, b) => a + b, 0);
  const predictedLbl  = predictedSum >= 11 ? "Tài" : "Xỉu";

  lines.push(
    `🎯 <b>Dự đoán phiên kế tiếp:</b>`,
    `   Xúc xắc dự kiến: [${predictedDice.join("-")}]  →  Tổng <b>${predictedSum}</b>`,
    `   Kết quả: ${txEmoji(predictedLbl)} <b>${predictedLbl}</b>`,
    ``,
  );

  if (matchCount === 3) {
    lines.push(`✅ <b>Tỷ lệ: Chắc chắn hơn</b> — Cả 3 xúc xắc đều có tín hiệu rõ ràng!`);
  } else if (matchCount === 2) {
    lines.push(`⚠️ <b>Tỷ lệ: Không chắc chắn</b> — Chỉ 2/3 xúc xắc có tín hiệu, cẩn thận.`);
  } else {
    lines.push(`🔴 <b>Tỷ lệ: Yếu</b> — Chỉ ${matchCount}/3 xúc xắc có tín hiệu.`);
  }

  return lines.join("\n");
}

function analyzeTX(key: string, sessions: Session[], title: string, emoji: string): string {
  // Dùng 100 phiên gần nhất cho hiển thị thống kê
  const display = sessions.slice(0, 100);
  // Tournament chạy trên tối đa 110 phiên để có đủ backtest
  const tournamentLabels = sessions.slice(0, 110).map(s => txLabel(s.rs));

  // ── Verify previous prediction ──
  verifyPred(key, sessions, s => txLabel(s.rs));

  const rows = display.map(s => ({
    label: txLabel(s.rs),
    sum:   s.rs.reduce((a, b) => a + b, 0),
    dice:  s.rs,
    id:    s.sessionId,
  }));

  const total  = rows.length;
  const tai    = rows.filter(r => r.label === "Tài").length;
  const xiu    = total - tai;
  const labels = rows.map(r => r.label);
  const cau    = analyzeCau(labels, { "Tài": "Xỉu", "Xỉu": "Tài" });

  // ── Store new prediction ──
  if (sessions[0]) storePred(key, sessions[0].sessionId, cau.predictedLabel, cau.probability);

  const pattern = rows.map(r => txEmoji(r.label)).join("");
  const recent  = rows.slice(0, 5).map(r =>
    `  <code>#${r.id}</code> [${r.dice.join("-")}]=${r.sum} → <b>${txEmoji(r.label)} ${r.label}</b>`
  ).join("\n");

  // Tournament AI
  const tour = runTournament(tournamentLabels, { "Tài": "Xỉu", "Xỉu": "Tài" });
  const tourSection = formatTournamentSection(tour, tour.prediction, txEmoji(tour.prediction));

  return [
    `${emoji} <b>${title} — Phân tích trực tiếp</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📊 <b>${total} phiên gần nhất:</b>`,
    pattern,
    ``,
    `📈 <b>Tỉ lệ thống kê (${total} phiên):</b>`,
    `🔴 Tài: <b>${tai}</b>/${total} (<b>${pct(tai,total)}</b>)  ${bar(tai,total)}`,
    `🔵 Xỉu: <b>${xiu}</b>/${total} (<b>${pct(xiu,total)}</b>)  ${bar(xiu,total)}`,
    ``,
    `🎯 <b>Phân tích cầu:</b>`,
    `  Kiểu cầu: <b>${cau.type}</b>`,
    `  Cầu hiện tại: <b>${txEmoji(cau.currentLabel)} ${cau.currentLabel} ×${cau.currentCount}</b>`,
    `  Cầu dài nhất: <b>${txEmoji(cau.longestLabel)} ${cau.longestLabel} ×${cau.longestCount}</b>`,
    ``,
    `📋 <b>5 phiên chi tiết:</b>`,
    recent,
    buildPatternPrediction(sessions),
    tourSection,
  ].join("\n");
}

// ─── Tài Xỉu MD5 — phân tích riêng có mã hash ───────────────────────────────

/**
 * Với mỗi phiên TXMD5:
 *  - _id   : MongoDB ObjectID (mã phiên gốc từ server)
 *  - rsKey : chuỗi dice "d1:d2:d3" → compute MD5 → "fingerprint" xác minh
 *
 * Phân tích MD5:
 *  - Ký tự CUỐI hash (0-f):  chẵn (0/2/4/6/8/a/c/e) → Chẵn | lẻ → Lẻ
 *  - Byte CUỐI (2 ký tự hex, 0-255): >127 → Tài | ≤127 → Xỉu
 *  - Tổng 32 ký tự hex (0-9→giá trị, a-f→10-15): >255 → Tài | ≤255 → Xỉu
 * Hiển thị 3 tín hiệu + pattern + pattern prediction 15 phiên trên dice.
 */

function md5LastChar(hash: string): { char: string; label: "Chẵn" | "Lẻ" } {
  const c = hash[hash.length - 1].toLowerCase();
  return { char: c, label: "02468ace".includes(c) ? "Chẵn" : "Lẻ" };
}

function md5LastByte(hash: string): { hex: string; val: number; label: "Tài" | "Xỉu" } {
  const hex = hash.slice(-2).toLowerCase();
  const val = parseInt(hex, 16);
  return { hex, val, label: val > 127 ? "Tài" : "Xỉu" };
}

function md5HexSum(hash: string): { sum: number; label: "Tài" | "Xỉu" } {
  const sum = hash.split("").reduce((s, c) => {
    const v = parseInt(c, 16);
    return s + (isNaN(v) ? 0 : v);
  }, 0);
  // Tổng max = 15*32=480; mid ~240; >240 → Tài
  return { sum, label: sum > 240 ? "Tài" : "Xỉu" };
}

function analyzeTXMD5(key: string, sessions: Session[]): string {
  verifyPred(key, sessions, s => txLabel(s.rs));

  const display = sessions.slice(0, 100);

  // ── Tính md5 fingerprint cho từng session ──────────────────────────────────
  type MD5Row = {
    id:       number;
    mongoId:  string;
    dice:     number[];
    sum:      number;
    diceLabel:"Tài" | "Xỉu";
    hash:     string;       // md5(sessionId:d1:d2:d3)
    lastChar: ReturnType<typeof md5LastChar>;
    lastByte: ReturnType<typeof md5LastByte>;
    hexSum:   ReturnType<typeof md5HexSum>;
  };

  const md5Rows: MD5Row[] = display.map(s => {
    const hash = md5hex(`${s.sessionId}:${s.rs.join(":")}`);
    return {
      id:       s.sessionId,
      mongoId:  s._id ?? "—",
      dice:     s.rs,
      sum:      s.rs.reduce((a, b) => a + b, 0),
      diceLabel:txLabel(s.rs),
      hash,
      lastChar: md5LastChar(hash),
      lastByte: md5LastByte(hash),
      hexSum:   md5HexSum(hash),
    };
  });

  // ── Tỉ lệ thống kê dice ────────────────────────────────────────────────────
  const total   = md5Rows.length;
  const tai     = md5Rows.filter(r => r.diceLabel === "Tài").length;
  const xiu     = total - tai;
  const diceLabels = md5Rows.map(r => r.diceLabel);
  const cau     = analyzeCau(diceLabels, { "Tài": "Xỉu", "Xỉu": "Tài" });
  if (sessions[0]) storePred(key, sessions[0].sessionId, cau.predictedLabel, cau.probability);

  // ── Tỉ lệ từng tín hiệu MD5 ──────────────────────────────────────────────
  const lbTai   = md5Rows.filter(r => r.lastByte.label  === "Tài").length;
  const lcChan  = md5Rows.filter(r => r.lastChar.label  === "Chẵn").length;
  const hsTai   = md5Rows.filter(r => r.hexSum.label    === "Tài").length;

  // ── Pattern chuỗi dice & byte cuối ────────────────────────────────────────
  const dicePattern = md5Rows.map(r => txEmoji(r.diceLabel)).join("");
  const bytePattern = md5Rows.map(r => txEmoji(r.lastByte.label)).join("");

  // ── Phiên chi tiết (5 gần nhất) ───────────────────────────────────────────
  const recent = md5Rows.slice(0, 5).map(r =>
    `  <code>#${r.id}</code>  [${r.dice.join("-")}]=${r.sum} ${txEmoji(r.diceLabel)}<b>${r.diceLabel}</b>\n` +
    `    🔑 Mã: <code>${r.mongoId}</code>\n` +
    `    #️⃣ MD5: <code>${r.hash}</code>\n` +
    `    └ Ký tự cuối: <b>${r.lastChar.char}</b> → ${r.lastChar.label}  |  Byte cuối: <b>0x${r.lastByte.hex}</b>=${r.lastByte.val} → ${txEmoji(r.lastByte.label)}<b>${r.lastByte.label}</b>  |  Tổng hex: <b>${r.hexSum.sum}</b> → ${txEmoji(r.hexSum.label)}<b>${r.hexSum.label}</b>`
  ).join("\n");

  // ── Biểu quyết 3 tín hiệu MD5 → dự đoán tổng hợp ─────────────────────────
  const latest  = md5Rows[0];
  const votes: Record<"Tài"|"Xỉu", number> = { "Tài": 0, "Xỉu": 0 };
  if (latest) {
    votes[cau.predictedLabel as "Tài"|"Xỉu"]  += 2; // cầu dice (trọng số cao hơn)
    votes[latest.lastByte.label]               += 1;
    votes[latest.hexSum.label]                 += 1;
  }
  const md5Vote    = votes["Tài"] >= votes["Xỉu"] ? "Tài" : "Xỉu";
  const md5VoteBar = `  🎲 Cầu dice → ${txEmoji(cau.predictedLabel)} <b>${cau.predictedLabel}</b> (×2)\n` +
                     `  🔵 Byte cuối → ${txEmoji(latest?.lastByte.label ?? "Xỉu")} <b>${latest?.lastByte.label ?? "—"}</b> (×1)\n` +
                     `  🔢 Tổng hex  → ${txEmoji(latest?.hexSum.label ?? "Xỉu")} <b>${latest?.hexSum.label ?? "—"}</b> (×1)`;

  return [
    `🔐 <b>Tài Xỉu MD5 — Phân tích trực tiếp</b>`,
    `<i>📡 Dữ liệu: api.s6688v.xyz · Fingerprint: MD5(sessionId:d1:d2:d3)</i>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📊 <b>${total} phiên gần nhất (xúc xắc):</b>`,
    dicePattern,
    ``,
    `📈 <b>Tỉ lệ xúc xắc (${total} phiên):</b>`,
    `🔴 Tài: <b>${tai}</b>/${total} (<b>${pct(tai,total)}</b>)  ${bar(tai,total)}`,
    `🔵 Xỉu: <b>${xiu}</b>/${total} (<b>${pct(xiu,total)}</b>)  ${bar(xiu,total)}`,
    ``,
    `🎯 <b>Phân tích cầu:</b>`,
    `  Kiểu cầu: <b>${cau.type}</b>`,
    `  Cầu hiện tại: <b>${txEmoji(cau.currentLabel)} ${cau.currentLabel} ×${cau.currentCount}</b>`,
    `  Cầu dài nhất: <b>${txEmoji(cau.longestLabel)} ${cau.longestLabel} ×${cau.longestCount}</b>`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `#️⃣ <b>PHÂN TÍCH MÃ MD5</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📊 <b>Pattern byte cuối (${total} phiên):</b>`,
    bytePattern,
    ``,
    `📈 <b>Tỉ lệ 3 tín hiệu MD5 (${total} phiên):</b>`,
    `🔵 Byte cuối >127 (Tài): <b>${lbTai}</b>/${total} (<b>${pct(lbTai,total)}</b>)  ${bar(lbTai,total)}`,
    `⚪ Ký tự cuối chẵn:      <b>${lcChan}</b>/${total} (<b>${pct(lcChan,total)}</b>)  ${bar(lcChan,total)}`,
    `🔢 Tổng hex >240 (Tài):  <b>${hsTai}</b>/${total} (<b>${pct(hsTai,total)}</b>)  ${bar(hsTai,total)}`,
    ``,
    `📋 <b>5 phiên chi tiết:</b>`,
    recent,
    ``,
    `🗳️ <b>Biểu quyết dự đoán (cầu + MD5):</b>`,
    md5VoteBar,
    ``,
    `🤖 <b>Kết luận:</b> ${txEmoji(md5Vote)} <b>${md5Vote}</b>  (${votes[md5Vote]}/4 phiếu)`,
    `🎯 <b>Độ tin cậy cầu:</b> ${cau.confidence}` + accLine(key),
    buildPatternPrediction(sessions),
    (() => {
      const t = runTournament(diceLabels, { "Tài": "Xỉu", "Xỉu": "Tài" });
      return formatTournamentSection(t, t.prediction, txEmoji(t.prediction));
    })(),
  ].join("\n");
}

// ─── Xóc Đĩa (removed) ───────────────────────────────────────────────────────

function xdLabel(rs: number[]): "Chẵn" | "Lẻ" {
  return rs.filter(v => v === 1).length % 2 === 0 ? "Chẵn" : "Lẻ";
}

function analyzeXD(key: string, sessions: Session[]): string {
  verifyPred(key, sessions, s => xdLabel(s.rs));

  const rows = sessions.map(s => ({
    label: xdLabel(s.rs),
    reds:  s.rs.filter(v => v === 1).length,
    coins: s.rs,
    id:    s.sessionId,
  }));

  const total = rows.length;
  const chan  = rows.filter(r => r.label === "Chẵn").length;
  const le    = total - chan;
  const cau   = analyzeCau(rows.map(r => r.label), { "Chẵn": "Lẻ", "Lẻ": "Chẵn" });

  if (sessions[0]) storePred(key, sessions[0].sessionId, cau.predictedLabel, cau.probability);

  const redDist: Record<number, number> = { 0:0, 1:0, 2:0, 3:0, 4:0 };
  for (const r of rows) redDist[r.reds] = (redDist[r.reds] ?? 0) + 1;
  const redDistStr = [0,1,2,3,4].map(k =>
    `${k}đỏ:<b>${redDist[k]}</b>x(${pct(redDist[k],total)})`
  ).join(" · ");

  const pattern = rows.slice(0, 20).map(r => r.label === "Chẵn" ? "⚪" : "🔴").join("");
  const recent  = rows.slice(0, 5).map(r => {
    const coins = r.coins.map(c => c ? "🔴" : "⚪").join("");
    return `  <code>#${r.id}</code> ${coins}(${r.reds}đỏ) → <b>${r.label}</b>`;
  }).join("\n");

  const xdEmoji = (l: string) => l === "Chẵn" ? "⚪" : "🔴";

  return [
    `🥣 <b>Xóc Đĩa — Phân tích trực tiếp</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📊 <b>20 phiên gần nhất:</b>`,
    pattern,
    ``,
    `📈 <b>Tỉ lệ thống kê (${total} phiên):</b>`,
    `⚪ Chẵn: <b>${chan}</b>/${total} (<b>${pct(chan,total)}</b>)  ${bar(chan,total)}`,
    `🔴 Lẻ:   <b>${le}</b>/${total} (<b>${pct(le,total)}</b>)  ${bar(le,total)}`,
    ``,
    `🎯 <b>Phân tích cầu:</b>`,
    `  Kiểu cầu: <b>${cau.type}</b>`,
    `  Cầu hiện tại: <b>${xdEmoji(cau.currentLabel)} ${cau.currentLabel} ×${cau.currentCount}</b>`,
    `  Cầu dài nhất: <b>${xdEmoji(cau.longestLabel)} ${cau.longestLabel} ×${cau.longestCount}</b>`,
    ``,
    `🔢 <b>Phân bố số đĩa đỏ (${total} phiên):</b>`,
    redDistStr,
    ``,
    `📋 <b>5 phiên chi tiết:</b>`,
    recent,
    ``,
    `🤖 <b>Bot dự đoán:</b> ${xdEmoji(cau.predictedLabel)} <b>${cau.prediction}</b>`,
    `🎯 <b>Độ tin cậy:</b> ${cau.confidence}` + accLine(key),
  ].join("\n");
}

// ─── Rồng Hổ ─────────────────────────────────────────────────────────────────

function lhLabel(rs: number[]): "Rồng" | "Hổ" | "Hòa" {
  if (rs[0] > rs[1]) return "Rồng";
  if (rs[0] < rs[1]) return "Hổ";
  return "Hòa";
}
function lhEmoji(l: string): string {
  return l === "Rồng" ? "🐉" : l === "Hổ" ? "🐅" : "🟡";
}

function analyzeLH(key: string, sessions: Session[]): string {
  // Verify only non-Hòa sessions
  verifyPred(key, sessions.filter(s => lhLabel(s.rs) !== "Hòa"), s => lhLabel(s.rs));

  const rows = sessions.map(s => ({
    label: lhLabel(s.rs),
    cards: s.rs,
    diff:  Math.abs(s.rs[0] - s.rs[1]),
    id:    s.sessionId,
  }));

  const total = rows.length;
  const rong  = rows.filter(r => r.label === "Rồng").length;
  const ho    = rows.filter(r => r.label === "Hổ").length;
  const hoa   = rows.filter(r => r.label === "Hòa").length;
  const base  = rong + ho || 1;

  const nonHoa = rows.filter(r => r.label !== "Hòa").map(r => r.label);
  const cau    = analyzeCau(nonHoa, { "Rồng": "Hổ", "Hổ": "Rồng" });

  if (sessions[0] && lhLabel(sessions[0].rs) !== "Hòa") {
    storePred(key, sessions[0].sessionId, cau.predictedLabel, cau.probability);
  }

  const avgMargin = rows.reduce((s, r) => s + r.diff, 0) / (rows.length || 1);
  const pattern   = rows.slice(0, 20).map(r => lhEmoji(r.label)).join("");
  const recent    = rows.slice(0, 5).map(r =>
    `  <code>#${r.id}</code> 🐉${r.cards[0]} vs 🐅${r.cards[1]} → <b>${lhEmoji(r.label)} ${r.label}</b>`
  ).join("\n");

  return [
    `🐉 <b>Rồng Hổ — Phân tích trực tiếp</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📊 <b>20 phiên gần nhất:</b>`,
    pattern,
    ``,
    `📈 <b>Tỉ lệ thống kê (${total} phiên):</b>`,
    `🐉 Rồng: <b>${rong}</b>/${total} (<b>${pct(rong,base)}</b> ngoại trừ hòa)  ${bar(rong,base)}`,
    `🐅 Hổ:   <b>${ho}</b>/${total} (<b>${pct(ho,base)}</b> ngoại trừ hòa)  ${bar(ho,base)}`,
    `🟡 Hòa:  <b>${hoa}</b>/${total} (<b>${pct(hoa,total)}</b>)`,
    ``,
    `🎯 <b>Phân tích cầu (bỏ hòa):</b>`,
    `  Kiểu cầu: <b>${cau.type}</b>`,
    `  Cầu hiện tại: <b>${lhEmoji(cau.currentLabel)} ${cau.currentLabel} ×${cau.currentCount}</b>`,
    `  Cầu dài nhất: <b>${lhEmoji(cau.longestLabel)} ${cau.longestLabel} ×${cau.longestCount}</b>`,
    `📏 Chênh lệch bài TB: <b>${avgMargin.toFixed(1)}</b> điểm`,
    ``,
    `📋 <b>5 phiên chi tiết:</b>`,
    recent,
    ``,
    `🤖 <b>Bot dự đoán:</b> ${lhEmoji(cau.predictedLabel)} <b>${cau.prediction}</b>`,
    `🎯 <b>Độ tin cậy:</b> ${cau.confidence}` + accLine(key),
    (() => {
      const t = runTournament(nonHoa, { "Rồng": "Hổ", "Hổ": "Rồng" });
      return formatTournamentSection(t, t.prediction, lhEmoji(t.prediction));
    })(),
  ].join("\n");
}

// ─── Bầu Cua (removed) ───────────────────────────────────────────────────────

function analyzeBC(_sessions: Session[]): string {
  return "❌ Game không còn được hỗ trợ.";
}


// ─── Sicbo (removed) ─────────────────────────────────────────────────────────

function analyzeSicboDetailed(_key: string, _sessions: Session[]): string {
  return "❌ Game không còn được hỗ trợ.";
}


// ─── dispatcher ──────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// PHÂN TÍCH XU HƯỚNG NÂNG CAO (Advanced Trend Analysis)
// Kết hợp 3 yếu tố có trọng số: Trend · Frequency · Reversal
// Ngưỡng an toàn: tổng điểm < 65 → SKIP (không dự đoán)
// ═══════════════════════════════════════════════════════════════════════════

/** Kết quả phân tích nâng cao trả về cho bot handler */
export interface AdvancedPrediction {
  action: string;          // 'BET' | 'SKIP'
  prediction: string;      // "Tài"/"Xỉu"/"Chẵn"/"Lẻ"/"Rồng"/"Hổ" hoặc "" khi SKIP
  confidence: number;      // Tổng điểm 0–100
  trendScore: number;      // Điểm xu hướng cầu   (0–40)
  freqScore: number;       // Điểm tần suất nóng/lạnh (0–35)
  revScore: number;        // Điểm xác suất gãy cầu   (0–25)
  reason: string;          // Giải thích ngắn gọn (hiển thị trong bot)
  indicators: string;      // Dòng chỉ báo chi tiết (rỗng khi SKIP)
  capitalAdvice: string;   // Khuyến nghị mức vốn (rỗng khi SKIP)
  counterN: number | null;              // 1-100 rồi reset — null nếu chưa có dữ liệu
  counterResult: "win" | "lose" | null; // kết quả dự đoán gần nhất đã xác minh
  /** Label thực của phiên MỚI NHẤT vừa về — dùng để bot edit message dự đoán trước */
  actualLabel: string | null;
  /** Session ID của phiên mới nhất vừa về */
  latestSessionId: number | null;
}

/** Ngưỡng điểm tối thiểu để phát tín hiệu BET (< 65 → SKIP) */
const CONFIDENCE_THRESHOLD = 65;

/** Tạo kết quả SKIP nhanh với lý do */
function skipResult(reason: string): AdvancedPrediction {
  return {
    action: "SKIP",
    prediction: "",
    confidence: 0,
    trendScore: 0,
    freqScore: 0,
    revScore: 0,
    reason,
    indicators: "",
    capitalAdvice: "",
    counterN: null,
    counterResult: null,
    actualLabel: null,
    latestSessionId: null,
  };
}

/**
 * Sinh lý do SKIP dựa trên điểm thành phần thấp nhất.
 * Giúp user hiểu tại sao hệ thống không dự đoán.
 */
function buildSkipReason(t: number, f: number, r: number): string {
  if (t < 14) return "Xu hướng cầu chưa rõ — Markov thấp, không đủ tín hiệu";
  if (f < 10) return "Tần suất mâu thuẫn xu hướng — dữ liệu 50 phiên bị nhiễu";
  if (r < 8)  return "Mẫu gãy cầu không nhất quán — biến động bất thường";
  return "Tổng điểm dưới ngưỡng 65 — chưa đủ độ tin cậy";
}

/**
 * BƯỚC 1 — TREND SCORE (0–40 điểm)
 * Phân tích kiểu cầu bệt/đảo thông qua:
 *   - Độ lệch Markov (ma trận chuyển trạng thái có trọng số thời gian)
 *   - Độ dài cầu hiện tại (currentCount)
 *   - Tỷ lệ xen kẽ 10 phiên (altRate)
 * Trả về label dự đoán và điểm thô.
 */
function calcTrendScore(
  labels: string[],
  opposites: Record<string, string>,
): { score: number; predictedLabel: string } {
  const allKeys = Object.keys(opposites);
  const currentLabel = labels[0];
  const other = opposites[currentLabel] ?? allKeys.find(k => k !== currentLabel) ?? currentLabel;

  // ── Streak hiện tại ──────────────────────────────────────────────────────
  let currentCount = 1;
  for (let i = 1; i < labels.length; i++) {
    if (labels[i] === currentLabel) currentCount++;
    else break;
  }

  // ── Tỷ lệ xen kẽ trong 10 phiên gần nhất ────────────────────────────────
  const slice10 = labels.slice(0, Math.min(10, labels.length));
  let altCount = 0;
  for (let i = 0; i < slice10.length - 1; i++) {
    if (slice10[i] !== slice10[i + 1]) altCount++;
  }
  const altRate = slice10.length > 1 ? altCount / (slice10.length - 1) : 0;

  // ── Ma trận Markov có trọng số: 30 phiên gần × 3 + toàn bộ × 1 ──────────
  // Trọng số thời gian: phiên gần hơn ảnh hưởng nhiều hơn
  const trans: Record<string, Record<string, number>> = {};
  for (const k of allKeys) { trans[k] = {}; for (const k2 of allKeys) trans[k][k2] = 0; }

  // Cộng toàn bộ lịch sử với trọng số 1
  for (let i = 0; i < labels.length - 1; i++) {
    const from = labels[i + 1]; // trạng thái cũ
    const to   = labels[i];     // trạng thái kế tiếp (mới hơn)
    if (trans[from]) trans[from][to] = (trans[from][to] ?? 0) + 1;
  }
  // Cộng thêm 30 phiên gần nhất với trọng số ×3 (nhấn mạnh xu hướng ngắn hạn)
  const recent30 = labels.slice(0, Math.min(30, labels.length));
  for (let i = 0; i < recent30.length - 1; i++) {
    const from = recent30[i + 1];
    const to   = recent30[i];
    if (trans[from]) trans[from][to] = (trans[from][to] ?? 0) + 3;
  }

  // Xác suất Markov từ trạng thái hiện tại
  const fromRow  = trans[currentLabel] ?? {};
  const rowTotal = Object.values(fromRow).reduce((s, v) => s + v, 0);
  let markovLabel = currentLabel;
  let markovProb  = 50;
  if (rowTotal > 0) {
    const pStay   = ((fromRow[currentLabel] ?? 0) / rowTotal) * 100;
    const pSwitch = ((fromRow[other] ?? 0) / rowTotal) * 100;
    markovLabel = pSwitch > pStay ? other : currentLabel;
    markovProb  = Math.max(pStay, pSwitch);
  }

  // ── Quyết định label dự đoán cuối: kết hợp Markov + quy tắc cầu ─────────
  let predLabel = markovLabel;
  if (currentCount >= 7) predLabel = other;        // Cầu cực dài → đảo mạnh
  else if (currentCount >= 5) predLabel = other;   // Cầu dài → nghiêng về đảo
  else if (altRate >= 0.8) predLabel = other;      // Xen kẽ rất mạnh → switch

  // ── Tính điểm Trend ───────────────────────────────────────────────────────
  // Độ lệch Markov khỏi 50% (tối đa 30 điểm đóng góp từ Markov)
  const markovStrength = Math.min(markovProb - 50, 30);
  // Bonus cầu dài (tín hiệu đảo mạnh)
  const streakBonus = currentCount >= 7 ? 10 : currentCount >= 5 ? 7 : currentCount >= 3 ? 3 : 0;
  // Bonus xen kẽ mạnh
  const altBonus = altRate >= 0.8 ? 6 : altRate >= 0.65 ? 3 : 0;

  const score = Math.min(40, Math.max(0, Math.round(8 + markovStrength * 0.85 + streakBonus + altBonus)));
  return { score, predictedLabel: predLabel };
}

/**
 * BƯỚC 2 — FREQUENCY SCORE (0–35 điểm)
 * Tính tỷ lệ nóng/lạnh của label dự đoán trong 50 phiên gần nhất.
 * Nếu label dự đoán đang "nóng" → điểm cao (xu hướng được tần suất ủng hộ).
 * Nếu đang "lạnh" → điểm thấp (tần suất phản đối xu hướng).
 * Nếu lệch > 25% → giảm 15% (có thể là nhiễu thống kê do sample nhỏ).
 */
function calcFrequencyScore(
  labels: string[],
  predLabel: string,
): { score: number; predFreqPct: number } {
  const freq50 = labels.slice(0, Math.min(50, labels.length));
  const freq50Total = freq50.length;

  // Đếm tần suất từng label trong 50 phiên
  const freqCount: Record<string, number> = {};
  for (const l of freq50) freqCount[l] = (freqCount[l] ?? 0) + 1;

  // Tỷ lệ label được dự đoán so với 50% trung lập
  const predFreqPct = freq50Total > 0 ? (freqCount[predLabel] ?? 0) / freq50Total : 0.5;
  const deviation = predFreqPct - 0.5; // dương: nóng, âm: lạnh

  let score: number;
  if (deviation >= 0) {
    // Label dự đoán đang "nóng" — tần suất ủng hộ xu hướng
    score = 15 + deviation * 80;
  } else {
    // Label dự đoán đang "lạnh" — tần suất ngược xu hướng (phạt nhẹ)
    score = 15 + deviation * 55;
  }

  // Giảm 15% khi lệch > 25%: sample nhỏ có thể gây nhiễu thống kê
  if (Math.abs(deviation) > 0.25) score *= 0.85;

  return { score: Math.min(35, Math.max(0, Math.round(score))), predFreqPct };
}

/**
 * BƯỚC 3 — REVERSAL SCORE (0–25 điểm)
 * Tính xác suất gãy cầu tại độ dài cầu hiện tại dựa trên lịch sử thực tế.
 *
 * Xây dựng bảng: streakLength → { cont: số lần tiếp cầu, broke: số lần gãy cầu }
 * Scan theo thứ tự CHRONOLOGICAL (oldest → newest) để đảm bảo đúng chiều thời gian.
 * P(gãy | streak = k) = broke[k] / (cont[k] + broke[k])
 *
 * Nếu dự đoán là "đảo cầu": reversalScore = P(gãy) × 25
 * Nếu dự đoán là "theo cầu": reversalScore = (1 - P(gãy)) × 25
 */
function calcReversalScore(
  labels: string[],
  predLabel: string,
  currentLabel: string,
  currentCount: number,
): { score: number; pBreak: number } {
  // Đảo mảng: labels[0]=newest → chronological[0]=oldest
  const chrono = [...labels].reverse();

  const breakTable: Record<number, { cont: number; broke: number }> = {};
  let streak = 1;

  for (let i = 1; i < chrono.length; i++) {
    const prev = chrono[i - 1];
    const curr = chrono[i];

    // Ghi nhận kết quả tại streak_length = streak
    if (!breakTable[streak]) breakTable[streak] = { cont: 0, broke: 0 };

    if (curr === prev) {
      // Cầu tiếp tục
      breakTable[streak].cont++;
      streak++;
    } else {
      // Cầu gãy tại độ dài này
      breakTable[streak].broke++;
      streak = 1; // reset
    }
  }

  // Tính P(gãy | streak = currentCount) từ dữ liệu lịch sử
  let pBreak = 0.5; // prior mặc định nếu không đủ data

  const exact = breakTable[currentCount];
  if (exact && (exact.cont + exact.broke) >= 3) {
    // Đủ mẫu tại đúng độ dài cầu hiện tại
    pBreak = exact.broke / (exact.cont + exact.broke);
  } else {
    // Fallback: gộp tất cả streak có độ dài >= currentCount
    const longerKeys = Object.keys(breakTable).map(Number).filter(k => k >= currentCount);
    const agg = longerKeys.reduce(
      (acc, k) => ({ cont: acc.cont + breakTable[k].cont, broke: acc.broke + breakTable[k].broke }),
      { cont: 0, broke: 0 },
    );
    if (agg.cont + agg.broke >= 3) {
      pBreak = agg.broke / (agg.cont + agg.broke);
    }
  }

  // Tính điểm: dự đoán đảo hợp lý khi pBreak cao; theo cầu hợp lý khi pBreak thấp
  const predictingReversal = predLabel !== currentLabel;
  const score = predictingReversal
    ? Math.round(pBreak * 25)
    : Math.round((1 - pBreak) * 25);

  return { score: Math.min(25, Math.max(0, score)), pBreak };
}

/**
 * Hàm chính: phân tích xu hướng nâng cao với lọc nhiễu và đánh trọng số 3 chiều.
 *
 * @param labels  Mảng label kết quả, newest-first (index 0 = phiên mới nhất)
 * @param opposites  Map đối nghịch: {"Tài":"Xỉu","Xỉu":"Tài"} v.v.
 * @returns AdvancedPrediction — action BET hoặc SKIP
 */
export function analyzeAdvancedTrend(
  labels: string[],
  opposites: Record<string, string>,
): AdvancedPrediction {
  // === Kiểm tra dữ liệu đầu vào ============================================
  if (!labels.length || labels.length < 10) {
    return skipResult("Không đủ dữ liệu (cần ≥ 10 phiên)");
  }

  const currentLabel = labels[0];

  // Đếm cầu hiện tại
  let currentCount = 1;
  for (let i = 1; i < labels.length; i++) {
    if (labels[i] === currentLabel) currentCount++;
    else break;
  }

  // === Tính 3 thành phần điểm ==============================================
  const { score: trendScore, predictedLabel } = calcTrendScore(labels, opposites);
  const { score: freqScore, predFreqPct }     = calcFrequencyScore(labels, predictedLabel);
  const { score: reversalScore, pBreak }       = calcReversalScore(labels, predictedLabel, currentLabel, currentCount);

  const totalScore = trendScore + freqScore + reversalScore;

  // === Kiểm tra ngưỡng an toàn =============================================
  if (totalScore < CONFIDENCE_THRESHOLD) {
    return {
      action: "SKIP",
      prediction: "",
      confidence: totalScore,
      trendScore,
      freqScore,
      revScore: reversalScore,
      reason: buildSkipReason(trendScore, freqScore, reversalScore),
      indicators: "",
      capitalAdvice: "",
    };
  }

  // === Xây dựng lý do và chỉ báo ==========================================
  const predictingReversal = predictedLabel !== currentLabel;
  const streakDesc = currentCount >= 5 ? `cầu dài ×${currentCount}` : `streak ×${currentCount}`;
  const freqPctStr = (predFreqPct * 100).toFixed(0);
  const freqDesc = predFreqPct > 0.53
    ? `tần suất nóng (${freqPctStr}%/50p)`
    : predFreqPct < 0.47
    ? `đối kháng tần suất lạnh`
    : `tần suất cân bằng`;
  const reversalDesc = `P(gãy|${streakDesc}) = ${(pBreak * 100).toFixed(0)}%`;

  const reason = `Tín hiệu rõ ràng`;
  const indicators = `${predictingReversal ? "Đảo cầu" : "Theo cầu"} · ${freqDesc} · ${reversalDesc}`;

  // === Khuyến nghị vốn theo mức độ tin cậy =================================
  // Giới hạn tối đa 30% bankroll — game ngẫu nhiên, quản lý vốn ưu tiên
  const capitalAdvice = totalScore >= 85
    ? "Vốn lớn (Đánh tự tin)"
    : totalScore >= 75
    ? "Vốn vừa (15–20% bankroll)"
    : "Vốn nhỏ (5–10% bankroll)";

  return {
    action: "BET",
    prediction: predictedLabel,
    confidence: totalScore,
    trendScore,
    freqScore,
    revScore: reversalScore,
    reason,
    indicators,
    capitalAdvice,
    counterN: null,       // sẽ được điền bởi fetchAndBuildAdvanced sau verifyPrediction
    counterResult: null,
  };
}

/**
 * Lấy session, extract labels theo từng loại game, rồi gọi analyzeAdvancedTrend.
 * Dùng session cache 30s — không double-fetch khi gọi song song với analyzeGame.
 *
 * Tích hợp analytics:
 *  1. Trước khi tính dự đoán mới: gọi verifyPrediction(key, actualLabel) với label
 *     của phiên MỚI NHẤT vừa fetch → xác minh dự đoán trước đó đúng/sai.
 *  2. Sau khi tính xong BET: gọi logPrediction() để lưu vào DB.
 *  Cả hai đều fire-and-forget, không ảnh hưởng tốc độ bot.
 */
export async function fetchAndBuildAdvanced(key: string): Promise<AdvancedPrediction> {
  // Import analytics lazily — tránh circular dependency và giữ module nhẹ
  const { logPrediction, verifyPrediction } = await import("./analytics");

  try {
    // Import analytics (lazy, tránh circular dependency)
    const { getAdvancedCounter } = await import("./analytics");

    // ── Xúc Xắc: đọc từ nhóm Telegram riêng ──────────────────────────────
    if (key === "xucxac") {
      const { fetchXucXacSessions } = await import("./xucxac");
      // Lấy 110 phiên để tournament có đủ 100 phiên backtest
      const xucSessions = await fetchXucXacSessions(110);
      if (xucSessions.length < 10) return skipResult("Không đủ dữ liệu Xúc Xắc");

      const xucTyped = xucSessions as Array<{ sessionId: number; label: string }>;
      const xucActualLabel = xucTyped[0]?.label ?? null;
      const xucLatestId    = xucTyped[0]?.sessionId ?? null;

      // Bước 1: xác minh dự đoán trước
      if (xucActualLabel) {
        await verifyPrediction(key, xucActualLabel).catch(() => {});
      }

      const labels = xucTyped.map(s => s.label);

      // Tournament: chọn chiến lược tốt nhất qua backtest 10→100 phiên
      const tour = runTournament(labels, { "Tài": "Xỉu", "Xỉu": "Tài" });

      // Dùng kết quả tournament làm primary prediction
      const result: AdvancedPrediction = tour.action === "BET"
        ? {
            action: "BET",
            prediction: tour.prediction,
            confidence: tour.confidence,
            trendScore: tour.confidence,
            freqScore: 0,
            revScore: 0,
            reason: `Tournament champion: ${tour.champion} (${(tour.accuracy * 100).toFixed(1)}% thực tế · ${tour.testedSessions}p backtest)`,
            indicators: `${tour.champion} thắng qua ${tour.roundsRun} vòng loại`,
            capitalAdvice: tour.accuracy >= 0.65 ? "Vốn vừa (15–20% bankroll)" : "Vốn nhỏ (5–10% bankroll)",
            counterN: null, counterResult: null,
            actualLabel: xucActualLabel,
            latestSessionId: xucLatestId,
          }
        : {
            ...skipResult("Tournament chưa tìm ra chiến lược đủ tin cậy"),
            actualLabel: xucActualLabel,
            latestSessionId: xucLatestId,
          };

      // Bước 2: ghi dự đoán nếu BET
      if (result.action === "BET" && xucTyped[0]) {
        logPrediction({
          gameKey: key, sessionId: xucTyped[0].sessionId,
          action: "BET", predictedLabel: result.prediction,
          confidence: result.confidence,
          trendScore: result.trendScore, freqScore: result.freqScore, revScore: result.revScore,
        }).catch(() => {});
      }

      const ctr = getAdvancedCounter(key);
      return { ...result, counterN: ctr?.n ?? null, counterResult: ctr?.lastResult ?? null };
    }

    // ── Các game API web ──────────────────────────────────────────────────
    const url = GAME_APIS[key];
    if (!url) return skipResult("Game không hỗ trợ phân tích nâng cao");

    // Lấy 110 phiên: 100 để hiển thị + 10 buffer cho tournament
    const sessions = await fetchSessionsCached(url, key);
    if (sessions.length < 10) return skipResult("Không đủ dữ liệu (cần ≥ 10 phiên)");

    let labels: string[];
    let opposites: Record<string, string>;
    let actualLabel: string | null = null;

    switch (key) {
      case "taixiu":
      case "taixiumd5":
        labels      = sessions.map(s => txLabel(s.rs));
        opposites   = { "Tài": "Xỉu", "Xỉu": "Tài" };
        actualLabel = txLabel(sessions[0].rs);
        break;

      case "rongho":
        labels      = sessions.map(s => lhLabel(s.rs)).filter(l => l !== "Hòa");
        opposites   = { "Rồng": "Hổ", "Hổ": "Rồng" };
        actualLabel = lhLabel(sessions[0].rs) === "Hòa" ? null : lhLabel(sessions[0].rs);
        break;

      default:
        return skipResult("Game chưa hỗ trợ phân tích xu hướng");
    }

    // Xác minh dự đoán kỳ trước
    if (actualLabel) {
      await verifyPrediction(key, actualLabel).catch(() => {});
    }

    if (labels.length < 10) return skipResult("Không đủ phiên hợp lệ sau khi lọc");

    // Tournament: chọn chiến lược tốt nhất
    const tour = runTournament(labels, opposites);

    // Nếu tournament không đủ tin cậy → fallback sang analyzeAdvancedTrend
    let result: AdvancedPrediction;
    if (tour.action === "BET") {
      result = {
        action: "BET",
        prediction: tour.prediction,
        confidence: tour.confidence,
        trendScore: tour.confidence,
        freqScore: 0,
        revScore: 0,
        reason: `Tournament champion: ${tour.champion} (${(tour.accuracy * 100).toFixed(1)}% thực tế · ${tour.testedSessions}p backtest)`,
        indicators: `${tour.champion} thắng qua ${tour.roundsRun} vòng loại`,
        capitalAdvice: tour.accuracy >= 0.65 ? "Vốn vừa (15–20% bankroll)" : "Vốn nhỏ (5–10% bankroll)",
        counterN: null, counterResult: null,
        actualLabel: actualLabel ?? null,
        latestSessionId: sessions[0]?.sessionId ?? null,
      };
    } else {
      // Fallback: dùng thuật toán cổ điển
      result = {
        ...analyzeAdvancedTrend(labels, opposites),
        actualLabel: actualLabel ?? null,
        latestSessionId: sessions[0]?.sessionId ?? null,
      };
    }

    // Ghi dự đoán mới nếu BET
    if (result.action === "BET" && sessions[0]) {
      logPrediction({
        gameKey: key, sessionId: sessions[0].sessionId,
        action: "BET", predictedLabel: result.prediction,
        confidence: result.confidence,
        trendScore: result.trendScore, freqScore: result.freqScore, revScore: result.revScore,
      }).catch(() => {});
    }

    const ctr = getAdvancedCounter(key);
    return {
      ...result,
      counterN: ctr?.n ?? null,
      counterResult: ctr?.lastResult ?? null,
    };

  } catch (err: any) {
    // Không bao giờ throw ra ngoài — bot không được crash
    return skipResult(`Lỗi phân tích: ${err?.message ?? "unknown"}`);
  }
}

// ─── dispatcher ──────────────────────────────────────────────────────────────

export async function analyzeGame(key: string): Promise<string> {
  const meta = GAME_META[key];
  if (!meta) return "❌ Game không tồn tại";

  // ── Xúc Xắc: đọc từ kênh Telegram ──────────────────────────────────────────
  if (key === "xucxac") {
    try {
      const { fetchXucXacSessions, buildXucXacAnalysis } = await import("./xucxac");
      const sessions = await fetchXucXacSessions(100);
      if (!sessions.length) return "❌ Không lấy được dữ liệu từ kênh Telegram. Kiểm tra lại kết nối MTProto.";
      return buildXucXacAnalysis(sessions);
    } catch (err: any) {
      if (err?.message === "no_session") {
        return (
          `🔐 <b>Chưa đăng nhập MTProto</b>\n━━━━━━━━━━━━━━━━━\n` +
          `Game Xúc Xắc đọc dữ liệu trực tiếp từ kênh Telegram.\n\n` +
          `⚠️ Admin cần nhấn <b>🔐 Đăng nhập</b> để kết nối tài khoản Telegram trước.`
        );
      }
      return `❌ Lỗi đọc Telegram: ${err?.message ?? "unknown"}`;
    }
  }

  // ── Các game khác: đọc từ API web ──────────────────────────────────────────
  const url = GAME_APIS[key];
  if (!url) return "❌ Game chưa hỗ trợ phân tích.";

  try {
    // Dùng cache để tránh double-fetch khi gọi song song với fetchAndBuildAdvanced
    const sessions = await fetchSessionsCached(url, key);
    if (!sessions.length) return "❌ Không có dữ liệu từ server.";

    switch (key) {
      case "taixiu":
        return analyzeTX(key, sessions, meta.title, meta.emoji);
      case "taixiumd5":
        return analyzeTXMD5(key, sessions);
      case "rongho":
        return analyzeLH(key, sessions);
      default:
        return "❌ Game chưa hỗ trợ phân tích.";
    }
  } catch (err: any) {
    return `❌ Lỗi kết nối: ${err?.message ?? "unknown"}`;
  }
}
