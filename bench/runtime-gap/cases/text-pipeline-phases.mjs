import { runRuntimeGapCase } from "../case-runner.mjs";

const variant = process.argv[4] ?? "mixed";
const marked = process.argv[5] === "phases";
const warmupBlocks = Number(process.argv[3] ?? "5");
if (marked && (typeof mal === "undefined" || !mal._profilePhaseBegin)) {
	throw new Error("phase markers require a sampling-enabled native binary");
}
const variants = [
	"mixed",
	"early-wide",
	"late-wide",
	"sparse-escapes",
	"dense-escapes",
	"bmp-runs",
	"split-surrogate",
	"joined-surrogate",
];
if (!variants.includes(variant)) throw new Error("unknown text variant: " + variant);

const records = {};
const paths = [];
const asciiRun = "abcdefghijklmnopqrstuv".repeat(6);
const surrogateControl = variant === "split-surrogate" || variant === "joined-surrogate";
for (let index = 0; index < 32; index++) {
	const key =
		"record-caf\u00e9\u0100-" +
		String(index).padStart(3, "0") +
		"-abcdefghijklmnopqrstuv";
	let title = "Cr\u00e8me br\u00fbl\u00e9e \u00e0 \u6771\u4eac \ud83d\ude00 " + index;
	let detail = 'quoted "caf\u00e9"\\stock\t\u0100\ud800\0' + index;
	if (variant === "early-wide" || variant === "late-wide") {
		title =
			(variant === "early-wide" ? "\u0100" + asciiRun : asciiRun + "\u0100") + index;
		detail = asciiRun + index;
	} else if (variant === "sparse-escapes" || variant === "dense-escapes") {
		title = "\u0100" + asciiRun + index;
		detail =
			(variant === "sparse-escapes" ? asciiRun + '"\\\t\0' : '"\\\t\0'.repeat(34)) +
			index;
	} else if (variant === "bmp-runs") {
		title = "\u6771\u4eac\u0100\u03bb".repeat(33) + index;
		detail = asciiRun + index;
	} else if (surrogateControl) {
		title = asciiRun + (variant === "split-surrogate" ? "\ud83d" : "\ud83d\ude00");
		detail = (variant === "split-surrogate" ? "\ude00" : "") + asciiRun + index;
	}
	records[key] = { title, detail, amount: index * 17 + 3 };
	paths.push("/records/" + key + "/summary");
}
const source = JSON.stringify({ records, paths: paths.concat(paths) });
let invocation = 0;

// IDs 100–105 are local to this workload; compiler phase IDs remain independent.
function run(scale) {
	const phases = marked && ++invocation > warmupBlocks;
	let checksum = 5381;
	const operations = 64 * scale;
	if (phases) mal._profilePhaseBegin(100);
	for (let batch = 0; batch < operations; batch++) {
		if (phases) mal._profilePhaseBegin(101);
		const document = JSON.parse(source);
		if (phases) mal._profilePhaseEnd(101);
		const summaries = [];
		for (let index = 0; index < document.paths.length; index++) {
			if (phases) mal._profilePhaseBegin(102);
			const key = document.paths[index].slice(9, -8);
			const record = document.records[key];
			if (phases) mal._profilePhaseEnd(102);
			if (phases) mal._profilePhaseBegin(103);
			const label = surrogateControl
				? record.title + record.detail + String(record.amount)
				: [record.title, record.detail, String(record.amount)].join(" | ");
			summaries.push({
				key,
				label: label.replace("\t", " "),
				total: record.amount + index,
			});
			if (phases) mal._profilePhaseEnd(103);
		}
		if (phases) mal._profilePhaseBegin(104);
		const output = JSON.stringify(summaries);
		if (phases) mal._profilePhaseEnd(104);
		if (phases) mal._profilePhaseBegin(105);
		for (let offset = 0; offset < output.length; offset++) {
			checksum = ((checksum << 5) + checksum + output.charCodeAt(offset)) | 0;
		}
		if (phases) mal._profilePhaseEnd(105);
	}
	if (phases) mal._profilePhaseEnd(100);
	return { checksum: checksum >>> 0, operations };
}

runRuntimeGapCase("text-pipeline-phases", run);
