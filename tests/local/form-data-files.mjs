import assert from "node:assert/strict";

const OriginalFile = File;
const form = new FormData();
const blob = new Blob([new Uint8Array([0, 255, 13, 10])], {
	type: "application/octet-stream",
});
form.append("blob", blob);
const stored = form.get("blob");
assert.ok(stored instanceof OriginalFile);
assert.equal(stored.name, "blob");
assert.equal(stored.type, blob.type);
assert.deepEqual(
	new Uint8Array(await stored.arrayBuffer()),
	new Uint8Array(await blob.arrayBuffer()),
);

const original = new OriginalFile(["file body"], "original.txt", {
	type: "text/plain",
	lastModified: 123,
});
form.append("original", original);
assert.equal(form.get("original"), original);
form.append("renamed", original, "renamed.txt");
assert.notEqual(form.get("renamed"), original);
assert.equal(form.get("renamed").name, "renamed.txt");
assert.equal(form.get("renamed").lastModified, 123);
assert.equal(await form.get("renamed").text(), "file body");
form.set("blob", original);
assert.equal(form.get("blob"), original);
form.set("blob", blob, "binary.dat");
assert.equal(form.get("blob").name, "binary.dat");
form.append("optional", blob, undefined);
assert.equal(form.get("optional").name, "blob");
assert.throws(() => form.append("bad", "text", "file.txt"), TypeError);
assert.throws(() => form.set("bad", "text", undefined), TypeError);

console.log("FORM DATA FILE PASS");
