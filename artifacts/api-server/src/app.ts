import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── API routes ─────────────────────────────────────────────────────────────
app.use("/api", router);

// ─── Serve Admin Panel static files (production / Docker) ───────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

app.use(express.static(publicDir));

// SPA fallback — mọi route không phải /api đều trả về index.html
// Express 5 yêu cầu named wildcard thay vì bare "*"
app.get("/{*splat}", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(publicDir, "index.html"), (err) => {
    if (err) next(); // không có file tĩnh → bỏ qua (dev mode)
  });
});

// ─── Global error handler — ẩn thông tin nhạy cảm (DB URL, stack trace) ─────
app.use((err: any, _req: any, res: any, _next: any) => {
  logger.error({ err }, "Unhandled error");
  // Không bao giờ trả về message gốc có thể chứa connection string
  const safe = typeof err?.message === "string" && !err.message.includes("://")
    ? err.message
    : "Lỗi server nội bộ.";
  res.status(err?.status ?? 500).json({ success: false, message: safe });
});

export default app;
