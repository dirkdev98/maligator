import assert from "node:assert/strict";
import { webcrypto, KeyObject } from "node:crypto";
const subtle = webcrypto.subtle;
const raw = new Uint8Array(32).fill(7);
const sourceUsages = ["verify"];
const hmac = await subtle.importKey(
	"raw",
	raw,
	{ name: "HMAC", hash: "SHA-256" },
	false,
	sourceUsages,
);
sourceUsages.push("sign");
assert.deepEqual(hmac.usages, ["verify"]);
hmac.usages.push("sign");
Object.defineProperty(hmac, "extractable", { value: true });
await assert.rejects(subtle.sign("HMAC", hmac, raw), { name: "InvalidAccessError" });
await assert.rejects(subtle.exportKey("raw", hmac), { name: "InvalidAccessError" });
assert.deepEqual(KeyObject.from(hmac).export(), Buffer.from(raw));
const aes = await subtle.importKey("raw", raw, "AES-GCM", false, new Set(["encrypt"]));
const iv = new Uint8Array(12);
const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, aes, raw);
aes.usages.push("decrypt");
await assert.rejects(subtle.decrypt({ name: "AES-GCM", iv }, aes, ciphertext), {
	name: "InvalidAccessError",
});
Object.defineProperty(aes, "extractable", { value: true });
await assert.rejects(subtle.exportKey("raw", aes), { name: "InvalidAccessError" });
console.log("CRYPTO CAPABILITIES PASS");
