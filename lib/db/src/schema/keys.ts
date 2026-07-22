import { pgTable, text, serial, timestamp, numeric, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const keyProductsTable = pgTable("key_products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  game: text("game").notNull(),
  price: numeric("price", { precision: 18, scale: 2 }).notNull(),
  durationDays: integer("duration_days").notNull().default(30),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const keysTable = pgTable("keys", {
  id: serial("id").primaryKey(),
  keyCode: text("key_code").notNull().unique(),
  productId: integer("product_id").notNull(),
  usedByTelegramId: text("used_by_telegram_id"),
  usedAt: timestamp("used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  isUsed: boolean("is_used").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertKeyProductSchema = createInsertSchema(keyProductsTable).omit({ id: true, createdAt: true });
export type InsertKeyProduct = z.infer<typeof insertKeyProductSchema>;
export type KeyProduct = typeof keyProductsTable.$inferSelect;

export const insertKeySchema = createInsertSchema(keysTable).omit({ id: true, createdAt: true });
export type InsertKey = z.infer<typeof insertKeySchema>;
export type Key = typeof keysTable.$inferSelect;
