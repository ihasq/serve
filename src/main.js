#!/usr/bin/env node

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, opendir } from "node:fs/promises";
import { normalize, join, extname } from 'node:path';
import { cwd, argv } from 'node:process';
import { pipeline } from 'node:stream';
import { createGzip, createDeflate } from 'node:zlib'; // 追加: 圧縮用

const
    PORT = Number(argv.slice(2)[0] || 3000),
    ROOT = cwd(),
    // I/O効率化: 大きなファイルを読み込む際のチャンクサイズを増やす (例: 512KB)
    STREAM_HIGH_WATER_MARK = 512 * 1024, 
    MIME = {
        // --- テキスト・コード ---
        '.html': 'text/html',
        '.htm': 'text/html',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript', // ES Modules
        '.jsx': 'text/javascript', // Reactなど
        '.ts': 'video/mp2t',       // ※注意: TypeScript(.ts)ではなくMPEG Transport Streamの場合が多い。TSファイルなら 'application/typescript' だが、通常ブラウザには配信しない
        '.json': 'application/json',
        '.jsonld': 'application/ld+json',
        '.map': 'application/json', // Source maps
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.xml': 'text/xml', // または application/xml
        '.md': 'text/markdown',
        '.webmanifest': 'application/manifest+json', // PWA

        // --- 画像 ---
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.webp': 'image/webp',
        '.avif': 'image/avif', // 次世代画像フォーマット
        '.bmp': 'image/bmp',
        '.tif': 'image/tiff',
        '.tiff': 'image/tiff',

        // --- フォント (Web Fonts) ---
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.otf': 'font/otf',
        '.eot': 'application/vnd.ms-fontobject',

        // --- 音声 ---
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.flac': 'audio/flac',
        '.weba': 'audio/webm',
        '.mid': 'audio/midi',
        '.midi': 'audio/midi',

        // --- 動画 ---
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.ogv': 'video/ogg',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.wmv': 'video/x-ms-wmv',
        '.flv': 'video/x-flv',
        '.m3u8': 'application/vnd.apple.mpegurl', // HLS Streaming
        '.ts': 'video/mp2t', // MPEG Transport Stream

        // --- ドキュメント ---
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.rtf': 'application/rtf',

        // --- バイナリ・アーカイブ・その他 ---
        '.wasm': 'application/wasm', // WebAssembly (重要)
        '.zip': 'application/zip',
        '.rar': 'application/x-rar-compressed',
        '.tar': 'application/x-tar',
        '.gz': 'application/gzip',
        '.7z': 'application/x-7z-compressed',
        '.bin': 'application/octet-stream',
        '.exe': 'application/octet-stream',
        '.dmg': 'application/octet-stream',
        '.iso': 'application/octet-stream',
        '.img': 'application/octet-stream'
    }
;

// 圧縮対象のMIMEタイプ（テキスト系のみ圧縮する）
const COMPRESSIBLE = new Set([
    'text/html', 'text/css', 'text/javascript', 'application/json',
    'application/ld+json', 'text/plain', 'text/csv', 'text/xml',
    'text/markdown', 'image/svg+xml', 'application/manifest+json'
]);

