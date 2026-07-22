/**
 * VietQR Generator — tạo QR code chuẩn VietQR cho tất cả app ngân hàng VN
 * API public của vietqr.io, không cần API key.
 */

const VIETQR_BASE = "https://img.vietqr.io/image";

/**
 * Tạo URL ảnh QR VietQR cho MB Bank.
 * Tất cả app ngân hàng VN (MoMo, ZaloPay, VietinBank, MB...) đều quét được.
 */
export function buildVietQRUrl(
  accountNumber: string,
  accountName: string,
  amount: number,
  content: string,
): string {
  const params = new URLSearchParams({
    amount: String(amount),
    addInfo: content,
    accountName: accountName,
  });
  return `${VIETQR_BASE}/MB-${accountNumber}-compact2.jpg?${params.toString()}`;
}

/**
 * Fetch ảnh QR từ VietQR API và trả về Buffer (dùng để gửi qua Telegram).
 * Timeout 12 giây.
 */
export async function fetchVietQRImage(
  accountNumber: string,
  accountName: string,
  amount: number,
  content: string,
): Promise<Buffer> {
  const url = buildVietQRUrl(accountNumber, accountName, amount, content);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`VietQR API trả về ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}
