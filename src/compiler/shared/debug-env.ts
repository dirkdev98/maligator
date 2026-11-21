// The embedded compiler can run in a realm without a process object.
export const debugEnabled =
	typeof process !== "undefined" && process.env.MAL_DEBUG === "true";
