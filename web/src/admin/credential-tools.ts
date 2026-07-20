const TEXT_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const TEXT_DIGITS = "23456789";
const TEXT_ALPHABET = `${TEXT_LETTERS}${TEXT_DIGITS}`;

function randomIndex(length: number): number {
  const maximum = Math.floor(0x1_0000_0000 / length) * length;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= maximum);
  return value[0] % length;
}

function shuffle(values: string[]): string[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = randomIndex(index + 1);
    [values[index], values[target]] = [values[target], values[index]];
  }
  return values;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generateTextChallenges(count = 100): string[] {
  const values = new Set<string>();
  while (values.size < count) {
    const characters = [
      TEXT_LETTERS[randomIndex(TEXT_LETTERS.length)],
      TEXT_DIGITS[randomIndex(TEXT_DIGITS.length)],
      ...Array.from({ length: 4 }, () => TEXT_ALPHABET[randomIndex(TEXT_ALPHABET.length)]),
    ];
    values.add(shuffle(characters).join(""));
  }
  return [...values];
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

export async function signedRequestHeaders(
  siteId: string,
  secret: string,
  method: string,
  path: string,
  body: string,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceBytes = new Uint8Array(18);
  crypto.getRandomValues(nonceBytes);
  const nonce = base64Url(nonceBytes);
  const bodyDigest = await sha256Base64Url(body);
  const canonical = [method.toUpperCase(), path, timestamp, nonce, bodyDigest].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical));
  return {
    "x-captcha-site-id": siteId,
    "x-captcha-timestamp": timestamp,
    "x-captcha-nonce": nonce,
    "x-captcha-content-sha256": bodyDigest,
    "x-captcha-signature": base64Url(new Uint8Array(signature)),
  };
}
