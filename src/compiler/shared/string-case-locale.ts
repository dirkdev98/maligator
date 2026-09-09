// These complete tags are certified without runtime language-tag parsing.
export function stringCaseLocale(tag: string): "und" | "tr" | "lt" | undefined {
	if (tag === "tr" || tag === "az") return "tr";
	if (tag === "lt") return "lt";
	if (tag === "en" || tag === "en-US" || tag === "und") return "und";
	return undefined;
}
