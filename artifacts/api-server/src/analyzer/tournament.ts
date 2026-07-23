/**
 * tournament.ts — Tournament-style meta-learning AI agent
 *
 * 8 chiến lược dự đoán cùng thi đấu song song trên cửa sổ 10→100 phiên.
 * Vòng loại tại các mốc: 10, 20, 30, 50, 75, 100 phiên.
 * Chiến lược thắng cuối cùng → dự đoán thực tế.
 *
 * Cũng cung cấp DiceFaceTournament cho Xúc Xắc:
 *   3 tournament độc lập cho từng con xúc xắc (XX1/XX2/XX3) → dự đoán mặt 1–6.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StrategyStats {
  name: string;
  wins: number;
  losses: number;
  accuracy: number; // 0–1
  eliminated: boolean;
  eliminatedAtSession: number | null;
}

export interface TournamentResult {
  champion: string;          // tên chiến lược thắng
  prediction: string;        // dự đoán của champion
  accuracy: number;          // accuracy 0–1 của champion
  confidence: number;        // 0–100 mapped từ accuracy
  testedSessions: number;    // số phiên đã backtest
  roundsRun: number;         // số vòng loại đã chạy
  rankings: StrategyStats[]; // tất cả chiến lược xếp hạng
  action: "BET" | "SKIP";   // BET nếu champion accuracy >= 0.55
}

export interface DiceFaceTournamentResult {
  diePos: 0 | 1 | 2;        // vị trí xúc xắc
  champion: string;
  predictedFace: number;     // 1–6
  accuracy: number;
  testedSessions: number;
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

/** Đếm tần suất các phần tử trong mảng */
function countFreq<T>(arr: T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

/** Phần tử xuất hiện nhiều nhất */
function mostFrequent<T>(arr: T[]): T | null {
  if (!arr.length) return null;
  const freq = countFreq(arr);
  let best: T = arr[0];
  let max = 0;
  for (const [k, v] of freq) if (v > max) { max = v; best = k; }
  return best;
}

/** Phần tử xuất hiện ít nhất */
function leastFrequent<T>(arr: T[]): T | null {
  if (!arr.length) return null;
  const freq = countFreq(arr);
  let best: T = arr[0];
  let min = Infinity;
  for (const [k, v] of freq) if (v < min) { min = v; best = k; }
  return best;
}

// ─── 8 Chiến lược dự đoán nhị phân ───────────────────────────────────────────

type BinaryPredictor = (history: string[], opposites: Record<string, string>) => string;

/** Weighted Markov (ma trận chuyển trạng thái × gần nhất ×3) */
const stratWeightedMarkov: BinaryPredictor = (history, opposites) => {
  if (history.length < 5) return history[0] ?? Object.keys(opposites)[0];
  const allKeys = Object.keys(opposites);
  const trans: Record<string, Record<string, number>> = {};
  for (const k of allKeys) { trans[k] = {}; for (const k2 of allKeys) trans[k][k2] = 0; }

  // Toàn bộ lịch sử (trọng số ×1)
  for (let i = 0; i < history.length - 1; i++) {
    const from = history[i + 1]; const to = history[i];
    if (trans[from]) trans[from][to] = (trans[from][to] ?? 0) + 1;
  }
  // 30 phiên gần nhất (trọng số ×3)
  const r30 = history.slice(0, Math.min(30, history.length));
  for (let i = 0; i < r30.length - 1; i++) {
    const from = r30[i + 1]; const to = r30[i];
    if (trans[from]) trans[from][to] = (trans[from][to] ?? 0) + 3;
  }

  const cur = history[0];
  const other = opposites[cur] ?? allKeys.find(k => k !== cur) ?? cur;
  const row = trans[cur] ?? {};
  const total = Object.values(row).reduce((s, v) => s + v, 0);
  if (total === 0) return cur;
  const pSwitch = (row[other] ?? 0) / total;
  return pSwitch > 0.5 ? other : cur;
};

/** Pure 1st-order Markov (không trọng số thời gian) */
const stratPureMarkov: BinaryPredictor = (history, opposites) => {
  if (history.length < 5) return history[0] ?? Object.keys(opposites)[0];
  const allKeys = Object.keys(opposites);
  const trans: Record<string, Record<string, number>> = {};
  for (const k of allKeys) { trans[k] = {}; for (const k2 of allKeys) trans[k][k2] = 0; }
  for (let i = 0; i < history.length - 1; i++) {
    const from = history[i + 1]; const to = history[i];
    if (trans[from]) trans[from][to] = (trans[from][to] ?? 0) + 1;
  }
  const cur = history[0];
  const other = opposites[cur] ?? allKeys.find(k => k !== cur) ?? cur;
  const row = trans[cur] ?? {};
  const total = Object.values(row).reduce((s, v) => s + v, 0);
  if (total === 0) return cur;
  return (row[other] ?? 0) > (row[cur] ?? 0) ? other : cur;
};

/** Anti-streak: cầu >= 3 → đảo ngược */
const stratAntiStreak: BinaryPredictor = (history, opposites) => {
  const cur = history[0];
  const other = opposites[cur] ?? Object.keys(opposites).find(k => k !== cur) ?? cur;
  let count = 1;
  for (let i = 1; i < history.length; i++) {
    if (history[i] === cur) count++; else break;
  }
  return count >= 3 ? other : cur;
};

/** Follow-streak: luôn theo cầu hiện tại */
const stratFollowStreak: BinaryPredictor = (history) => history[0];

/** Alt detector: nếu 10 phiên xen kẽ > 70% → đảo, ngược lại theo */
const stratAltDetector: BinaryPredictor = (history, opposites) => {
  const cur = history[0];
  const other = opposites[cur] ?? Object.keys(opposites).find(k => k !== cur) ?? cur;
  const s10 = history.slice(0, Math.min(10, history.length));
  let alt = 0;
  for (let i = 0; i < s10.length - 1; i++) if (s10[i] !== s10[i + 1]) alt++;
  const altRate = (s10.length - 1) > 0 ? alt / (s10.length - 1) : 0;
  return altRate >= 0.7 ? other : cur;
};

/** Frequency hot: label xuất hiện nhiều nhất trong 50 phiên */
const stratFrequencyHot: BinaryPredictor = (history) => {
  const s50 = history.slice(0, Math.min(50, history.length));
  return mostFrequent(s50) ?? history[0];
};

/** Anti-frequency: label xuất hiện ÍT nhất trong 50 phiên (hồi quy về trung bình) */
const stratAntiFrequency: BinaryPredictor = (history, opposites) => {
  const cur = history[0];
  const s50 = history.slice(0, Math.min(50, history.length));
  const least = leastFrequent(s50);
  if (!least) return opposites[cur] ?? cur;
  return least;
};

/** Recent majority: kết quả chiếm đa số trong 7 phiên gần nhất */
const stratRecentMajority: BinaryPredictor = (history) => {
  const s7 = history.slice(0, Math.min(7, history.length));
  return mostFrequent(s7) ?? history[0];
};

// ─── Danh sách chiến lược ─────────────────────────────────────────────────────

const STRATEGIES: Array<{ name: string; fn: BinaryPredictor }> = [
  { name: "WeightedMarkov",  fn: stratWeightedMarkov  },
  { name: "PureMarkov",      fn: stratPureMarkov      },
  { name: "AntiStreak",      fn: stratAntiStreak      },
  { name: "FollowStreak",    fn: stratFollowStreak    },
  { name: "AltDetector",     fn: stratAltDetector     },
  { name: "FrequencyHot",    fn: stratFrequencyHot    },
  { name: "AntiFrequency",   fn: stratAntiFrequency   },
  { name: "RecentMajority",  fn: stratRecentMajority  },
];

// ─── Vòng loại tournament ─────────────────────────────────────────────────────

/** Ngưỡng loại & số chiến lược giữ lại sau mỗi vòng */
const ELIMINATION_ROUNDS: Array<{ atSession: number; keepTop: number }> = [
  { atSession: 10, keepTop: 6 },
  { atSession: 20, keepTop: 5 },
  { atSession: 30, keepTop: 4 },
  { atSession: 50, keepTop: 3 },
  { atSession: 75, keepTop: 2 },
  { atSession: 100, keepTop: 1 },
];

function sortByAccuracy(names: string[], stats: Map<string, { w: number; l: number }>): string[] {
  return [...names].sort((a, b) => {
    const sa = stats.get(a)!; const sb = stats.get(b)!;
    const ra = sa.w / (sa.w + sa.l || 1);
    const rb = sb.w / (sb.w + sb.l || 1);
    if (rb !== ra) return rb - ra;
    return (sb.w + sb.l) - (sa.w + sa.l); // tiebreak: ai test nhiều hơn
  });
}

// ─── runTournament ────────────────────────────────────────────────────────────

/**
 * Chạy tournament với mảng label theo thứ tự newest-first.
 * Backtest từ phiên 10 đến min(100, total-10).
 * Trả về champion + prediction cho phiên kế tiếp.
 */
export function runTournament(
  labels: string[],          // newest-first
  opposites: Record<string, string>,
): TournamentResult {
  const fallback = (): TournamentResult => ({
    champion: "WeightedMarkov",
    prediction: labels[0] ?? Object.keys(opposites)[0],
    accuracy: 0.5,
    confidence: 50,
    testedSessions: 0,
    roundsRun: 0,
    rankings: [],
    action: "SKIP",
  });

  // Cần ít nhất 25 phiên để có ý nghĩa (15 history + 10 test)
  if (labels.length < 25) return fallback();

  // Đổi sang chronological (oldest first) để backtest
  const chrono = [...labels].reverse();
  const testableEnd = Math.min(chrono.length - 1, 110); // tối đa 100 phiên test

  // Khởi tạo stats
  const stats = new Map<string, { w: number; l: number; elim: boolean; elimAt: number | null }>();
  for (const s of STRATEGIES) stats.set(s.name, { w: 0, l: 0, elim: false, elimAt: null });

  let activeNames = STRATEGIES.map(s => s.name);
  let roundIdx = 0;
  let tested = 0;

  // Backtest: bắt đầu từ index 10 (cần ít nhất 10 phiên lịch sử)
  for (let i = 10; i < testableEnd; i++) {
    // history = chrono[0..i-1] → reversed lại → newest-first cho predictor
    const histChron = chrono.slice(0, i);
    const histNewest = [...histChron].reverse();
    const actual = chrono[i];

    for (const name of activeNames) {
      const s = STRATEGIES.find(x => x.name === name)!;
      const pred = s.fn(histNewest, opposites);
      const st = stats.get(name)!;
      if (pred === actual) st.w++; else st.l++;
    }

    tested++;

    // Kiểm tra vòng loại
    if (
      roundIdx < ELIMINATION_ROUNDS.length &&
      tested >= ELIMINATION_ROUNDS[roundIdx].atSession
    ) {
      const keepN = ELIMINATION_ROUNDS[roundIdx].keepTop;
      const sorted = sortByAccuracy(activeNames, stats as Map<string, {w:number;l:number}>);
      // Loại bỏ kẻ đứng sau keepN
      for (let k = keepN; k < sorted.length; k++) {
        const st = stats.get(sorted[k])!;
        st.elim = true;
        st.elimAt = tested;
      }
      activeNames = sorted.slice(0, keepN);
      roundIdx++;
    }
  }

  if (!activeNames.length) return fallback();

  // Champion = top 1 trong danh sách còn lại
  const ranked = sortByAccuracy(activeNames, stats as Map<string, {w:number;l:number}>);
  const champName = ranked[0];
  const champFn = STRATEGIES.find(s => s.name === champName)!.fn;

  // Dự đoán thực tế: champion dự đoán dựa trên toàn bộ dữ liệu hiện có
  const champPrediction = champFn(labels, opposites);

  const champSt = stats.get(champName)!;
  const champAcc = champSt.w / (champSt.w + champSt.l || 1);
  const confidence = Math.round(champAcc * 100);

  // Rankings cho tất cả
  const rankings: StrategyStats[] = STRATEGIES.map(({ name }) => {
    const st = stats.get(name)!;
    const total = st.w + st.l;
    return {
      name,
      wins: st.w,
      losses: st.l,
      accuracy: total > 0 ? st.w / total : 0,
      eliminated: st.elim,
      eliminatedAtSession: st.elimAt,
    };
  }).sort((a, b) => b.accuracy - a.accuracy);

  return {
    champion: champName,
    prediction: champPrediction,
    accuracy: champAcc,
    confidence,
    testedSessions: tested,
    roundsRun: roundIdx,
    rankings,
    action: champAcc >= 0.55 ? "BET" : "SKIP",
  };
}

// ─── Format section cho Telegram ─────────────────────────────────────────────

const MEDAL = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣"];
const STRATEGY_EMOJI: Record<string, string> = {
  WeightedMarkov: "🧮",
  PureMarkov:     "📊",
  AntiStreak:     "🔄",
  FollowStreak:   "➡️",
  AltDetector:    "↔️",
  FrequencyHot:   "🔥",
  AntiFrequency:  "❄️",
  RecentMajority: "📈",
};

export function formatTournamentSection(
  result: TournamentResult,
  predictionLabel: string,
  predictionEmoji: string,
): string {
  if (!result.rankings.length) return "";

  const top3 = result.rankings.slice(0, 3);
  const rankLines = top3.map((r, i) => {
    const acc = `${(r.accuracy * 100).toFixed(1)}%`;
    const wl  = `${r.wins}/${r.wins + r.losses}`;
    const emoji = STRATEGY_EMOJI[r.name] ?? "🤖";
    return `${MEDAL[i]} ${emoji} <b>${r.name}</b>  <b>${acc}</b>  (${wl})`;
  });

  // Đếm bị loại
  const eliminated = result.rankings.filter(r => r.eliminated).length;

  return [
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🏆 <b>AI TOURNAMENT — CHIẾN LƯỢC TỐT NHẤT</b>`,
    `<i>8 chiến lược thi đấu · ${result.testedSessions} phiên backtest · ${result.roundsRun} vòng loại · loại ${eliminated} kẻ thua</i>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ...rankLines,
    ``,
    `🤖 <b>Champion:</b> ${STRATEGY_EMOJI[result.champion] ?? "🤖"} <b>${result.champion}</b>`,
    `🎯 <b>Dự đoán:</b> ${predictionEmoji} <b>${predictionLabel}</b>`,
    `📊 <b>Độ chính xác thực tế:</b> <b>${(result.accuracy * 100).toFixed(1)}%</b>  ${result.action === "BET" ? "✅ ĐỦ ĐỘ TIN CẬY" : "⚠️ CHƯA ĐỦ — CÂN NHẮC THÊM"}`,
  ].join("\n");
}

// ─── Dice face tournament (Xúc Xắc exact) ────────────────────────────────────

/** Predict mặt xúc xắc 1–6 dựa trên lịch sử một vị trí cụ thể */
type FacePredictor = (faceHistory: number[]) => number; // newest-first, returns 1–6

/** Hot face: mặt ra nhiều nhất trong 30 phiên */
const facePredHot: FacePredictor = (h) => {
  const s = h.slice(0, Math.min(30, h.length));
  return mostFrequent(s) ?? h[0];
};

/** Cold face: mặt ra ÍT nhất trong 30 phiên (hồi quy về trung bình) */
const facePredCold: FacePredictor = (h) => {
  const s = h.slice(0, Math.min(30, h.length));
  return leastFrequent(s) ?? h[0];
};

/** Markov face: 1st-order Markov cho 6 trạng thái */
const facePredMarkov: FacePredictor = (h) => {
  if (h.length < 5) return h[0];
  const trans: Record<number, Record<number, number>> = {};
  for (let f = 1; f <= 6; f++) { trans[f] = {}; for (let g = 1; g <= 6; g++) trans[f][g] = 0; }
  for (let i = 0; i < h.length - 1; i++) {
    const from = h[i + 1]; const to = h[i];
    if (trans[from]) trans[from][to] = (trans[from][to] ?? 0) + 1;
  }
  const cur = h[0];
  const row = trans[cur] ?? {};
  let bestFace = cur, bestCnt = -1;
  for (let f = 1; f <= 6; f++) {
    if ((row[f] ?? 0) > bestCnt) { bestCnt = row[f] ?? 0; bestFace = f; }
  }
  return bestFace;
};

/** Pattern face: tìm giá trị cur trong 50 phiên, predict giá trị TRƯỚC phiên đó */
const facePredPattern: FacePredictor = (h) => {
  if (h.length < 3) return h[0];
  const cur = h[0];
  const hist = h.slice(1, Math.min(51, h.length));
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] === cur && i + 1 < hist.length) return hist[i + 1];
  }
  return h[0];
};

