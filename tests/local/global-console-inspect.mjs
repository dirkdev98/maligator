console.log(["a", "b'c"], { s: "x" }, "top");
console.log(["it's", `both ' and "`, "both ' and \" with `", "both ' and \" with ${"]);
console.log(["\0\b\t\n\v\f\r\x1b\x7f\x9f\\", "🙂", "\ud800"]);
console.log({ answer: ["nested", { "not an identifier": "value", 1: "one" }] });
console.log({ first: { second: { third: { fourth: "hidden" }, list: ["hidden"] } } });
console.log("%O\n");
console.log("inspect %O", { "it's": "quoted" });
