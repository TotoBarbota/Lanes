// A dependency-free stand-in for a real dev server (Vite, Next, Gatsby...).
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.env.PORT || 3300);
const page = () => fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  .replaceAll('%API_URL%', process.env.API_URL || 'http://localhost:3380')
  .replaceAll('%LANE_NAME%', process.env.LANE_NAME || '');

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page());
}).listen(port, () => console.log(`Shop UI on http://localhost:${port}`));