const FACE_STRATEGIES: Array<{ name: string; fn: FacePredictor }> = [
  { name: "HotFace",     fn: facePredHot     },
  { name: "ColdFace",    fn: facePredCold    },
  { name: "MarkovFace",  fn: facePredMarkov  },
  { name: "PatternFace", fn: facePredPattern },
];

/**
 * Chạy tournament cho một vị trí xúc xắc (0/1/2).
 * @param faceHistory mảng giá trị mặt xúc xắc (1–6), newest-first
 */
export function runDiceFaceTournament(
  faceHistory: number[],
  diePos: 0 | 1 | 2,
): DiceFaceTournamentResult {
  const fallback = (): DiceFaceTournamentResult => ({
    diePos, champion: "HotFace",
    predictedFace: faceHistory[0] ?? 1,
    accuracy: 1 / 6,
    testedSessions: 0,
  });

  if (faceHistory.length < 20) return fallback();

  const chrono = [...faceHistory].reverse();
  const testableEnd = Math.min(chrono.length - 1, 110);

  const stats = new Map<string, { w: number; l: number }>();
  for (const s of FACE_STRATEGIES) stats.set(s.name, { w: 0, l: 0 });

  let activeNames = FACE_STRATEGIES.map(s => s.name);
  let tested = 0;

  // Backtest
  for (let i = 10; i < testableEnd; i++) {
    const histNewest = chrono.slice(0, i).reverse();
    const actual = chrono[i];

    for (const name of activeNames) {
      const s = FACE_STRATEGIES.find(x => x.name === name)!;
      const pred = s.fn(histNewest);
      const st = stats.get(name)!;
      if (pred === actual) st.w++; else st.l++;
    }

    tested++;

    // Vòng loại đơn giản hơn (4 chiến lược, 2 vòng)
    if (tested === 30) {
      const sorted = [...activeNames].sort((a, b) => {
        const sa = stats.get(a)!; const sb = stats.get(b)!;
        return (sb.w / (sb.w + sb.l || 1)) - (sa.w / (sa.w + sa.l || 1));
      });
      activeNames = sorted.slice(0, 3); // loại 1 kẻ thua
    }
    if (tested === 70) {
      const sorted = [...activeNames].sort((a, b) => {
        const sa = stats.get(a)!; const sb = stats.get(b)!;
        return (sb.w / (sb.w + sb.l || 1)) - (sa.w / (sa.w + sa.l || 1));
      });
      activeNames = sorted.slice(0, 2); // loại thêm 1
    }
  }

  if (!activeNames.length) return fallback();

  // Champion
  const champion = activeNames.sort((a, b) => {
    const sa = stats.get(a)!; const sb = stats.get(b)!;
    return (sb.w / (sb.w + sb.l || 1)) - (sa.w / (sa.w + sa.l || 1));
  })[0];

  const champFn = FACE_STRATEGIES.find(s => s.name === champion)!.fn;
  const predictedFace = champFn(faceHistory);
  const st = stats.get(champion)!;
  const accuracy = st.w / (st.w + st.l || 1);

  return { diePos, champion, predictedFace, accuracy, testedSessions: tested };
}

