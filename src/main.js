#!/usr/bin/env node

// --- 最適化: スレッドプール設定 ---
import { cpus } from 'node:os';
const numCPUs = cpus().length;
process.env.UV_THREADPOOL_SIZE = String(Math.max(4, numCPUs));

import { createServer as createHttpServer, request as httpRequest, Agent as HttpAgent } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { createReadStream, readFileSync } from 'node:fs';
import { stat, opendir, access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cwd, argv, platform, exit, stdout } from 'node:process';
import { pipeline } from 'node:stream';
import { gzipSync, createGzip, createDeflate, constants as zlibConstants } from 'node:zlib';
import { exec } from 'node:child_process';
import cluster from 'node:cluster';

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
    threads: 'auto'
};

let rootPathCandidate = null;

// 最適化: 引数パース簡略化
for (let i = 0, len = args.length; i < len; i++) {
    const arg = args[i];
    if (arg[0] !== '-') { rootPathCandidate = arg; continue; }
    switch (arg) {
        case '-p': case '--port': conf.port = +args[++i]; break;
        case '-a': conf.host = args[++i]; break;
        case '-d': conf.showDir = args[++i] !== 'false'; break;
        case '-i': conf.autoIndex = args[++i] !== 'false'; break;
        case '-g': case '--gzip': conf.gzip = true; break;
        case '-c': conf.cache = +args[++i]; break;
        case '--cors': conf.cors = true; break;
        case '-s': case '--silent': conf.silent = true; break;
        case '-P': case '--proxy': conf.proxy = args[++i]; break;
        case '-S': case '--ssl': conf.ssl = true; break;
        case '-C': case '--cert': conf.cert = args[++i]; break;
        case '-K': case '--key': conf.key = args[++i]; break;
        case '--username': conf.username = args[++i]; break;
        case '--password': conf.password = args[++i]; break;
        case '-o': case '--open': conf.open = true; break;
        case '-t': case '--threads': conf.threads = args[++i]; break;
        case '-h': case '--help': console.log('Usage: http-server [options]'); exit(0);
    }
}

const resolveRoot = async () => {
    if (rootPathCandidate) return resolve(cwd(), rootPathCandidate);
    const publicDir = join(cwd(), 'public');
    try { await access(publicDir); return publicDir; } catch { return cwd(); }
};

// --- エージェント (Keep-Alive最適化) ---
const agentOpts = { keepAlive: true, keepAliveMsecs: 10000, maxSockets: 256, maxFreeSockets: 64, scheduling: 'fifo' };
const proxyHttpAgent = new HttpAgent(agentOpts);
const proxyHttpsAgent = new HttpsAgent(agentOpts);

// --- 最適化: MIME拡張子マップ (Mapは大量キーでObjectより高速) ---
const MIME = new Map([
    ['html', 'text/html'], ['htm', 'text/html'], ['css', 'text/css'],
    ['js', 'text/javascript'], ['mjs', 'text/javascript'], ['jsx', 'text/javascript'],
    ['json', 'application/json'], ['jsonld', 'application/ld+json'], ['map', 'application/json'],
    ['txt', 'text/plain'], ['csv', 'text/csv'], ['xml', 'text/xml'],
    ['md', 'text/markdown'], ['webmanifest', 'application/manifest+json'],
    ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'], ['svg', 'image/svg+xml'], ['ico', 'image/x-icon'],
    ['webp', 'image/webp'], ['avif', 'image/avif'],
    ['woff', 'font/woff'], ['woff2', 'font/woff2'], ['ttf', 'font/ttf'],
    ['otf', 'font/otf'], ['eot', 'application/vnd.ms-fontobject'],
    ['wasm', 'application/wasm'], ['pdf', 'application/pdf'],
    ['zip', 'application/zip'], ['mp4', 'video/mp4'], ['webm', 'video/webm']
]);

// 最適化: 圧縮可能MIMEをSetで高速判定
const COMPRESSIBLE = new Set([
    'text/html', 'text/css', 'text/javascript', 'application/json',
    'application/ld+json', 'text/plain', 'text/csv', 'text/xml',
    'text/markdown', 'image/svg+xml', 'application/manifest+json'
]);

