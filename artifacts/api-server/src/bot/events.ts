/**
 * Quản lý khung giờ sự kiện ngẫu nhiên mỗi ngày.
 * - Sự kiện 1 (nạp +10%): 2 khung 10 phút/ngày, random mỗi ngày
 * - Sự kiện 3 (giảm giá key 15%): 2 khung 10 phút/ngày, random riêng
 */

export interface TimeWindow {
  start: Date;
  end: Date;
  label: string; // "HH:MM - HH:MM"
}

export interface DailySlots {
  slot1: TimeWindow;
  slot2: TimeWindow;
}

// ─── LCG random seeded by integer ───────────────────────────────────────────
function lcgFrac(seed: number): number {
  return ((seed * 1664525 + 1013904223) >>> 0) / 4294967296;
}

// ─── Ngày hiện tại theo múi giờ VN (UTC+7) ──────────────────────────────────
function getVNDateSeed(): number {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return vn.getUTCFullYear() * 10000 + (vn.getUTCMonth() + 1) * 100 + vn.getUTCDate();
}

// Phút 0 = 00:00 VN. Chuyển về UTC Date
function vnMinutesToDate(minutesSinceMidnightVN: number): Date {
  const now = new Date();
  const vnMidnightUTC = new Date(now.getTime() + 7 * 3600_000);
  vnMidnightUTC.setUTCHours(0, 0, 0, 0);
  const utcMidnight = new Date(vnMidnightUTC.getTime() - 7 * 3600_000);
  return new Date(utcMidnight.getTime() + minutesSinceMidnightVN * 60_000);
}

function fmtMin(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/**
 * Sinh 2 khung giờ ngẫu nhiên cho một ngày.
 * @param eventSalt  Số phân biệt giữa các sự kiện (event 1 dùng khác event 3)
 */
export function getDailySlots(eventSalt: number): DailySlots {
  const dateSeed = getVNDateSeed();

  // Nửa đầu: 08:00 – 14:50  → offset 480–890, range 410
  const r1 = lcgFrac(dateSeed * 31 + eventSalt);
  const s1 = 480 + Math.floor(r1 * 410);

  // Nửa sau: 15:00 – 21:50  → offset 900–1310, range 410
  const r2 = lcgFrac(dateSeed * 31 + eventSalt + 999);
  const s2 = 900 + Math.floor(r2 * 410);

  return {
    slot1: { start: vnMinutesToDate(s1), end: vnMinutesToDate(s1 + 10), label: `${fmtMin(s1)} – ${fmtMin(s1 + 10)}` },
    slot2: { start: vnMinutesToDate(s2), end: vnMinutesToDate(s2 + 10), label: `${fmtMin(s2)} – ${fmtMin(s2 + 10)}` },
  };
}

function inWindow(now: Date, w: TimeWindow): boolean {
  return now >= w.start && now <= w.end;
}

// Event 1 — nạp +10%
const EV1_SALT = 1001;
// Event 3 — giảm giá key 15%
const EV3_SALT = 3003;

export const DEPOSIT_BONUS_PCT = 10;
export const KEY_DISCOUNT_PCT = 15;

export function getEvent1Slots(): DailySlots { return getDailySlots(EV1_SALT); }
export function getEvent3Slots(): DailySlots { return getDailySlots(EV3_SALT); }

export function isDepositBonusActive(): boolean {
  const now = new Date();
  const { slot1, slot2 } = getEvent1Slots();
  return inWindow(now, slot1) || inWindow(now, slot2);
}

export function isKeyDiscountActive(): boolean {
  const now = new Date();
  const { slot1, slot2 } = getEvent3Slots();
  return inWindow(now, slot1) || inWindow(now, slot2);
}
