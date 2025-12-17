#!/usr/bin/env node

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readdir } from "node:fs/promises";
import { normalize, join, extname } from 'node:path';
import { cwd, argv } from 'node:process';

const
	PORT = Number(argv.slice(2)[0] || 3000), ROOT = cwd(),
	MIME = {
		'.html': 'text/html',
		'.css': 'text/css',
		'.js': 'text/javascript',

		'.json': 'application/json',

		'.png': 'image/png',
		'.jpg': 'image/jpeg',

		'.txt': 'text/plain',
	},
	
	serveFile = (res, file) => {
		res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
		createReadStream(file).pipe(res);
	}
;

createServer(async (req, res) => {

	const
		url = decodeURIComponent(req.url),
		path = normalize(join(ROOT, url))
	;

    if (!path.startsWith(ROOT)) return res.writeHead(403).end('403 Forbidden');


    try {
        if (!(await stat(path)).isDirectory()) return serveFile(res, path);

        const idxPath = join(path, 'index.html');
        if ((await stat(idxPath).catch(() => ({}))).isFile?.()) return serveFile(res, idxPath);

        const
			parent = url === '/' ? '' : '<li><a href="..">⬆️ Parent Directory</a></li>'
		;
        
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><meta charset="utf-8"><h1>📂 ${url}</h1><ul>${parent}${(await readdir(path)).reduce(
			(acc, value) => `${acc}<li><a href="${join(url, value).replace(/\\/g, '/')}">${value}</a></li>`,
			""
		)}</ul>`);

	} catch (e) {

		const is404 = e.code === 'ENOENT';
        res.writeHead(is404 ? 404 : 500).end(is404 ? '404 Not Found' : '500 Internal Server Error');

	}

}).listen(PORT, () => console.log(`Server: http://localhost:${PORT}\nRoot: ${ROOT}`));