// --- 最適化: 拡張子抽出を高速化 (extname不要) ---
const getExt = (path) => {
    const idx = path.lastIndexOf('.');
    return idx > path.lastIndexOf('/') ? path.slice(idx + 1).toLowerCase() : '';
};

// --- 最適化: 小ファイルキャッシュ (LRU) ---
const FILE_CACHE_MAX_SIZE = 32 * 1024; // 32KB以下をキャッシュ
const FILE_CACHE_MAX_ENTRIES = 512;
const fileCache = new Map();

const getCachedFile = (path, stats) => {
    const cached = fileCache.get(path);
    if (cached && cached.mtime === stats.mtimeMs) return cached;
    return null;
};

const setCachedFile = (path, stats, data, compressed) => {
    if (fileCache.size >= FILE_CACHE_MAX_ENTRIES) {
        // LRU: 最古のエントリを削除
        const firstKey = fileCache.keys().next().value;
        fileCache.delete(firstKey);
    }
    fileCache.set(path, { mtime: stats.mtimeMs, data, compressed });
};

// --- 最適化: statキャッシュ (短期TTL) ---
const STAT_CACHE_TTL = 1000; // 1秒
const statCache = new Map();

const cachedStat = async (path) => {
    const now = Date.now();
    const cached = statCache.get(path);
    if (cached && now - cached.time < STAT_CACHE_TTL) return cached.stats;
    
    const stats = await stat(path);
    statCache.set(path, { stats, time: now });
    return stats;
};

// --- 最適化: ログシステム簡略化 ---
let logBuffer = '';
let cachedDate = '';
let lastDateUpdate = 0;

const flushLogs = () => {
    if (logBuffer) { stdout.write(logBuffer); logBuffer = ''; }
};

if (!cluster.isPrimary) setInterval(flushLogs, 500).unref();

const log = (method, url, status, msg = '') => {
    if (conf.silent) return;
    const now = Date.now();
    if (now - lastDateUpdate > 1000) { cachedDate = new Date().toISOString(); lastDateUpdate = now; }
    const color = status >= 400 ? '\x1b[31m' : status >= 300 ? '\x1b[33m' : '\x1b[32m';
    logBuffer += `[${cachedDate}] ${color}${method} ${url} -> ${status}\x1b[0m ${msg}\n`;
    if (logBuffer.length > 8192) flushLogs();
};

// --- プロキシ処理 ---
const proxyRequest = (req, res) => {
    if (!conf.proxy) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
        log(req.method, req.url, 404);
        return;
    }

    let proxyUrl;
    try { proxyUrl = new URL(req.url, conf.proxy); }
    catch { res.writeHead(400).end('Bad Request'); return; }

    const isHttps = proxyUrl.protocol === 'https:';
    const options = {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port || (isHttps ? 443 : 80),
        path: proxyUrl.pathname + proxyUrl.search,
        method: req.method,
        headers: req.headers,
        agent: isHttps ? proxyHttpsAgent : proxyHttpAgent
    };

    const proxyReq = (isHttps ? httpsRequest : httpRequest)(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        log(req.method, req.url, proxyRes.statusCode, `(Proxy)`);
    });

    proxyReq.on('error', () => {
        if (!res.headersSent) res.writeHead(502).end('Bad Gateway');
    });
    req.pipe(proxyReq);
};

// --- 最適化: 圧縮設定プリセット ---
const ZLIB_OPTS = { level: zlibConstants.Z_BEST_SPEED, chunkSize: 32 * 1024 };
const MAX_COMPRESS_SIZE = 2 * 1024 * 1024; // 2MB以上は圧縮しない
const MIN_COMPRESS_SIZE = 256; // 256B未満は圧縮しない

// --- 最適化: 共通ヘッダー事前生成 ---
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Range'
};

