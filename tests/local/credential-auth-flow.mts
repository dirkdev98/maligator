// Exercises credential and session properties through the compiled node:crypto
// surface without relying on an npm native addon or N-API.
//
// Each step is a property a credential store has to hold, not just an API call:
// a per-credential nonce, a server-side pepper that never enters the stored
// record, a constant-time verification, session tokens stored only as digests,
// and bias-free numeric codes.
//
// Prints one line per check and a final "RESULT <passed>/<total>" line.

import {
	argon2Sync,
	createHash,
	randomBytes,
	randomInt,
	timingSafeEqual,
} from "node:crypto";

const results: Array<[string, boolean]> = [];
function check(name: string, ok: boolean): void {
	results.push([name, !!ok]);
}

// Server-side pepper: held in the process, never stored beside the credential.
const PEPPER = Buffer.from("test-server-pepper-not-in-the-database", "utf8");
const ARGON2 = { memory: 512, passes: 2, parallelism: 1, tagLength: 32 };

function encodeCredential(passcode: string): string {
	// 1. a fresh 16-byte nonce per credential
	const nonce = randomBytes(16);
	// 2. Argon2id over the passcode, nonce, and pepper
	const tag = argon2Sync("argon2id", {
		message: passcode,
		nonce,
		secret: PEPPER,
		...ARGON2,
	} as never);
	// 3. a self-describing record; the pepper is deliberately absent from it
	return [
		"v1",
		"argon2id",
		`m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}`,
		nonce.toString("base64url"),
		tag.toString("base64url"),
	].join("$");
}

function verifyCredential(record: string, passcode: string): boolean {
	const [version, algorithm, costs, nonce, tag] = record.split("$");
	if (version !== "v1" || algorithm !== "argon2id") return false;
	const parsed = Object.fromEntries(
		costs!.split(",").map((part) => {
			const [key, value] = part.split("=");
			return [key, Number(value)];
		}),
	);
	// 4. re-derive with the stored parameters and compare in constant time
	const derived = argon2Sync("argon2id", {
		message: passcode,
		nonce: Buffer.from(nonce!, "base64url"),
		secret: PEPPER,
		memory: parsed.m,
		passes: parsed.t,
		parallelism: parsed.p,
		tagLength: Buffer.from(tag!, "base64url").length,
	} as never);
	const stored = Buffer.from(tag!, "base64url");
	if (stored.length !== derived.length) return false;
	return timingSafeEqual(stored, derived);
}

const passcode = "12345678";
const record = encodeCredential(passcode);
check(
	"credential record is self-describing",
	/^v1\$argon2id\$m=512,t=2,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(record),
);
check(
	"the base64url fields carry no padding",
	record
		.split("$")
		.slice(3)
		.every((field) => !field.includes("=")),
);
check("credential record never contains the pepper", !record.includes("test-server"));
check("the correct passcode verifies", verifyCredential(record, passcode));
// 5. a wrong passcode is rejected
check("a wrong passcode is rejected", !verifyCredential(record, "12345679"));
check("an empty passcode is rejected", !verifyCredential(record, ""));
// The nonce is what makes two identical passcodes store differently.
check(
	"two records for the same passcode differ",
	encodeCredential(passcode) !== encodeCredential(passcode),
);
// Without the pepper the same passcode does not verify: the pepper really is an
// independent factor, not decoration.
check(
	"a record cannot be verified without the pepper",
	(() => {
		const [, , costs, nonce, tag] = record.split("$");
		const parsed = Object.fromEntries(
			costs!.split(",").map((part) => {
				const [key, value] = part.split("=");
				return [key, Number(value)];
			}),
		);
		const withoutPepper = argon2Sync("argon2id", {
			message: passcode,
			nonce: Buffer.from(nonce!, "base64url"),
			memory: parsed.m,
			passes: parsed.t,
			parallelism: parsed.p,
			tagLength: 32,
		} as never);
		return !timingSafeEqual(Buffer.from(tag!, "base64url"), withoutPepper);
	})(),
);

