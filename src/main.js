#!/usr/bin/env node

import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { createReadStream, readFileSync } from 'node:fs';
import { stat, opendir, access } from "node:fs/promises";
import { normalize, join, extname, resolve } from 'node:path';
import { cwd, argv, platform, exit } from 'node:process';
import { pipeline } from 'node:stream';
import { createGzip, createDeflate } from 'node:zlib';
import { exec } from 'node:child_process';

// --- 設定と引数解析 ---

const args = argv.slice(2);
const conf = {
    port: 8080,
    host: '0.0.0.0',
    root: cwd(),
    cors: false,
    gzip: false,
    cache: null, // 秒数
    showDir: true,
    autoIndex: true,
    silent: false,
    proxy: null,
    ssl: false,
    cert: null,
    key: null,
    username: null,
    password: null,
    open: false
};

// 引数解析用の一時変数
let rootPathCandidate = null;

for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
        case '-p':
        case '--port':
            conf.port = Number(args[++i]);
            break;
        case '-a':
            conf.host = args[++i];
            break;
        case '-d':
            conf.showDir = args[++i] !== 'false'; // -d false で無効化
            break;
        case '-i':
            conf.autoIndex = args[++i] !== 'false';
            break;
        case '-g':
        case '--gzip':
            conf.gzip = true;
            break;
        case '-c':
            conf.cache = Number(args[++i]);
            break;
        case '--cors':
            conf.cors = true;
            break;
        case '-s':
        case '--silent':
            conf.silent = true;
            break;
        case '-P':
        case '--proxy':
            conf.proxy = args[++i];
            break;
        case '-S':
        case '--ssl':
            conf.ssl = true;
            break;
        case '-C':
        case '--cert':
            conf.cert = args[++i];
            break;
        case '-K':
        case '--key':
            conf.key = args[++i];
            break;
        case '--username':
            conf.username = args[++i];
            break;
        case '--password':
            conf.password = args[++i];
            break;
        case '-o':
        case '--open':
            conf.open = true;
            break;
        case '-h':
        case '--help':
            console.log(`
Usage: http-server [path] [options]
Options:
  -p --port       Port to use (defaults to 8080)
  -a              Address to use (defaults to 0.0.0.0)
  -d              Show directory listings (default 'true')
  -i              Display autoIndex (default 'true')
  -g --gzip       Serve gzip files when possible
  -c              Cache time (max-age) in seconds
  --cors          Enable CORS via the "Access-Control-Allow-Origin" header
  -o --open       Open browser after starting the server
  -P --proxy      Fallback proxy if the request returns 404
  -S --ssl        Enable https
  -C --cert       Path to ssl cert file (default: cert.pem)
  -K --key        Path to ssl key file (default: key.pem)
  -s --silent     Suppress log messages from output
  --username      Username for basic authentication
  --password      Password for basic authentication
`);
            exit(0);
            break;
        default:
            if (!arg.startsWith('-')) {
                rootPathCandidate = arg;
            }
            break;
    }
}

// ルートパスの決定ロジック (http-server準拠)
// 1. 引数があればそれを使用
// 2. なければ ./public があるか確認して使用
// 3. なければ ./ (cwd) を使用
const resolveRoot = async () => {
    if (rootPathCandidate) {
        return resolve(cwd(), rootPathCandidate);
    }
    const publicDir = join(cwd(), 'public');
    try {
        await access(publicDir);
        return publicDir;
    } catch {
        return cwd();
    }
};

// --- サーバー機能の実装 ---

const MIME = {
    // テキスト・コード
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.jsx': 'text/javascript',
    '.json': 'application/json', '.jsonld': 'application/ld+json', '.map': 'application/json',
    '.txt': 'text/plain', '.csv': 'text/csv', '.xml': 'text/xml',
    '.md': 'text/markdown', '.webmanifest': 'application/manifest+json',
    // 画像
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.webp': 'image/webp', '.avif': 'image/avif',
    // フォント
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
    // バイナリ・その他
    '.wasm': 'application/wasm', '.pdf': 'application/pdf',
    '.zip': 'application/zip', '.mp4': 'video/mp4', '.webm': 'video/webm'
    // 必要に応じて元のリストから補完してください
};

const COMPRESSIBLE = new Set([
    'text/html', 'text/css', 'text/javascript', 'application/json',
    'application/ld+json', 'text/plain', 'text/csv', 'text/xml',
    'text/markdown', 'image/svg+xml', 'application/manifest+json'
]);

// ログ出力
const log = (req, status, msg = '') => {
    if (conf.silent) return;
    const date = new Date().toISOString();
    const color = status >= 400 ? '\x1b[31m' : (status >= 300 ? '\x1b[33m' : '\x1b[32m');
    console.log(`[${date}] ${color}${req.method} ${req.url} -> ${status}\x1b[0m ${msg}`);
};

// プロキシ処理
const proxyRequest = (req, res) => {
    if (!conf.proxy) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        log(req, 404);
        return;
    }

    const proxyUrl = new URL(req.url, conf.proxy);
    const options = {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        path: proxyUrl.pathname + proxyUrl.search,
        method: req.method,
        headers: req.headers
    };

    const proxyReq = (proxyUrl.protocol === 'https:' ? httpsRequest : httpRequest)(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        log(req, proxyRes.statusCode, `(Proxy to ${conf.proxy})`);
    });

    proxyReq.on('error', (e) => {
        console.error('Proxy Error:', e.message);
        if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
        }
    });

    req.pipe(proxyReq);
};

