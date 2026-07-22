import { Router } from "express";
import { fetchXucXacSessions, resetXucXacState } from "../analyzer/xucxac";
import { invalidateSessionCache } from "../analyzer/games";

const router = Router();

const ADMIN_PASSWORD = "19112007vV";

function requireAdmin(req: any, res: any, next: any) {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!token || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

/**
 * POST /api/games/xucxac/refresh
 * Xoá state in-memory + cache, tải lại 100 phiên mới từ Telegram.
 */
router.post("/xucxac/refresh", requireAdmin, async (_req, res) => {
  try {
    // 1. Reset bộ đếm cầu về trạng thái ban đầu
    resetXucXacState();

    // 2. Xoá session cache để force fetch mới
    invalidateSessionCache("xucxac");

    // 3. Fetch 100 phiên mới từ Telegram
    const sessions = await fetchXucXacSessions(100);

    return res.json({
      success: true,
      count: sessions.length,
      message: `Đã tải ${sessions.length} phiên mới.`,
    });
  } catch (e: any) {
    const msg: string = e?.message ?? "Lỗi không xác định";
    if (msg === "no_session") {
      return res.status(503).json({
        success: false,
        message: "MTProto chưa đăng nhập. Cần kết nối tài khoản Telegram trước.",
      });
    }
    return res.status(500).json({ success: false, message: msg });
  }
});

export default router;
