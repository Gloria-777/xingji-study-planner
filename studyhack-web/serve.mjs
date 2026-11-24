// 本地静态服务器：只用于开发预览（部署时直接把目录丢到任何静态托管即可）
// API_PORT 设了就把 /functions/* 转给本地函数，这样本页面的 AI 调用仍是同源请求，不需要 CORS。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { request as proxyRequest } from 'node:http';
import { extname, join, normalize } from 'node:path';

const ROOT = normalize(import.meta.dirname || '.');
const TYPES = {
  '.html': 'text/html;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const port = Number(process.env.PORT) || 8080;

const apiPort = Number(process.env.API_PORT) || 0;

const toApi = (req, res) => {
  const upstream = proxyRequest({ port: apiPort, path: req.url, method: req.method, headers: req.headers }, (ures) => {
    res.writeHead(ures.statusCode || 502, ures.headers);
    ures.pipe(res);
  });
  upstream.on('error', () => res.writeHead(502, { 'content-type': 'text/plain;charset=utf-8' }).end('本地函数没起来：用 API_PORT=8127 node dev/function-local.mjs'));
  req.pipe(upstream);
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (apiPort && path.startsWith('/functions/')) { toApi(req, res); return; }
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain;charset=utf-8' }).end('404 没有找到这个文件');
  }
}).listen(port, '127.0.0.1', () => console.log(`星迹静态预览: http://127.0.0.1:${port}`));
