let count = 0;
const interval = setInterval(() => {
	count++;
	console.log("interval " + count);
	if (count === 1) {
		setTimeout(() => console.log("nested timeout"), 0);
	}
	if (count === 2) {
		clearInterval(interval);
		console.log("RESULT 1/1");
	}
});
