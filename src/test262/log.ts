let lastLog = Date.now();

export function test262Log(...args: Array<unknown>): void {
	const now = Date.now();
	// eslint-disable-next-line no-console
	console.log(`[TEST262 +${now - lastLog}ms]`, ...args);
	lastLog = now;
}
