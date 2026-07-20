import { createClient, type RedisClientType } from "redis";
import { config } from "./config.js";

const NONCE_TTL_SECONDS = 5 * 60;
const memoryNonces = new Map<string, number>();
let redisClient: RedisClientType | null = null;
let connectPromise: Promise<RedisClientType> | null = null;

function nonceKey(siteId: string, nonce: string) {
  return `captcha:nonce:${siteId}:${nonce}`;
}

async function client(): Promise<RedisClientType> {
  if (redisClient?.isReady) return redisClient;
  if (!connectPromise) {
    redisClient = createClient({ url: config.REDIS_URL });
    redisClient.on("error", (error) => console.error("Redis nonce store error", error));
    connectPromise = redisClient.connect().then(() => redisClient!);
  }
  try {
    return await connectPromise;
  } catch (error) {
    connectPromise = null;
    throw error;
  }
}

export async function claimNonce(siteId: string, nonce: string): Promise<boolean> {
  const key = nonceKey(siteId, nonce);
  if (config.REDIS_URL.startsWith("memory://")) {
    const now = Date.now();
    const expiresAt = memoryNonces.get(key);
    if (expiresAt && expiresAt > now) return false;
    memoryNonces.set(key, now + NONCE_TTL_SECONDS * 1000);
    return true;
  }
  return (await (await client()).set(key, "1", { NX: true, EX: NONCE_TTL_SECONDS })) === "OK";
}

export async function clearNonceStore(): Promise<void> {
  if (config.REDIS_URL.startsWith("memory://")) {
    memoryNonces.clear();
    return;
  }
  const redis = await client();
  for await (const keys of redis.scanIterator({ MATCH: "captcha:nonce:*", COUNT: 100 })) {
    if (keys.length) await redis.del(keys);
  }
}

export async function disconnectNonceStore(): Promise<void> {
  memoryNonces.clear();
  connectPromise = null;
  const current = redisClient;
  redisClient = null;
  if (!current?.isOpen) return;
  try {
    await current.quit();
  } catch {
    current.destroy();
  }
}
