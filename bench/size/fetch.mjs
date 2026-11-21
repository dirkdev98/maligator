const response = await fetch("data:text/plain,Hello%2C%20world%21");
console.log(await response.text());