/**
 * Chạy 3 face tournament (XX1/XX2/XX3) cùng lúc.
 * @param sessions XucXacSession[], newest-first
 */
export function runAllDiceTournaments(
  sessions: Array<{ dice: [number, number, number] }>,
): [DiceFaceTournamentResult, DiceFaceTournamentResult, DiceFaceTournamentResult] {
  const faceHist = (pos: 0 | 1 | 2): number[] => sessions.map(s => s.dice[pos]);
  return [
    runDiceFaceTournament(faceHist(0), 0),
    runDiceFaceTournament(faceHist(1), 1),
    runDiceFaceTournament(faceHist(2), 2),
  ];
}

/**
 * Format phần dự đoán mặt xúc xắc theo tournament cho Telegram.
 */
export function formatDiceFaceTournamentSection(
  results: [DiceFaceTournamentResult, DiceFaceTournamentResult, DiceFaceTournamentResult],
): string {
  const DICE_ICON = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
  const FACE_STRAT_EMOJI: Record<string, string> = {
    HotFace: "🔥", ColdFace: "❄️", MarkovFace: "🧮", PatternFace: "🔬",
  };

  const lines: string[] = [
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🎲 <b>DỰ ĐOÁN MẶT XÚC XẮC — AI TOURNAMENT</b>`,
    `<i>4 chiến lược thi đấu · 2 vòng loại · tìm mặt chính xác nhất</i>`,
    `━━━━━━━━━━━━━━━━━━━━`,
  ];

  const diceValues: number[] = [];
  for (const r of results) {
    const f = r.predictedFace;
    diceValues.push(f);
    const icon = DICE_ICON[f] ?? String(f);
    const strEmoji = FACE_STRAT_EMOJI[r.champion] ?? "🤖";
    const accStr = `${(r.accuracy * 100).toFixed(1)}%`;
    lines.push(
      `  XX${r.diePos + 1}: ${icon} <b>Mặt ${f}</b>  —  Champion: ${strEmoji} ${r.champion}  (<b>${accStr}</b> thực tế · ${r.testedSessions} phiên test)`,
    );
  }

  const total = diceValues.reduce((a, b) => a + b, 0);
  const txLabel = total >= 11 ? "Tài" : "Xỉu";
  const txEmoji = total >= 11 ? "🔵" : "🔴";

  lines.push(
    ``,
    `🎯 <b>Tổng dự đoán:</b> [${diceValues.join("-")}] = <b>${total}</b>  →  ${txEmoji} <b>${txLabel}</b>`,
  );

  return lines.join("\n");
}