const serveFile = async (req, res, filePath, stats) => {
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    // キャッシュ制御
    let maxAge = 0;
    if (conf.cache !== null) {
        maxAge = conf.cache; // -c オプション優先
    } else {
        // デフォルト: テキストは0、その他は3600
        const isText = COMPRESSIBLE.has(contentType);
        maxAge = isText ? 0 : 3600;
    }

    const etag = `W/"${stats.size.toString(36)}-${stats.mtime.getTime().toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        log(req, 304);
        return;
    }

    const headers = {
        'Content-Type': contentType,
        'ETag': etag,
        'Cache-Control': `public, max-age=${maxAge}`,
        'Vary': 'Accept-Encoding'
    };

    if (conf.cors) {
        headers['Access-Control-Allow-Origin'] = '*';
        headers['Access-Control-Allow-Headers'] = 'Origin, X-Requested-With, Content-Type, Accept, Range';
    }

    // 圧縮処理 (-g オプション有効時のみ)
    let transform;
    if (conf.gzip && COMPRESSIBLE.has(contentType) && stats.size > 1024) {
        const acceptEncoding = req.headers['accept-encoding'] || '';
        if (acceptEncoding.includes('gzip')) {
            headers['Content-Encoding'] = 'gzip';
            transform = createGzip();
        } else if (acceptEncoding.includes('deflate')) {
            headers['Content-Encoding'] = 'deflate';
            transform = createDeflate();
        }
    }

    if (!transform) {
        headers['Content-Length'] = stats.size;
    }

    res.writeHead(200, headers);
    
    // I/O効率化
    const readStream = createReadStream(filePath, { highWaterMark: 512 * 1024 });

    if (transform) {
        pipeline(readStream, transform, res, (err) => {
            if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('Pipe error:', err);
        });
    } else {
        pipeline(readStream, res, (err) => {
            if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('Pipe error:', err);
        });
    }
    log(req, 200);
};

const serveDirectory = async (res, url, dirPath) => {
    if (!conf.showDir) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.write(`<!DOCTYPE html><meta charset="utf-8"><h1>📂 ${url}</h1><ul>`);
    if (url !== '/') res.write('<li><a href="..">⬆️ Parent</a></li>');

    try {
        const dir = await opendir(dirPath, { bufferSize: 64 });
        const urlPrefix = url.endsWith('/') ? url : url + '/';

        for await (const dirent of dir) {
            const name = dirent.name;
            const href = urlPrefix + name;
            res.write(`<li><a href="${href}">${name}${dirent.isDirectory() ? '/' : ''}</a></li>`);
        }
        res.end('</ul>');
    } catch (e) {
        res.end('</ul><p>Access Error</p>');
    }
};

const requestHandler = async (req, res, root) => {
    req.socket.setTimeout(30000);

    // Basic認証
    if (conf.username && conf.password) {
        const auth = req.headers['authorization'];
        if (!auth) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="User Visible Realm"' });
            res.end('Unauthorized');
            log(req, 401, 'Auth Required');
            return;
        }
        const [scheme, credentials] = auth.split(' ');
        const [user, pass] = Buffer.from(credentials, 'base64').toString().split(':');
        if (scheme !== 'Basic' || user !== conf.username || pass !== conf.password) {
            res.writeHead(401);
            res.end('Unauthorized');
            log(req, 401, 'Auth Failed');
            return;
        }
    }

    try {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const urlPath = decodeURIComponent(urlObj.pathname);

        if (urlPath.indexOf('\0') !== -1) throw new Error('Malicious Path');
        const path = normalize(join(root, urlPath));

        if (!path.startsWith(root)) {
            res.writeHead(403).end('Forbidden');
            log(req, 403);
            return;
        }

        let stats;
        try {
            stats = await stat(path);
        } catch (e) {
            // ファイルがない場合はプロキシへ
            return proxyRequest(req, res);
        }

        if (stats.isDirectory()) {
            if (conf.autoIndex) {
                const idxPath = join(path, 'index.html');
                try {
                    const idxStats = await stat(idxPath);
                    if (idxStats.isFile()) {
                        return serveFile(req, res, idxPath, idxStats);
                    }
                } catch {}
            }
            return serveDirectory(res, urlPath, path);
        }

        return serveFile(req, res, path, stats);

    } catch (e) {
        if (!res.headersSent) res.writeHead(500).end('Server Error');
        console.error(e.message);
        log(req, 500);
    }
};

// メイン処理開始
(async () => {
    conf.root = await resolveRoot();

    let server;
    if (conf.ssl) {
        try {
            const options = {
                key: readFileSync(conf.key || 'key.pem'),
                cert: readFileSync(conf.cert || 'cert.pem')
            };
            server = createHttpsServer(options, (req, res) => requestHandler(req, res, conf.root));
        } catch (e) {
            console.error('Error starting SSL server. Ensure key/cert files exist or specify with -K/-C.');
            console.error(e.message);
            exit(1);
        }
    } else {
        server = createHttpServer((req, res) => requestHandler(req, res, conf.root));
    }

    server.keepAliveTimeout = 5000;

    server.listen(conf.port, conf.host, () => {
        const protocol = conf.ssl ? 'https' : 'http';
        const url = `${protocol}://${conf.host}:${conf.port}`;
        
        if (!conf.silent) {
            console.log(`Starting up http-server, serving ${conf.root}`);
            console.log(`Available on:`);
            console.log(`  ${url}`);
            console.log('Hit CTRL-C to stop the server');
        }

        if (conf.open) {
            const cmd = platform === 'win32' ? 'start' : (platform === 'darwin' ? 'open' : 'xdg-open');
            exec(`${cmd} ${url}`);
        }
    });
})();