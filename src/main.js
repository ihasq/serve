#!/usr/bin/env node

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, opendir } from "node:fs/promises";
import { normalize, join, extname } from 'node:path';
import { cwd, argv } from 'node:process';
import { pipeline } from 'node:stream';

const
    PORT = Number(argv.slice(2)[0] || 3000),
    ROOT = cwd(),
    MIME = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.txt': 'text/plain',
    };

const serveFile = async (req, res, filePath, stats) => {
    // 1. キャッシュ制御 (304 Not Modified)
    // ブラウザが既に同じファイルを持っている場合、データ転送をスキップします。
    const etag = `W/"${stats.size}-${stats.mtime.getTime()}"`;
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        return res.end();
    }

    res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stats.size,
        'ETag': etag,
    });

    // 2. 安全なストリーミング (pipeline)
    // pipeの代わりにpipelineを使用し、エラーや完了時にリソースを確実に解放します。
    pipeline(
        createReadStream(filePath),
        res,
        (err) => {
            if (err) console.error(`Stream error: ${err.code}`, filePath);
        }
    );
};

const serveDirectory = async (res, url, dirPath) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

    // 3. ディレクトリ表示のストリーミング (メモリ節約)
    // ファイル一覧をすべてメモリに溜め込まず、少しずつクライアントに送信します。
    res.write(`<!DOCTYPE html><meta charset="utf-8"><h1>📂 ${url}</h1><ul>`);
    
    if (url !== '/') {
        res.write('<li><a href="..">⬆️ Parent Directory</a></li>');
    }

    try {
        const dir = await opendir(dirPath);
        // for await を使用して、1つずつ処理し、巨大な文字列連結を防ぎます
        for await (const dirent of dir) {
            const name = dirent.name;
            const href = join(url, name).replace(/\\/g, '/');
            res.write(`<li><a href="${href}">${name}</a></li>`);
        }
        res.end('</ul>');
    } catch (e) {
        console.error('Dir error:', e);
        res.end('</ul><p>Error listing directory</p>');
    }
};

createServer(async (req, res) => {
    try {
        const url = decodeURIComponent(req.url);
        
        // セキュリティ: nullバイト攻撃などの基本的なパスチェック
        if (url.indexOf('\0') !== -1) throw new Error('Malicious Path');
        
        const path = normalize(join(ROOT, url));

        // ディレクトリトラバーサル防止
        if (!path.startsWith(ROOT)) {
            res.writeHead(403);
            return res.end('403 Forbidden');
        }

        const stats = await stat(path);

        if (stats.isDirectory()) {
            // index.html があるかチェック
            const idxPath = join(path, 'index.html');
            try {
                const idxStats = await stat(idxPath);
                if (idxStats.isFile()) {
                    return serveFile(req, res, idxPath, idxStats);
                }
            } catch {}

            return serveDirectory(res, url, path);
        }

        // ファイル配信
        return serveFile(req, res, path, stats);

    } catch (e) {
        const is404 = e.code === 'ENOENT';
        if (!is404) console.error(e); // サーバー側のエラーのみログ出力
        res.writeHead(is404 ? 404 : 500).end(is404 ? '404 Not Found' : '500 Internal Server Error');
    }

}).listen(PORT, () => console.log(`Server: http://localhost:${PORT}\nRoot: ${ROOT}`));
