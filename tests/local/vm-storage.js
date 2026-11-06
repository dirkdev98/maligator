// Allocates across several size classes before and after a timer turn, so the
// heap's allocation cursors are in use when the collector runs.
const records = [];
for (let i = 0; i < 2000; i++) {
	records.push({ index: i, label: `record ${i}`, tags: [i, i * 2] });
}
setTimeout(() => {
	const total = records.reduce((sum, record) => sum + record.tags[1], 0);
	console.log(`vm-storage ${records.length} ${records[1999].label} ${total}`);
}, 0);
