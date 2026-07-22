import { eq, and, gt, desc } from "drizzle-orm";
import { db, usersTable, keysTable, transactionsTable } from "@workspace/db";
import { PRODUCTS, getActiveProducts, getProductById, type KeyProduct } from "./products";

// Re-export type so index.ts can import it from here
export type { KeyProduct };

/** Cộng số dư cho user, ghi log transaction */
export async function addBalance(telegramId: number, amount: number, description: string, referenceId?: string) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId));
  if (!user) return;
  const newBalance = parseFloat(user.balance as string) + amount;
  await db.update(usersTable).set({ balance: String(newBalance) }).where(eq(usersTable.telegramId, telegramId));
  await db.insert(transactionsTable).values({
    telegramId,
    type: "deposit",
    amount: String(amount),
    description,
    status: "completed",
    referenceId,
  });
}

/** Xử lý referral: cộng 1,000 VND cho người giới thiệu nếu user mới chưa có referrer */
export async function processReferral(newUserId: number, referrerId: number): Promise<boolean> {
  if (newUserId === referrerId) return false;
  const [newUser] = await db.select().from(usersTable).where(eq(usersTable.telegramId, newUserId));
  if (!newUser || newUser.referredBy !== null) return false;

  const [referrer] = await db.select().from(usersTable).where(eq(usersTable.telegramId, referrerId));
  if (!referrer) return false;

  await db.update(usersTable).set({ referredBy: referrerId }).where(eq(usersTable.telegramId, newUserId));
  await addBalance(referrerId, 1000, `Thưởng giới thiệu: @user${newUserId}`, String(newUserId));
  return true;
}

export async function getOrCreateUser(telegramId: number, username?: string, firstName?: string, lastName?: string) {
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId));

  if (existing) return existing;

  const [created] = await db
    .insert(usersTable)
    .values({ telegramId, username, firstName, lastName })
    .returning();

  return created;
}

export async function getUser(telegramId: number) {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId));
  return user ?? null;
}

export async function getUserTransactions(telegramId: number, limit = 5) {
  return db
    .select()
    .from(transactionsTable)
    .where(eq(transactionsTable.telegramId, telegramId))
    .orderBy(desc(transactionsTable.createdAt))
    .limit(limit);
}

// ── Keys còn hạn của user ─────────────────────────────────────────────────────

export async function getUserActiveKeys(telegramId: number) {
  const now = new Date();
  const rows = await db
    .select()
    .from(keysTable)
    .where(
      and(
        eq(keysTable.usedByTelegramId, String(telegramId)),
        eq(keysTable.isUsed, true),
        gt(keysTable.expiresAt, now),
      ),
    )
    .orderBy(desc(keysTable.expiresAt));

  // Gắn product từ danh sách hardcode
  return rows.map((key) => ({
    key,
    product: getProductById(key.productId) ?? PRODUCTS[0],
  }));
}

// ── Lịch sử nạp tiền ─────────────────────────────────────────────────────────

export async function getDepositHistory(telegramId: number, limit = 10) {
  return db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.telegramId, telegramId),
        eq(transactionsTable.type, "deposit"),
      ),
    )
    .orderBy(desc(transactionsTable.createdAt))
    .limit(limit);
}

// ── Lịch sử mua key ──────────────────────────────────────────────────────────

export async function getBuyKeyHistory(telegramId: number, limit = 10) {
  return db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.telegramId, telegramId),
        eq(transactionsTable.type, "buy_key"),
      ),
    )
    .orderBy(desc(transactionsTable.createdAt))
    .limit(limit);
}

// ── Lịch sử tất cả key của user (kể cả hết hạn) ─────────────────────────────

export async function getKeyUsageHistory(telegramId: number, limit = 10) {
  const rows = await db
    .select()
    .from(keysTable)
    .where(eq(keysTable.usedByTelegramId, String(telegramId)))
    .orderBy(desc(keysTable.usedAt))
    .limit(limit);

  return rows.map((key) => ({
    key,
    product: getProductById(key.productId) ?? PRODUCTS[0],
  }));
}

// ── Danh sách gói key — lấy từ hardcode, KHÔNG query DB ─────────────────────

export async function getActiveKeyProducts(): Promise<KeyProduct[]> {
  return getActiveProducts();
}

// ── Kích hoạt key người dùng nhập ────────────────────────────────────────────

