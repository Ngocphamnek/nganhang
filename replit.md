# HARU Control

Hệ thống Admin Panel + Telegram Bot quản lý key game và tích hợp ngân hàng MB Bank.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — chạy API server (port 8080)
- `pnpm --filter @workspace/admin-panel run dev` — chạy Admin Panel (port 20130)
- `pnpm run typecheck` — kiểm tra toàn bộ TypeScript
- `pnpm run build` — build tất cả packages
- `pnpm --filter @workspace/api-spec run codegen` — tái tạo API hooks và Zod schemas từ OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Bot: Telegraf (Telegram Bot), GramJS/telegram (MTProto)
- Validation: Zod (zod/v4), drizzle-zod
- API codegen: Orval (từ OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React + Vite, TailwindCSS, shadcn/ui, framer-motion

## Where things live

- `artifacts/api-server/src/` — Express API server
  - `routes/` — API route handlers
  - `bot/` — Telegram bot logic (keyboards, events, db helpers)
  - `bank/` — MB Bank integration (login, deposit monitor, OCR captcha)
  - `analyzer/` — game analysis (tài xỉu, xúc xắc, rồng hổ)
  - `mtproto/` — GramJS MTProto client (đọc kênh Telegram)
  - `autoplay/` — auto-play engine cho Xúc Xắc
- `artifacts/admin-panel/src/` — React admin panel
  - `pages/login.tsx` — đăng nhập bằng admin password
  - `pages/dashboard.tsx` — quản lý keys, cài đặt bot
- `lib/db/src/schema/` — Drizzle DB schema (nguồn gốc duy nhất)
- `lib/api-spec/openapi.yaml` — OpenAPI contract
- `artifacts/api-server/model.onnx` — ONNX model nhận diện captcha MB Bank

## Architecture decisions

- Admin password hardcoded là `19112007vV` trong `src/routes/auth.ts`
- Bot token ưu tiên lấy từ DB (cài qua Admin Panel), fallback về env `TELEGRAM_BOT_TOKEN`
- MTProto session lưu trong bảng `bot_settings` (key = `telegram_session`)
- Migrations chạy tự động khi server khởi động (idempotent)
- Server dùng webhook mode cho Telegram bot (không polling)

## Required Secrets

- `DATABASE_URL` — PostgreSQL connection string (tự động có sẵn từ Replit DB)
- `TELEGRAM_BOT_TOKEN` — Bot token từ @BotFather (hoặc set qua Admin Panel)
- `TELEGRAM_API_ID` — MTProto API ID (từ my.telegram.org)
- `TELEGRAM_API_HASH` — MTProto API Hash (từ my.telegram.org)

## User preferences

_Populate as you build._

## Gotchas

- Native modules (bufferutil, onnxruntime-node, utf-8-validate) cần `pnpm approve-builds` sau khi install
- model.onnx phải nằm ở `artifacts/api-server/model.onnx` (cạnh binary sau build)
- Bot chỉ start nếu có `TELEGRAM_BOT_TOKEN` (warning nếu không có, không crash)
