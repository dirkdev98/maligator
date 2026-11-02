import { dlopen, FFIType as t } from "bun:ffi";
import { Buffer } from "node:buffer";
import process from "node:process";
const sqlite = dlopen(new URL("../native/libffi-bench.dylib", import.meta.url).pathname, {
	ffi_bench_library_identity: { args: [], returns: t.cstring },
	ffi_bench_sql_open: { args: [], returns: t.ptr },
	ffi_bench_sql_prepare: { args: [t.ptr, t.ptr], returns: t.ptr },
	ffi_bench_sql_bind: { args: [t.ptr, t.i32], returns: t.i32 },
	ffi_bench_sql_step: { args: [t.ptr], returns: t.i32 },
	ffi_bench_sql_column: { args: [t.ptr], returns: t.i32 },
	ffi_bench_sql_reset: { args: [t.ptr], returns: t.i32 },
	ffi_bench_sql_finalize: { args: [t.ptr], returns: t.i32 },
	ffi_bench_sql_close: { args: [t.ptr], returns: t.i32 },
	ffi_bench_crypto_final: { args: [t.ptr, t.ptr, t.u32], returns: t.i32 },
});
const zstd = dlopen(process.argv[6], {
	ZSTD_compressBound: { args: [t.u64], returns: t.u64 },
	ZSTD_createCCtx: { args: [], returns: t.ptr },
	ZSTD_freeCCtx: { args: [t.ptr], returns: t.u64 },
	ZSTD_createDCtx: { args: [], returns: t.ptr },
	ZSTD_freeDCtx: { args: [t.ptr], returns: t.u64 },
	ZSTD_compressCCtx: { args: [t.ptr, t.ptr, t.u64, t.ptr, t.u64, t.i32], returns: t.u64 },
	ZSTD_decompressDCtx: { args: [t.ptr, t.ptr, t.u64, t.ptr, t.u64], returns: t.u64 },
	ZSTD_isError: { args: [t.u64], returns: t.u32 },
});
const crypto = dlopen(process.argv[7], {
	EVP_MD_CTX_new: { args: [], returns: t.ptr },
	EVP_MD_CTX_free: { args: [t.ptr], returns: t.void },
	EVP_sha256: { args: [], returns: t.ptr },
	EVP_DigestInit_ex: { args: [t.ptr, t.ptr, t.ptr], returns: t.i32 },
	EVP_DigestUpdate: { args: [t.ptr, t.ptr, t.u64], returns: t.i32 },
});
const {
	ffi_bench_library_identity,
	ffi_bench_sql_open,
	ffi_bench_sql_prepare,
	ffi_bench_sql_bind,
	ffi_bench_sql_step,
	ffi_bench_sql_column,
	ffi_bench_sql_reset,
	ffi_bench_sql_finalize,
	ffi_bench_sql_close,
	ffi_bench_crypto_final,
} = sqlite.symbols;
const {
	ZSTD_compressBound,
	ZSTD_createCCtx,
	ZSTD_freeCCtx,
	ZSTD_compressCCtx,
	ZSTD_createDCtx,
	ZSTD_freeDCtx,
	ZSTD_decompressDCtx,
	ZSTD_isError,
} = zstd.symbols;
const {
	EVP_MD_CTX_new,
	EVP_MD_CTX_free,
	EVP_sha256,
	EVP_DigestInit_ex,
	EVP_DigestUpdate,
} = crypto.symbols;

const mode = process.argv[2];
const size = Number(process.argv[3]);
const iterations = Number(process.argv[4]);
const pattern = process.argv[5];
const rows = mode === "sqlite-row";
const compress = mode === "zstd-compress";
const repeat = pattern === "repeat";
if (
	!Number.isSafeInteger(size) ||
	size < 0 ||
	!Number.isSafeInteger(iterations) ||
	iterations < 1
)
	throw new Error("Invalid workload");
const identity = String(ffi_bench_library_identity());
if (!identity) throw new Error("Missing library identity");
const backing = Buffer.alloc(size + 17);
let seed = 0x12345678;
for (let i = 0; i < backing.length; i++) {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	backing[i] = pattern === "repeat" ? i & 7 : seed & 255;
}
const data = backing.subarray(17);
const inputLength = BigInt(size);
const warm = Math.min(
	iterations,
	10000,
	Math.max(1, Math.floor(16777216 / Math.max(size, 1))),
);
let checksum = 0;
let digest = "";
let elapsedMs = 0;

