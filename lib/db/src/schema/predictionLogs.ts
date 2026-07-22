import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Bảng lưu lịch sử mỗi dự đoán của Advanced AI.
 * Mỗi hàng = 1 phiên game được bot phân tích.
 * - action = 'BET': bot phát tín hiệu dự đoán
 * - action = 'SKIP': bot bỏ qua phiên này (nhiễu)
 * is_correct được điền khi phiên kế tiếp của game đó về (verifyPrediction).
 */
export const predictionLogsTable = pgTable("prediction_logs", {
  id:             serial("id").primaryKey(),
  gameKey:        text("game_key").notNull(),          // "taixiu" | "xocdia" v.v.
  sessionId:      integer("session_id").notNull(),      // ID phiên được dự đoán
  action:         text("action").notNull(),             // "BET" | "SKIP"
  predictedLabel: text("predicted_label"),              // "Tài" | "Xỉu" | "" khi SKIP
  actualLabel:    text("actual_label"),                 // điền sau khi phiên về
  confidence:     integer("confidence").notNull(),      // tổng điểm 0–100
  trendScore:     integer("trend_score"),               // thành phần Trend
  freqScore:      integer("freq_score"),                // thành phần Frequency
  revScore:       integer("rev_score"),                 // thành phần Reversal
  isCorrect:      boolean("is_correct"),                // null = chưa verify
  createdAt:      timestamp("created_at",  { withTimezone: true }).notNull().defaultNow(),
  verifiedAt:     timestamp("verified_at", { withTimezone: true }),
  hourOfDay:      integer("hour_of_day"),               // 0–23 VN time, cho grouping
});

export const insertPredictionLogSchema = createInsertSchema(predictionLogsTable).omit({ id: true, createdAt: true });
export type InsertPredictionLog = z.infer<typeof insertPredictionLogSchema>;
export type PredictionLog = typeof predictionLogsTable.$inferSelect;
