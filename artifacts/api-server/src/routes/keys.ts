import { Router } from "express";
import { db, keysTable } from "@workspace/db";
import { desc, count } from "drizzle-orm";
import { getProductById } from "../bot/products";

const router = Router();

// ─── Auth middleware ──────────────────────────────────────────────────────────
const ADMIN_PASSWORD = "19112007vV";

function requireAdmin(req: any, res: any, next: any) {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!token || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const TIER_CODE: Record<number, string> = {
  1: "TEST",
  2: "PHOT",
  3: "VIPX",
  4: "SVIP",
  5: "SSVP",
  6: "SSSV",
};

function rand4(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

function generateKeyCode(productId: number): string {
  const tier = TIER_CODE[productId] ?? "HARU";
  return `HARU-${tier}-${rand4()}-${rand4()}`;
}

// ─── POST /api/keys/generate ──────────────────────────────────────────────────
router.post("/generate", requireAdmin, async (req, res) => {
  try {
    const { productId, count: cnt } = req.body as { productId?: number; count?: number };

    if (!productId || typeof productId !== "number") {
      return res.status(400).json({ success: false, message: "productId là số nguyên bắt buộc." });
    }
    const product = getProductById(productId);
    if (!product) {
      return res.status(400).json({ success: false, message: "Sản phẩm không tồn tại." });
    }
    const total = Math.max(1, Math.min(100, cnt ?? 1));

    const generated: string[] = [];
    for (let i = 0; i < total; i++) {
      let keyCode = generateKeyCode(productId);
      for (let attempt = 0; attempt < 5; attempt++) {
        const [existing] = await db.select().from(keysTable).where(
          (await import("drizzle-orm")).eq(keysTable.keyCode, keyCode)
        );
        if (!existing) break;
        keyCode = generateKeyCode(productId);
      }
      generated.push(keyCode);
    }

    await db.insert(keysTable).values(
      generated.map((keyCode) => ({ keyCode, productId, isUsed: false }))
    );

    return res.json({ success: true, keys: generated, message: null });
  } catch (err: any) {
    console.error("generate keys error:", err);
    return res.status(500).json({ success: false, message: "Lỗi server khi tạo key. Kiểm tra database." });
  }
});

// ─── GET /api/keys ────────────────────────────────────────────────────────────
router.get("/", requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query["page"] ?? "1")));
  const limit = Math.max(1, Math.min(100, parseInt(String(req.query["limit"] ?? "20"))));
  const offset = (page - 1) * limit;

  const [rows, [{ value: totalVal }]] = await Promise.all([
    db.select().from(keysTable).orderBy(desc(keysTable.createdAt)).limit(limit).offset(offset),
    db.select({ value: count() }).from(keysTable),
  ]);

  const keys = rows.map((k) => ({
    keyCode: k.keyCode,
    productId: k.productId,
    isUsed: k.isUsed,
    usedByTelegramId: k.usedByTelegramId ?? null,
    usedAt: k.usedAt?.toISOString() ?? null,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    createdAt: (k as any).createdAt?.toISOString() ?? null,
  }));

  return res.json({ keys, total: Number(totalVal) });
});

export default router;