if (mode === "sqlite-bind" || mode === "sqlite-row") {
	const db = ffi_bench_sql_open();
	if (!db) throw new Error("SQLite open failed");
	const statement = ffi_bench_sql_prepare(db, Buffer.from("SELECT ?1 + 17\0"));
	if (!statement) throw new Error("SQLite prepare failed");
	for (let phase = 0; phase < 2; phase++) {
		checksum = 0;
		const count = phase === 0 ? warm : iterations;
		const start = performance.now();
		for (let i = 0; i < count; i++) {
			if (ffi_bench_sql_bind(statement, i & 1023) !== 0)
				throw new Error("SQLite bind failed");
			if (rows) {
				if (ffi_bench_sql_step(statement) !== 100) throw new Error("SQLite step failed");
				checksum = (checksum + ffi_bench_sql_column(statement)) >>> 0;
				if (ffi_bench_sql_reset(statement) !== 0) throw new Error("SQLite reset failed");
			}
		}
		elapsedMs = performance.now() - start;
	}
	if (!rows) {
		if (ffi_bench_sql_step(statement) !== 100)
			throw new Error("SQLite verification step failed");
		checksum = ffi_bench_sql_column(statement);
		if (checksum !== ((iterations - 1) & 1023) + 17)
			throw new Error("SQLite binding value changed");
	}
	if (ffi_bench_sql_finalize(statement) !== 0 || ffi_bench_sql_close(db) !== 0)
		throw new Error("SQLite cleanup failed");
} else if (mode === "zstd-compress" || mode === "zstd-decompress") {
	const encoder = ZSTD_createCCtx();
	const decoder = ZSTD_createDCtx();
	if (!encoder || !decoder) throw new Error("Zstd allocation failed");
	const compressed = Buffer.alloc(Number(ZSTD_compressBound(inputLength)) + 13).subarray(
		13,
	);
	const length = ZSTD_compressCCtx(
		encoder,
		compressed,
		BigInt(compressed.length),
		data,
		inputLength,
		1,
	);
	if (ZSTD_isError(length)) throw new Error("Zstd compression failed");
	const frame = compressed.subarray(0, Number(length));
	const capacity = BigInt(compressed.length);
	const frameLength = BigInt(frame.length);
	const output = Buffer.alloc(size + 13).subarray(13);
	let result = 0n;
	for (let phase = 0; phase < 2; phase++) {
		checksum = 0;
		const count = phase === 0 ? warm : iterations;
		const start = performance.now();
		for (let i = 0; i < count; i++) {
			result = compress
				? ZSTD_compressCCtx(encoder, compressed, capacity, data, inputLength, 1)
				: ZSTD_decompressDCtx(decoder, output, inputLength, frame, frameLength);
			checksum = (checksum + Number(result)) >>> 0;
		}
		elapsedMs = performance.now() - start;
	}
	if (ZSTD_isError(result)) throw new Error("Zstd operation failed");
	if (compress) {
		const decoded = ZSTD_decompressDCtx(
			decoder,
			output,
			inputLength,
			compressed.subarray(0, Number(length)),
			length,
		);
		if (decoded !== BigInt(size)) throw new Error("Zstd decoded size changed");
	} else if (result !== BigInt(size)) throw new Error("Zstd decoded size changed");
	if (!output.equals(data)) throw new Error("Zstd round trip failed");
	let hash = 2166136261;
	for (const byte of frame) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
	digest = hash.toString(16);
	ZSTD_freeDCtx(decoder);
	ZSTD_freeCCtx(encoder);
} else if (mode === "crypto-update") {
	const context = EVP_MD_CTX_new();
	const method = EVP_sha256();
	if (!context || !method) throw new Error("Crypto allocation failed");
	for (let phase = 0; phase < 2; phase++) {
		if (EVP_DigestInit_ex(context, method, null) !== 1)
			throw new Error("Crypto init failed");
		checksum = 0;
		const count = phase === 0 ? warm : iterations;
		const start = performance.now();
		for (let i = 0; i < count; i++)
			checksum += EVP_DigestUpdate(context, data, inputLength);
		elapsedMs = performance.now() - start;
	}
	const output = Buffer.alloc(32);
	if (ffi_bench_crypto_final(context, output, output.length) !== 32)
		throw new Error("Crypto final failed");
	digest = output.toString("hex");
	EVP_MD_CTX_free(context);
} else throw new Error("Unknown workload");
console.log(
	JSON.stringify({
		mode,
		size,
		iterations,
		pattern,
		checksum,
		digest,
		elapsedMs,
		identity,
	}),
);
