import { Router } from "express";

const router = Router();

router.post("/verify", (req, res) => {
  const { token } = req.body as { token?: string };
  const adminToken = "19112007vV";

  if (!token) {
    return res.status(401).json({ success: false, message: "Thiếu token." });
  }

  if (token === adminToken) {
    return res.status(200).json({ success: true, message: "Xác thực thành công." });
  }

  return res.status(401).json({ success: false, message: "Token không đúng." });
});

export default router;