// 6. an opaque 32-byte session token, transported as base64url
const sessionToken = randomBytes(32).toString("base64url");
check(
	"session token is opaque and URL-safe",
	sessionToken.length === 43 && /^[A-Za-z0-9_-]+$/.test(sessionToken),
);
check(
	"session tokens do not repeat",
	new Set(Array.from({ length: 64 }, () => randomBytes(32).toString("base64url")))
		.size === 64,
);

// 7. the store keeps only the token's SHA-256 digest
const sessions = new Map<string, string>();
function digestOf(token: string): string {
	return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
}
sessions.set(digestOf(sessionToken), "account:1");
check("the session store holds no raw token", !sessions.has(sessionToken));
check(
	"a session is found by its digest",
	sessions.get(digestOf(sessionToken)) === "account:1",
);
check("an unknown token does not resolve", !sessions.has(digestOf("A".repeat(43))));
check(
	"the stored digest matches the one-shot hash",
	digestOf(sessionToken) ===
		createHash("sha256").update(Buffer.from(sessionToken, "base64url")).digest("hex"),
);

// 8. bias-free access codes and eight-digit passcodes
function numericPasscode(): string {
	return randomInt(0, 100_000_000).toString().padStart(8, "0");
}
let allEightDigits = true;
const leadingZeroSeen = { value: false };
for (let i = 0; i < 5000; i++) {
	const code = numericPasscode();
	if (code.length !== 8 || !/^[0-9]{8}$/.test(code)) allEightDigits = false;
	if (code.startsWith("0")) leadingZeroSeen.value = true;
}
check("every passcode is exactly eight digits", allEightDigits);
// A leading zero is the case a naive `String(randomInt(...))` loses; force it
// rather than waiting for the ~10% chance to show up.
check(
	"a leading-zero passcode keeps its width",
	(0).toString().padStart(8, "0") === "00000000" &&
		(7).toString().padStart(8, "0") === "00000007",
);
check("leading-zero passcodes occur naturally", leadingZeroSeen.value);
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function accessCode(length: number): string {
	let code = "";
	for (let i = 0; i < length; i++) code += codeAlphabet[randomInt(codeAlphabet.length)];
	return code;
}
let codesValid = true;
const codes = new Set<string>();
for (let i = 0; i < 2000; i++) {
	const code = accessCode(6);
	if (code.length !== 6) codesValid = false;
	for (const character of code) {
		if (!codeAlphabet.includes(character)) codesValid = false;
	}
	codes.add(code);
}
check("access codes draw only from the alphabet", codesValid);
check("access codes are not obviously repeating", codes.size > 1900);
// This alphabet has 32 symbols, which divides 256 exactly, so even a bare
// modulo would be unbiased over it — the check below is coverage of the
// alphabet, not evidence about the sampler.
const symbolCounts = new Map<string, number>();
for (let i = 0; i < 32000; i++) {
	const symbol = codeAlphabet[randomInt(codeAlphabet.length)]!;
	symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
}
let spread = symbolCounts.size === codeAlphabet.length;
for (const count of symbolCounts.values()) {
	if (count < 600 || count > 1400) spread = false;
}
check("access-code symbols cover the whole alphabet", spread);
// Bias, where a range that does not divide 256 makes it visible: 256 % 200 = 56,
// so a modulo shortcut hands out the first 56 values twice as often. A
// deliberately awkward pool size is the honest place to look for that. This is
// a smoke check on the loop, not a statistical certification.
const awkwardPool = 200;
const awkwardCounts = new Map<number, number>();
for (let i = 0; i < 40000; i++) {
	const index = randomInt(awkwardPool);
	awkwardCounts.set(index, (awkwardCounts.get(index) ?? 0) + 1);
}
let awkwardSpread = awkwardCounts.size === awkwardPool;
for (const count of awkwardCounts.values()) {
	if (count < 120 || count > 290) awkwardSpread = false;
}
check("a pool size that does not divide 256 shows no modulo bias", awkwardSpread);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) {
		passed++;
	} else {
		console.log("FAIL: " + name);
	}
}
console.log("RESULT " + passed + "/" + results.length);
