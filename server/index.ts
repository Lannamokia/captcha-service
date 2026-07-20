import { config } from "./config.js";
import { prisma } from "./database.js";
import { createApp } from "./app.js";
import { disconnectNonceStore } from "./nonce-store.js";

const app = createApp();

const server = app.listen(config.PORT, () => {
  console.log(`captcha-service listening on ${config.PUBLIC_BASE_URL}`);
});

const cleanup = setInterval(() => {
  const summariesBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  void prisma.widgetSession.deleteMany({ where: { created_at: { lt: summariesBefore } } })
    .catch((error) => console.error("captcha cleanup failed", error));
}, 60_000);
cleanup.unref();

async function shutdown() {
  clearInterval(cleanup);
  server.close();
  await Promise.all([prisma.$disconnect(), disconnectNonceStore()]);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
