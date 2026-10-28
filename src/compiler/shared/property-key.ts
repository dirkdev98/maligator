export function compilerPropertyKeyIsArrayIndex(name: string): boolean {
	if (!/^(?:0|[1-9][0-9]*)$/.test(name)) return false;
	return Number(name) <= 0xffff_fffe;
}
