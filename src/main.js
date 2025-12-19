#!/usr/bin/env node

// --- 最適化: スレッドプール設定 (importより前に設定推奨) ---
// ファイル読み込み等のI/O操作を行うスレッドプールのサイズを拡張
import { cpus } from 'node:os';
const numCPUs = cpus().length;
process.env.UV_THREADPOOL_SIZE = Math.max(4, numCPUs);

import { createServer as createHttpServer, request as httpRequest, Agent as HttpAgent } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { createReadStream, readFileSync } from 'node:fs';
import { stat, opendir, access } from "node:fs/promises";
import { normalize, join, extname, resolve } from 'node:path';
import { cwd, argv, platform, exit, stdout } from 'node:process';
import { pipeline } from 'node:stream';
import { createGzip, createDeflate, constants as zlibConstants } from 'node:zlib';
import { exec } from 'node:child_process';
import cluster from 'node:cluster'; // マルチコア対応用

// --- 設定と引数解析 ---

const args = argv.slice(2);
const conf = {
    port: 8080,
    host: '0.0.0.0',
    root: cwd(),
    cors: false,
    gzip: false,
    cache: null, 
    showDir: true,
    autoIndex: true,
    silent: false,
    proxy: null,
    ssl: false,
    cert: null,
    key: null,
    username: null,
    password: null,
    open: false,
    threads: 'auto' // スレッド数指定用に追加
};

let rootPathCandidate = null;

for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
        case '-p':
        case '--port': conf.port = Number(args[++i]); break;
        case '-a': conf.host = args[++i]; break;
        case '-d': conf.showDir = args[++i] !== 'false'; break;
        case '-i': conf.autoIndex = args[++i] !== 'false'; break;
        case '-g':
        case '--gzip': conf.gzip = true; break;
        case '-c': conf.cache = Number(args[++i]); break;
        case '--cors': conf.cors = true; break;
        case '-s':
        case '--silent': conf.silent = true; break;
        case '-P':
        case '--proxy': conf.proxy = args[++i]; break;
        case '-S':
        case '--ssl': conf.ssl = true; break;
        case '-C':
        case '--cert': conf.cert = args[++i]; break;
        case '-K':
        case '--key': conf.key = args[++i]; break;
        case '--username': conf.username = args[++i]; break;
        case '--password': conf.password = args[++i]; break;
        case '-o':
        case '--open': conf.open = true; break;
        case '-t':
        case '--threads': conf.threads = args[++i]; break;
        case '-h':
        case '--help':
            console.log(`Usage: http-server [options]`);
            exit(0);
            break;
        default:
            if (!arg.startsWith('-')) {
                rootPathCandidate = arg;
            }
            break;
    }
}

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

// --- エージェントの再利用 (Keep-Alive) ---
const proxyHttpAgent = new HttpAgent({ keepAlive: true, keepAliveMsecs: 5000, maxSockets: Infinity });
const proxyHttpsAgent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 5000, maxSockets: Infinity });

// --- MIMEオブジェクト (変更なし) ---
const MIME = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.jsx': 'text/javascript',
    '.json': 'application/json', '.jsonld': 'application/ld+json', '.map': 'application/json',
    '.txt': 'text/plain', '.csv': 'text/csv', '.xml': 'text/xml',
    '.md': 'text/markdown', '.webmanifest': 'application/manifest+json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.webp': 'image/webp', '.avif': 'image/avif',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
    '.wasm': 'application/wasm', '.pdf': 'application/pdf',
    '.zip': 'application/zip', '.mp4': 'video/mp4', '.webm': 'video/webm'
};

const COMPRESSIBLE = new Set([
    'text/html', 'text/css', 'text/javascript', 'application/json',
    'application/ld+json', 'text/plain', 'text/csv', 'text/xml',
    'text/markdown', 'image/svg+xml', 'application/manifest+json'
]);

// --- 最適化: ログバッファリングシステム ---
// console.logの同期書き込みによるブロッキングを防ぐ
const logBuffer = [];
let cachedDate = new Date().toISOString();
let lastDateUpdate = Date.now();

const flushLogs = () => {
    if (logBuffer.length === 0) return;
    stdout.write(logBuffer.join('\n') + '\n');
    logBuffer.length = 0;
};

// ワーカープロセスでのみタイマーを稼働
if (!cluster.isPrimary) {
    setInterval(flushLogs, 1000).unref(); // 1秒ごとに書き出し
}

const log = (req, status, msg = '') => {
    if (conf.silent) return;
    
    // 日付生成も重いのでキャッシュを更新する方式にする
    const now = Date.now();
    if (now - lastDateUpdate > 1000) {
        cachedDate = new Date().toISOString();
        lastDateUpdate = now;
    }

    const color = status >= 400 ? '\x1b[31m' : (status >= 300 ? '\x1b[33m' : '\x1b[32m');
    const logLine = `[${cachedDate}] ${color}${req.method} ${req.url} -> ${status}\x1b[0m ${msg}`;
    
    logBuffer.push(logLine);
    if (logBuffer.length >= 100) flushLogs(); // バッファがいっぱいになったら即書き出し
};