// --- ファイル配信 ---
const serveFile = async (req, res, filePath, stats) => {
    const ext = getExt(filePath);
    const contentType = MIME.get(ext) || 'application/octet-stream';

    // 最適化: TCP_NODELAYは小さいファイルにのみ
    if (stats.size < 65536) req.socket.setNoDelay(true);

    const maxAge = conf.cache ?? (COMPRESSIBLE.has(contentType) ? 0 : 3600);
    
    // 最適化: ETag生成簡略化
    const etag = `"${stats.size.toString(36)}-${stats.mtimeMs.toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304).end();
        log(req.method, req.url, 304);
        return;
    }

    const headers = {
        'Content-Type': contentType,
        'ETag': etag,
        'Cache-Control': `public, max-age=${maxAge}`,
        'Vary': 'Accept-Encoding'
    };

    if (conf.cors) Object.assign(headers, CORS_HEADERS);

    const canCompress = conf.gzip && 
                        COMPRESSIBLE.has(contentType) && 
                        stats.size > MIN_COMPRESS_SIZE && 
                        stats.size < MAX_COMPRESS_SIZE;

    const acceptEncoding = canCompress ? (req.headers['accept-encoding'] || '') : '';
    const useGzip = acceptEncoding.includes('gzip');
    const useDeflate = !useGzip && acceptEncoding.includes('deflate');

    // --- 最適化: 小ファイルはキャッシュから即座に返す ---
    if (stats.size <= FILE_CACHE_MAX_SIZE) {
        const cached = getCachedFile(filePath, stats);
        
        if (cached) {
            if (useGzip && cached.compressed) {
                headers['Content-Encoding'] = 'gzip';
                headers['Content-Length'] = cached.compressed.length;
                res.writeHead(200, headers).end(cached.compressed);
            } else {
                headers['Content-Length'] = cached.data.length;
                res.writeHead(200, headers).end(cached.data);
            }
            log(req.method, req.url, 200);
            return;
        }

        // キャッシュに無ければ読み込んでキャッシュ
        try {
            const data = await readFile(filePath);
            const compressed = canCompress ? gzipSync(data, ZLIB_OPTS) : null;
            setCachedFile(filePath, stats, data, compressed);

            if (useGzip && compressed) {
                headers['Content-Encoding'] = 'gzip';
                headers['Content-Length'] = compressed.length;
                res.writeHead(200, headers).end(compressed);
            } else {
                headers['Content-Length'] = data.length;
                res.writeHead(200, headers).end(data);
            }
            log(req.method, req.url, 200);
            return;
        } catch { /* fall through to stream */ }
    }

    // --- 大ファイルはストリーミング ---
    let transform = null;
    if (useGzip) {
        headers['Content-Encoding'] = 'gzip';
        transform = createGzip(ZLIB_OPTS);
    } else if (useDeflate) {
        headers['Content-Encoding'] = 'deflate';
        transform = createDeflate(ZLIB_OPTS);
    } else {
        headers['Content-Length'] = stats.size;
    }

    res.writeHead(200, headers);
    
    // 最適化: ファイルサイズに応じたバッファサイズ
    const hwm = stats.size > 1024 * 1024 ? 256 * 1024 : 64 * 1024;
    const readStream = createReadStream(filePath, { highWaterMark: hwm });

    const onError = (err) => {
        if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') readStream.destroy();
    };

    transform ? pipeline(readStream, transform, res, onError) : pipeline(readStream, res, onError);
    log(req.method, req.url, 200);
};

// --- ディレクトリリスト ---
const serveDirectory = async (res, url, dirPath) => {
    if (!conf.showDir) { res.writeHead(403).end('Forbidden'); return; }

    const urlPrefix = url.endsWith('/') ? url : url + '/';
    const chunks = [`<!DOCTYPE html><meta charset="utf-8"><h1>📂 ${url}</h1><ul>`];
    if (url !== '/') chunks.push('<li><a href="..">⬆️ Parent</a></li>');

    try {
        const dir = await opendir(dirPath, { bufferSize: 64 });
        for await (const dirent of dir) {
            chunks.push(`<li><a href="${urlPrefix}${dirent.name}">${dirent.name}${dirent.isDirectory() ? '/' : ''}</a></li>`);
        }
        chunks.push('</ul>');
        const html = chunks.join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) }).end(html);
    } catch {
        res.writeHead(500).end('Access Error');
    }
};

// --- 最適化: Basic認証チェック事前計算 ---
let expectedAuth = null;
const initAuth = () => {
    if (conf.username && conf.password) {
        expectedAuth = 'Basic ' + Buffer.from(`${conf.username}:${conf.password}`).toString('base64');
    }
};

// --- リクエストハンドラ ---
const requestHandler = (req, res, root) => {
    // 最適化: Basic認証の高速チェック
    if (expectedAuth) {
        const auth = req.headers['authorization'];
        if (auth !== expectedAuth) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Auth"' }).end('Unauthorized');
            log(req.method, req.url, 401);
            return;
        }
    }

    handleRequest(req, res, root).catch((e) => {
        if (!res.headersSent) res.writeHead(500).end('Server Error');
        if (!conf.silent) console.error(e.message);
        log(req.method, req.url, 500);
    });
};

const handleRequest = async (req, res, root) => {
    // 最適化: URLパース簡略化（ほとんどのケースでシンプルなパス）
    let urlPath = req.url;
    const qIdx = urlPath.indexOf('?');
    if (qIdx !== -1) urlPath = urlPath.slice(0, qIdx);
    
    try { urlPath = decodeURIComponent(urlPath); }
    catch { res.writeHead(400).end('Bad Request'); return; }

    // セキュリティチェック
    if (urlPath.includes('\0') || urlPath.includes('..')) {
        res.writeHead(403).end('Forbidden');
        log(req.method, req.url, 403);
        return;
    }

    // 最適化: パス結合簡略化（normalizeは重い）
    const path = urlPath === '/' ? root : root + urlPath.replace(/\//g, '/');
    
    if (!path.startsWith(root)) {
        res.writeHead(403).end('Forbidden');
        log(req.method, req.url, 403);
        return;
    }

    let stats;
    try { stats = await cachedStat(path); }
    catch { return proxyRequest(req, res); }

    if (stats.isDirectory()) {
        if (conf.autoIndex) {
            const idxPath = path + (path.endsWith('/') ? '' : '/') + 'index.html';
            try {
                const idxStats = await cachedStat(idxPath);
                if (idxStats.isFile()) return serveFile(req, res, idxPath, idxStats);
            } catch {}
        }
        return serveDirectory(res, urlPath, path);
    }

    return serveFile(req, res, path, stats);
};

// --- メイン処理 ---
(async () => {
    conf.root = await resolveRoot();
    initAuth();
    
    let sslOptions = null;
    if (conf.ssl) {
        try {
            sslOptions = {
                key: readFileSync(conf.key || 'key.pem'),
                cert: readFileSync(conf.cert || 'cert.pem')
            };
        } catch (e) {
            if (cluster.isPrimary) {
                console.error('SSL Error:', e.message);
                exit(1);
            }
        }
    }

    if (cluster.isPrimary) {
        // 最適化: ワーカー数の調整
        let forks = conf.threads === 'auto' 
            ? Math.max(1, Math.min(numCPUs - 1, 8)) // 最大8ワーカー
            : +conf.threads || 1;

        console.log(`Starting ${forks} workers on ${numCPUs} CPUs...`);

        for (let i = 0; i < forks; i++) cluster.fork();
        
        cluster.on('exit', (worker) => {
            if (!conf.silent) console.log(`Worker ${worker.process.pid} died, restarting...`);
            cluster.fork();
        });

        const url = `${conf.ssl ? 'https' : 'http'}://${conf.host}:${conf.port}`;
        if (!conf.silent) console.log(`Serving ${conf.root}\nAvailable on: ${url}`);
        
        if (conf.open) {
            const cmd = platform === 'win32' ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';
            exec(`${cmd} ${url}`);
        }

        // 最適化: statキャッシュの定期クリーンアップ
        setInterval(() => statCache.clear(), 30000).unref();

    } else {
        const handler = (req, res) => requestHandler(req, res, conf.root);
        const server = conf.ssl 
            ? createHttpsServer(sslOptions, handler)
            : createHttpServer(handler);

        // 最適化: サーバー設定チューニング
        server.keepAliveTimeout = 10000;
        server.headersTimeout = 15000;
        server.maxConnections = 5000;
        server.timeout = 30000;

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE' && !conf.silent) 
                console.error(`Worker ${process.pid} port bind failed.`);
        });

        server.listen(conf.port, conf.host);

        // 最適化: 定期的なキャッシュクリーンアップ
        setInterval(() => {
            statCache.clear();
        }, 60000).unref();
    }
})();
