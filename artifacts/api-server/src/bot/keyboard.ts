import { Markup } from "telegraf";

export const ADMIN_IDS = new Set([6030019812, 7929223065]);

export function isAdmin(telegramId: number): boolean {
  return ADMIN_IDS.has(telegramId);
}

/** Main menu — admins get extra buttons others cannot see */
export function getMainMenuKeyboard(telegramId: number) {
  const rows: string[][] = [
    ["👤 Xem hồ sơ", "🎮 Game"],
    ["💳 Nạp tiền", "🔑 Nhập key"],
    ["🛒 Mua key", "🎉 Sự kiện"],
    ["🆘 Hỗ trợ"],
  ];
  if (ADMIN_IDS.has(telegramId)) {
    rows.push(["🔐 Đăng nhập", "🏦 Ngân hàng"]);
  }
  return Markup.keyboard(rows).resize().persistent();
}

// Keep for backwards-compat in places where no telegramId is available
export const mainMenuKeyboard = Markup.keyboard([
  ["👤 Xem hồ sơ", "🎮 Game"],
  ["💳 Nạp tiền", "🔑 Nhập key"],
  ["🛒 Mua key", "🎉 Sự kiện"],
  ["🆘 Hỗ trợ"],
])
  .resize()
  .persistent();

export const profileKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback("📥 Lịch sử nạp", "hist_deposit"),
    Markup.button.callback("🛒 Lịch sử mua key", "hist_buy"),
  ],
  [Markup.button.callback("🔑 Lịch sử sử dụng key", "hist_keys")],
]);

export const gameMenuKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback("🎲 Tài Xỉu", "game_taixiu"),
    Markup.button.callback("🔐 Tài Xỉu MD5", "game_taixiumd5"),
  ],
  [
    Markup.button.callback("🐉 Rồng Hổ", "game_rongho"),
    Markup.button.callback("🎲 Xúc Xắc", "game_xucxac"),
  ],
  [Markup.button.callback("◀️ Quay lại", "back_main")],
]);

export const depositKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback("💵 50,000 VND", "deposit_50000"),
    Markup.button.callback("💵 100,000 VND", "deposit_100000"),
  ],
  [
    Markup.button.callback("💵 200,000 VND", "deposit_200000"),
    Markup.button.callback("💵 500,000 VND", "deposit_500000"),
  ],
  [Markup.button.callback("✏️ Tự nhập số tiền", "deposit_custom")],
  [Markup.button.callback("◀️ Quay lại", "back_main")],
]);

export const supportKeyboard = Markup.inlineKeyboard([
  [Markup.button.url("💬 Chat với Admin", "https://t.me/Haru88_Admin")],
  [Markup.button.callback("◀️ Quay lại", "back_main")],
]);
