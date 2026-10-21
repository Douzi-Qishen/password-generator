import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT ?? 8754);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT 必须是 1–65535 之间的整数。');
}
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/generator.js', ['generator.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const server = createServer(async (req, res) => {
  // Only static application files are served, and only on loopback.
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  let path;
  try {
    path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  } catch {
    res.writeHead(400, headers).end();
    return;
  }
  const asset = assets.get(path);
  if (!asset || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(404, headers).end();
    return;
  }
  try {
    const body = await readFile(new URL(asset[0], import.meta.url));
    res.writeHead(200, { ...headers, 'Content-Type': asset[1] });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500, headers).end('无法读取页面文件。');
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `端口 ${port} 已占用，可使用 PORT=8755 npm start。`
    : `本地服务启动失败：${error.code ?? 'UNKNOWN'}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`密码生成器已启动：http://127.0.0.1:${port}`);
  console.log('密码仅在浏览器内生成；按 Ctrl+C 停止服务。');
});
