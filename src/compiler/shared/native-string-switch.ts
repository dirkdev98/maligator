export const NATIVE_STRING_SWITCH_CASE_LIMIT = 256;
export const NATIVE_STRING_SWITCH_CODE_UNIT_LIMIT = 8192;

// Low 32 bits of mal_string_hash_code_units: FNV-1a over little-endian UTF-16 bytes.
export function nativeStringSwitchHash(codeUnits: ReadonlyArray<number>): number {
	let hash = 0x84222325;
	for (const unit of codeUnits) {
		hash = Math.imul(hash ^ (unit & 255), 0x1b3);
		hash = Math.imul(hash ^ (unit >>> 8), 0x1b3);
	}
	return hash >>> 0;
}
