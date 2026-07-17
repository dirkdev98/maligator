const value = Buffer.from("global", "utf8");
console.log(
	"RESULT " +
		(Buffer === globalThis.Buffer &&
		value instanceof Uint8Array &&
		value.toString() === "global"
			? "1/1"
			: "0/1"),
);