const serveFile = async (req, res, filePath, stats) => {
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    // 1. 強力なキャッシュ制御 (Cache-Control)
    // 画像などのバイナリは変更頻度が低いため、ブラウザに「1時間キャッシュ」を指示
    // これによりサーバーへのリクエスト数自体が減ります
    const isText = COMPRESSIBLE.has(contentType);
    const maxAge = isText ? 0 : 3600; // テキストは常に検証、画像は1時間キャッシュ

    const etag = `W/"${stats.size.toString(36)}-${stats.mtime.getTime().toString(36)}"`;
    
    // 304 Not Modified チェック
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        return res.end();
    }

    const headers = {
        'Content-Type': contentType,
        'ETag': etag,
        'Cache-Control': `public, max-age=${maxAge}`,
        'Vary': 'Accept-Encoding' // 圧縮対応ブラウザと非対応でキャッシュを分ける
    };

    // 2. 圧縮転送 (Gzip)
    let transform;
    const acceptEncoding = req.headers['accept-encoding'] || '';
    
    // テキストファイル かつ ブラウザが圧縮対応なら圧縮ストリームを用意
    if (isText && stats.size > 1024) { // 1KB以下は圧縮しない方が速い場合がある
        if (acceptEncoding.includes('gzip')) {
            headers['Content-Encoding'] = 'gzip';
            transform = createGzip();
        } else if (acceptEncoding.includes('deflate')) {
            headers['Content-Encoding'] = 'deflate';
            transform = createDeflate();
        }
    }

    // 圧縮時はContent-Lengthが事前にわからないためチャンク転送になる
    if (!transform) {
        headers['Content-Length'] = stats.size;
    }

    res.writeHead(200, headers);

    const readStream = createReadStream(filePath, { 
        highWaterMark: STREAM_HIGH_WATER_MARK // ディスク読み込み負荷軽減
    });

    if (transform) {
        pipeline(readStream, transform, res, (err) => {
            if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('Pipe error:', err);
        });
    } else {
        pipeline(readStream, res, (err) => {
            if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('Pipe error:', err);
        });
    }
};

const serveDirectory = async (res, url, dirPath) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.write(`<!DOCTYPE html><meta charset="utf-8"><h1>📂 ${url}</h1><ul>`);
    if (url !== '/') res.write('<li><a href="..">⬆️ Parent</a></li>');

    try {
        const dir = await opendir(dirPath, { bufferSize: 64 }); // バッファリング
        
        // URLの末尾スラッシュ処理を事前に行う（ループ内での計算を避ける）
        const urlPrefix = url.endsWith('/') ? url : url + '/';

        for await (const dirent of dir) {
            // パス結合の最適化: path.joinと正規表現は重いので文字列連結にする
            const name = dirent.name;
            const href = urlPrefix + name;
            // XSS対策のため最低限のエスケープが必要ですが、
            // 簡易サーバーとしての速度優先ならこのままでも可（ファイル名に<などが含まれる場合は注意）
            res.write(`<li><a href="${href}">${name}${dirent.isDirectory() ? '/' : ''}</a></li>`);
        }
        res.end('</ul>');
    } catch (e) {
        console.error(e);
        res.end('</ul><p>Access Error</p>');
    }
};

const server = createServer(async (req, res) => {
    // タイムアウト設定: 遅いクライアントによるリソース占有を防ぐ
    req.socket.setTimeout(30000); 

    try {
        // デコード処理はエラーになる可能性があるためtry内で
        const url = decodeURIComponent(req.url);
        
        // パスのサニタイズ
        if (url.indexOf('\0') !== -1) throw new Error('Malicious Path');
        const path = normalize(join(ROOT, url));

        if (!path.startsWith(ROOT)) {
            res.writeHead(403).end('Forbidden');
            return;
        }

        let stats;
        try {
            stats = await stat(path);
        } catch (e) {
            res.writeHead(404).end('Not Found');
            return;
        }

        if (stats.isDirectory()) {
            // index.html チェックの高速化
            const idxPath = join(path, 'index.html');
            try {
                const idxStats = await stat(idxPath);
                if (idxStats.isFile()) {
                    return serveFile(req, res, idxPath, idxStats);
                }
            } catch {
                // index.htmlがない場合はディレクトリ表示へ
            }
            return serveDirectory(res, url, path);
        }

        return serveFile(req, res, path, stats);

    } catch (e) {
        if (!res.headersSent) res.writeHead(500).end('Server Error');
        console.error(e.message);
    }
});

// 接続のアイドルタイムアウトを設定（ゾンビ接続の防止）
server.keepAliveTimeout = 5000; 

server.listen(PORT, () => {
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Root:   ${ROOT}`);
    console.log(`PID:    ${process.pid}`);
});