import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4100),
  DATABASE_URL: z.string()
    .refine((value) => value.startsWith("postgresql://") || value.startsWith("postgres://"), {
      message: "DATABASE_URL must use PostgreSQL",
    })
    .default("postgresql://captcha:captcha@localhost:5432/captcha?schema=public"),
  REDIS_URL: z.string()
    .refine((value) => /^(rediss?:\/\/|memory:\/\/)/.test(value), {
      message: "REDIS_URL must use redis://, rediss://, or memory:// in tests",
    })
    .default("redis://localhost:6379"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:4100"),
  SERVICE_MASTER_KEY: z.string().min(32).default("development-master-key-change-me-32"),
  ADMIN_JWT_SECRET: z.string().min(32).default("development-admin-jwt-change-me-32"),
});

export const config = schema.parse(process.env);

if (config.REDIS_URL.startsWith("memory://") && config.NODE_ENV !== "test") {
  throw new Error("memory:// REDIS_URL is only allowed in tests");
}

if (config.NODE_ENV === "production") {
  if (config.PUBLIC_BASE_URL.startsWith("http://")) throw new Error("PUBLIC_BASE_URL must use HTTPS in production");
  if (config.SERVICE_MASTER_KEY.startsWith("development-") || config.ADMIN_JWT_SECRET.startsWith("development-")) {
    throw new Error("Production secrets must be explicitly configured");
  }
}
