import { describe, expect, it } from "vitest";
import { canonicalRequest, signRequest } from "./hmac.js";

describe("HMAC request protocol", () => {
  it("binds method, path, timestamp, nonce and body digest", () => {
    const canonical = canonicalRequest("post", "/v1/sites/a/sessions", "1700000000", "nonce-1234567890", "body-digest");
    expect(canonical).toBe("POST\n/v1/sites/a/sessions\n1700000000\nnonce-1234567890\nbody-digest");
    const signature = signRequest("a-secret-with-at-least-32-characters", "POST", "/v1/sites/a/sessions", "1700000000", "nonce-1234567890", "body-digest");
    expect(signature).toHaveLength(43);
    expect(signRequest("a-secret-with-at-least-32-characters", "POST", "/v1/sites/a/sessions", "1700000000", "different-nonce", "body-digest")).not.toBe(signature);
  });
});
