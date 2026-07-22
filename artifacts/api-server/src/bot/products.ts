/** ──────────────────────────────────────────────────────────────────────────
 *  Danh sách gói key — hardcode trực tiếp vào code, KHÔNG lưu vào database.
 *  Để thêm / sửa / xoá gói, chỉ cần chỉnh file này rồi restart bot.
 * ─────────────────────────────────────────────────────────────────────────── */

export interface KeyProduct {
  id: number;
  name: string;
  description: string;
  game: string;
  price: number;          // VND
  durationDays: number;
  isActive: boolean;
}

export const PRODUCTS: KeyProduct[] = [
  {
    id: 1,
    name: "Key Test",
    description: "✅ Tất cả game",
    game: "all",
    price: 10_000,
    durationDays: 1,
    isActive: true,
  },
  {
    id: 2,
    name: "Key Phổ Thông",
    description: "✅ Tất cả game",
    game: "all",
    price: 50_000,
    durationDays: 7,
    isActive: true,
  },
  {
    id: 3,
    name: "Key VIP",
    description: "✅ Tất cả game",
    game: "all",
    price: 145_000,
    durationDays: 30,
    isActive: true,
  },
  {
    id: 4,
    name: "Key SVIP",
    description: "✅ Tất cả game",
    game: "all",
    price: 599_000,
    durationDays: 180,
    isActive: true,
  },
  {
    id: 5,
    name: "Key SSVIP",
    description: "✅ Tất cả game",
    game: "all",
    price: 799_000,
    durationDays: 365,
    isActive: true,
  },
  {
    id: 6,
    name: "Key SSSVIP",
    description: "✅ Tất cả game",
    game: "all",
    price: 999_000,
    durationDays: 540,
    isActive: true,
  },
];

/** Lấy product theo id — trả về undefined nếu không tìm thấy */
export function getProductById(id: number): KeyProduct | undefined {
  return PRODUCTS.find((p) => p.id === id && p.isActive);
}

/** Lấy tất cả gói đang active */
export function getActiveProducts(): KeyProduct[] {
  return PRODUCTS.filter((p) => p.isActive);
}
