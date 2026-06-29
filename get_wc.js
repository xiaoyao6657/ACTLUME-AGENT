const https = require('https');

const url = 'https://en.wikipedia.org/w/api.php?action=query&titles=2022_FIFA_World_Cup_final&prop=extracts&exintro&explaintext&format=json';

https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      const pages = json.query.pages;
      const page = Object.values(pages)[0];
      console.log(page.extract);
    } catch (e) {
      console.error('Parse error:', e);
    }
  });
}).on('error', (e) => {
  console.error('Request error:', e);
});
