import { Buffer } from "node:buffer";
import process from "node:process";
import {
	EVP_MD_CTX_new,
	EVP_MD_CTX_free,
	EVP_sha256,
	EVP_DigestInit_ex,
	EVP_DigestUpdate,
	ffi_bench_crypto_final,
} from "maligator:ffi/crypto";
import {
	ffi_bench_library_identity,
	ffi_bench_sql_open,
	ffi_bench_sql_prepare,
	ffi_bench_sql_bind,
	ffi_bench_sql_step,
	ffi_bench_sql_column,
	ffi_bench_sql_reset,
	ffi_bench_sql_finalize,
	ffi_bench_sql_close,
} from "maligator:ffi/sqlite";
import {
	ZSTD_compressBound,
	ZSTD_createCCtx,
	ZSTD_freeCCtx,
	ZSTD_compressCCtx,
	ZSTD_createDCtx,
	ZSTD_freeDCtx,
	ZSTD_decompressDCtx,
	ZSTD_isError,
} from "maligator:ffi/zstd";

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
const identity = ffi_bench_library_identity();
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
	const statement = ffi_bench_sql_prepare(db, "SELECT ?1 + 17");
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
	const compressed = Buffer.alloc(Number(ZSTD_compressBound(BigInt(size))) + 13).subarray(
		13,
	);
	const length = ZSTD_compressCCtx(encoder, compressed, data, 1);
	if (ZSTD_isError(length)) throw new Error("Zstd compression failed");
	const frame = compressed.subarray(0, Number(length));
	const output = Buffer.alloc(size + 13).subarray(13);
	let result = 0n;
	for (let phase = 0; phase < 2; phase++) {
		checksum = 0;
		const count = phase === 0 ? warm : iterations;
		const start = performance.now();
		for (let i = 0; i < count; i++) {
			result = compress
				? ZSTD_compressCCtx(encoder, compressed, data, 1)
				: ZSTD_decompressDCtx(decoder, output, frame);
			checksum = (checksum + Number(result)) >>> 0;
		}
		elapsedMs = performance.now() - start;
	}
	if (ZSTD_isError(result)) throw new Error("Zstd operation failed");
	if (compress) {
		const decoded = ZSTD_decompressDCtx(
			decoder,
			output,
			compressed.subarray(0, Number(length)),
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
		if (EVP_DigestInit_ex(context, method) !== 1) throw new Error("Crypto init failed");
		checksum = 0;
		const count = phase === 0 ? warm : iterations;
		const start = performance.now();
		for (let i = 0; i < count; i++) checksum += EVP_DigestUpdate(context, data);
		elapsedMs = performance.now() - start;
	}
	const output = Buffer.alloc(32);
	if (ffi_bench_crypto_final(context, output) !== 32)
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