const proxyRequest = (req, res) => {
    if (!conf.proxy) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        log(req, 404);
        return;
    }

    let proxyUrl;
    try {
        proxyUrl = new URL(req.url, conf.proxy);
    } catch (e) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
    }

    const isHttps = proxyUrl.protocol === 'https:';
    const options = {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        path: proxyUrl.pathname + proxyUrl.search,
        method: req.method,
        headers: req.headers,
        agent: isHttps ? proxyHttpsAgent : proxyHttpAgent
    };

    const proxyReq = (isHttps ? httpsRequest : httpRequest)(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        log(req, proxyRes.statusCode, `(Proxy to ${conf.proxy})`);
    });

    proxyReq.on('error', (e) => {
        if (!conf.silent) console.error('Proxy Error:', e.message);
        if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
        }
    });

    req.pipe(proxyReq);
};

// --- 最適化: 圧縮制限 ---
const MAX_COMPRESS_SIZE = 5 * 1024 * 1024; // 5MB以上は圧縮しない（CPUブロック防止）

const serveFile = async (req, res, filePath, stats) => {
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    // TCP遅延対策
    req.socket.setNoDelay(true);

    let maxAge = 0;
    if (conf.cache !== null) {
        maxAge = conf.cache;
    } else {
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

    let transform;
    // 圧縮条件: 設定ON && 圧縮可能MIME && サイズが小さすぎず大きすぎない
    const shouldCompress = conf.gzip && 
                           COMPRESSIBLE.has(contentType) && 
                           stats.size > 1024 && 
                           stats.size < MAX_COMPRESS_SIZE;

    if (shouldCompress) {
        const acceptEncoding = req.headers['accept-encoding'] || '';
        // 最適化: 圧縮速度を最優先にする（CPU負荷低減）
        const zlibOpts = { level: zlibConstants.Z_BEST_SPEED };
        
        if (acceptEncoding.includes('gzip')) {
            headers['Content-Encoding'] = 'gzip';
            transform = createGzip(zlibOpts);
        } else if (acceptEncoding.includes('deflate')) {
            headers['Content-Encoding'] = 'deflate';
            transform = createDeflate(zlibOpts);
        }
    }

    if (!transform) {
        headers['Content-Length'] = stats.size;
    }

    res.writeHead(200, headers);
    
    // バッファサイズを少し大きめに設定
    const readStream = createReadStream(filePath, { highWaterMark: 64 * 1024 });

    const onError = (err) => {
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error('Stream error:', err);
        }
        readStream.destroy();
    };

    if (transform) {
        pipeline(readStream, transform, res, onError);
    } else {
        pipeline(readStream, res, onError);
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
        const dir = await opendir(dirPath, { bufferSize: 32 });
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
    // Basic Auth
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
        let urlPath;
        try {
            const urlObj = new URL(req.url, `http://${req.headers.host}`);
            urlPath = decodeURIComponent(urlObj.pathname);
        } catch {
            res.writeHead(400).end('Bad Request');
            return;
        }

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
        if (!conf.silent) console.error(e.message);
        log(req, 500);
    }
};

// --- メイン処理 (Cluster対応) ---
(async () => {
    conf.root = await resolveRoot();
    
    let sslOptions = null;
    if (conf.ssl) {
        try {
            sslOptions = {
                key: readFileSync(conf.key || 'key.pem'),
                cert: readFileSync(conf.cert || 'cert.pem')
            };
        } catch (e) {
            if (cluster.isPrimary) {
                console.error('Error starting SSL server. Ensure key/cert files exist or specify with -K/-C.');
                console.error(e.message);
                exit(1);
            }
        }
    }

    // --- 最適化: クラスタリングロジック ---
    if (cluster.isPrimary) {
        // マスタープロセス
        let forks;
        if (conf.threads === 'auto') {
            // CPU数 - 1 (最低1) に設定してOS用のリソースを残す
            forks = Math.max(1, numCPUs - 1);
        } else {
            forks = Number(conf.threads) || 1;
        }

        console.log(`Starting server with ${forks} workers...`);

        for (let i = 0; i < forks; i++) {
            cluster.fork();
        }

        cluster.on('exit', (worker, code, signal) => {
            if (!conf.silent) console.log(`Worker ${worker.process.pid} died. Restarting...`);
            cluster.fork();
        });

        const protocol = conf.ssl ? 'https' : 'http';
        const url = `${protocol}://${conf.host}:${conf.port}`;
        
        if (!conf.silent) {
            console.log(`Serving ${conf.root}`);
            console.log(`Available on:`);
            console.log(`  ${url}`);
        }

        if (conf.open) {
            const cmd = platform === 'win32' ? 'start' : (platform === 'darwin' ? 'open' : 'xdg-open');
            exec(`${cmd} ${url}`);
        }

    } else {
        // ワーカープロセス
        let server;
        const handler = (req, res) => requestHandler(req, res, conf.root);

        if (conf.ssl) {
            server = createHttpsServer(sslOptions, handler);
        } else {
            server = createHttpServer(handler);
        }

        // Keep-Alive設定と最大接続数設定（OOM防止）
        server.keepAliveTimeout = 5000;
        server.headersTimeout = 6000;
        server.maxConnections = 10000;

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                if (!conf.silent) console.error(`Worker ${process.pid} failed to bind port.`);
            } else {
                console.error(err);
            }
        });

        server.listen(conf.port, conf.host);
    }
})();