export function nextAlphaVersion(version: string): string {
	const match = /^(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)$/.exec(version);
	if (match === null) {
		throw new Error(
			`version must be an alpha prerelease such as 0.1.0-alpha.1, got ${version}`,
		);
	}
	return `${match[1]}.${match[2]}.${match[3]}-alpha.${Number(match[4]) + 1}`;
}
