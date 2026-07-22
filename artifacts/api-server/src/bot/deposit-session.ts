/**
 * DepositSession — quản lý phiên nạp tiền có thời hạn 8 phút.
 *
 * Mỗi phiên:
 *   - Mã duy nhất: HARU88-XXXXXXXX (8 ký tự ngẫu nhiên)
 *   - Gắn với 1 user (telegramId) và 1 số tiền
 *   - Hết hạn sau 8 phút → bot tự edit/xoá tin nhắn QR
 *   - Khi DepositMonitor phát hiện giao dịch khớp mã → consume session → cộng tiền
 */

export const SESSION_TTL_MS = 8 * 60 * 1000; // 8 phút

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface DepositSession {
  code: string;
  telegramId: number;
  amount: number;
  chatId: number;
  /** message_id của tin nhắn QR — dùng để edit khi hết hạn */
  messageId: number;
  /** true nếu tin nhắn là photo (QR), false nếu là text (fallback) */
  isPhoto: boolean;
  timer: NodeJS.Timeout;
  expiresAt: Date;
}

// code → session
const sessionsByCode = new Map<string, DepositSession>();
// telegramId → code (mỗi user chỉ 1 phiên active)
const sessionByUser = new Map<number, string>();

/** Sinh mã HARU88XXXXXXXX (không có dấu gạch) */
export function generateDepositCode(): string {
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return `HARU88${suffix}`;
}

/** Lấy phiên theo mã (null nếu không tồn tại hoặc đã hết hạn) */
export function getDepositSession(code: string): DepositSession | null {
  const s = sessionsByCode.get(code.toUpperCase());
  if (!s) return null;
  if (Date.now() > s.expiresAt.getTime()) {
    _remove(s);
    return null;
  }
  return s;
}

/** Huỷ phiên active của user (nếu có) */
export function cancelUserSession(telegramId: number): DepositSession | null {
  const code = sessionByUser.get(telegramId);
  if (!code) return null;
  const s = sessionsByCode.get(code) ?? null;
  if (s) { clearTimeout(s.timer); _remove(s); }
  return s;
}

/**
 * Tạo & lưu phiên mới cho user.
 * Phiên cũ của cùng user bị huỷ tự động.
 * @param onExpire callback gọi khi hết 8 phút (edit/xoá tin nhắn QR)
 */
export function createDepositSession(
  code: string,
  telegramId: number,
  amount: number,
  chatId: number,
  messageId: number,
  isPhoto: boolean,
  onExpire: () => Promise<void>,
): DepositSession {
  cancelUserSession(telegramId);

  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const timer = setTimeout(async () => {
    _remove({ code, telegramId } as DepositSession);
    await onExpire();
  }, SESSION_TTL_MS);

  const session: DepositSession = {
    code,
    telegramId,
    amount,
    chatId,
    messageId,
    isPhoto,
    timer,
    expiresAt,
  };

  sessionsByCode.set(code, session);
  sessionByUser.set(telegramId, code);
  return session;
}

/**
 * Consume phiên (dùng 1 lần khi DepositMonitor xác nhận giao dịch).
 * Xoá khỏi map và tắt timer.
 */
export function consumeDepositSession(code: string): DepositSession | null {
  const s = getDepositSession(code);
  if (!s) return null;
  clearTimeout(s.timer);
  _remove(s);
  return s;
}

function _remove(s: Pick<DepositSession, "code" | "telegramId">): void {
  sessionsByCode.delete(s.code);
  if (sessionByUser.get(s.telegramId) === s.code) {
    sessionByUser.delete(s.telegramId);
  }
}

/** Số phiên đang active (dùng cho debug) */
export function activeSessionCount(): number { return sessionsByCode.size; }
