const url = 'https://en.wikipedia.org/w/api.php?action=query&titles=2022_FIFA_World_Cup_final&prop=extracts&exintro&explaintext&format=json';

try {
  const response = await fetch(url);
  const json = await response.json();
  const pages = json.query.pages;
  const page = Object.values(pages)[0];
  console.log(page.extract);
} catch (e) {
  console.error('Error:', e);
}
