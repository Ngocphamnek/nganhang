import { pgTable, text, serial, timestamp, numeric, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const transactionsTable = pgTable("transactions", {
  id: serial("id").primaryKey(),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull(),
  type: text("type").notNull(), // "deposit" | "buy_key" | "use_key" | "refund"
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  description: text("description"),
  status: text("status").notNull().default("pending"), // "pending" | "completed" | "failed"
  referenceId: text("reference_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTransactionSchema = createInsertSchema(transactionsTable).omit({ id: true, createdAt: true });
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactionsTable.$inferSelect;