export async function activateKey(keyCode: string, telegramId: number) {
  const [key] = await db
    .select()
    .from(keysTable)
    .where(eq(keysTable.keyCode, keyCode.trim().toUpperCase()));

  if (!key) return { success: false, reason: "Không tìm thấy key này." };
  if (key.isUsed) return { success: false, reason: "Key này đã được sử dụng rồi." };

  // Lấy product từ hardcode
  const product = getProductById(key.productId);
  const durationDays = product?.durationDays ?? 30;

  const now = new Date();

  // Kiểm tra user có key cùng loại đang còn hạn không → cộng dồn thời gian
  const [existingKey] = await db
    .select()
    .from(keysTable)
    .where(
      and(
        eq(keysTable.usedByTelegramId, String(telegramId)),
        eq(keysTable.isUsed, true),
        eq(keysTable.productId, key.productId),
        gt(keysTable.expiresAt, now),
      ),
    )
    .orderBy(desc(keysTable.expiresAt))
    .limit(1);

  let expiresAt: Date;
  let stacked = false;
  let oldExpiry: Date | null = null;

  if (existingKey?.expiresAt) {
    // Cộng dồn: tính từ ngày hết hạn hiện tại
    oldExpiry = new Date(existingKey.expiresAt as Date);
    expiresAt = new Date(existingKey.expiresAt as Date);
    expiresAt.setDate(expiresAt.getDate() + durationDays);
    stacked = true;
  } else {
    expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + durationDays);
  }

  await db
    .update(keysTable)
    .set({ isUsed: true, usedByTelegramId: String(telegramId), usedAt: now, expiresAt })
    .where(eq(keysTable.keyCode, keyCode.trim().toUpperCase()));

  await db.insert(transactionsTable).values({
    telegramId,
    type: "use_key",
    amount: "0",
    description: `Kích hoạt key${stacked ? " (cộng dồn)" : ""}: ${keyCode.trim().toUpperCase()}`,
    status: "completed",
    referenceId: keyCode.trim().toUpperCase(),
  });

  return { success: true, product, expiresAt, stacked, oldExpiry };
}

// ── Sinh key code ─────────────────────────────────────────────────────────────

const TIER_CODE: Record<string, string> = {
  "Key Test":      "TEST",
  "Key Phổ Thông": "PHOT",
  "Key VIP":       "VIPX",
  "Key SVIP":      "SVIP",
  "Key SSVIP":     "SSVP",
  "Key SSSVIP":    "SSSV",
};

function rand4(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

function generateKeyCode(productName: string): string {
  const tier = TIER_CODE[productName] ?? "HARU";
  return `HARU-${tier}-${rand4()}-${rand4()}`;
}

// ── Mua key ───────────────────────────────────────────────────────────────────

/**
 * @param finalPrice  Giá thực tế tính tiền (undefined = dùng giá gốc). Dùng khi có discount.
 */
export async function buyKey(telegramId: number, productId: number, finalPrice?: number) {
  const user = await getUser(telegramId);
  if (!user) return { success: false, reason: "Người dùng không tồn tại." };

  // Lấy product từ hardcode — KHÔNG query DB
  const product = getProductById(productId);
  if (!product) return { success: false, reason: "Sản phẩm không tồn tại hoặc đã ngừng bán." };

  const userBalance = parseFloat(user.balance as string);
  const chargePrice = finalPrice ?? product.price;

  if (userBalance < chargePrice) {
    return {
      success: false,
      reason: `Số dư không đủ. Bạn cần thêm ${(chargePrice - userBalance).toLocaleString("vi-VN")} VND.`,
    };
  }

  // Tạo key code duy nhất, thử lại nếu trùng
  let keyCode = generateKeyCode(product.name);
  let attempts = 0;
  while (attempts < 5) {
    const [existing] = await db.select().from(keysTable).where(eq(keysTable.keyCode, keyCode));
    if (!existing) break;
    keyCode = generateKeyCode(product.name);
    attempts++;
  }

  // Trừ số dư
  await db
    .update(usersTable)
    .set({ balance: String(userBalance - chargePrice) })
    .where(eq(usersTable.telegramId, telegramId));

  // Ghi key vào DB (productId tham chiếu ID hardcode 1-6)
  // isUsed = false — user cần nhập key thủ công để kích hoạt
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setDate(expiresAt.getDate() + product.durationDays);

  const [newKey] = await db
    .insert(keysTable)
    .values({ keyCode, productId: product.id, isUsed: false })
    .returning();

  const discounted = finalPrice !== undefined && finalPrice < product.price;
  await db.insert(transactionsTable).values({
    telegramId,
    type: "buy_key",
    amount: String(-chargePrice),
    description: `Mua key: ${product.name}${discounted ? " (giảm giá 15%)" : ""}`,
    status: "completed",
    referenceId: keyCode,
  });

  return { success: true, key: newKey, product, chargePrice };
}
