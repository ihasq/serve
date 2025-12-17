#!/usr/bin/env node

import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { normalize, join, extname } from 'node:path';
import { cwd, argv } from 'node:process';

const
	PORT = Number(process.argv.slice(2)[0] || 3000), ROOT = cwd(),
	MIME = {
		'.html': 'text/html',
		'.css': 'text/css',
		'.js': 'text/javascript',

		'.json': 'application/json',

		'.png': 'image/png',
		'.jpg': 'image/jpeg',

		'.txt': 'text/plain',
	}
;

createServer(async (req, res) => {

	const
		url = decodeURIComponent(req.url),
		path = normalize(join(ROOT, url))
	;

    if (!path.startsWith(ROOT)) return res.writeHead(403).end('403 Forbidden');

    const serve = (file) => {
        res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
        createReadStream(file).pipe(res);
    };

    try {
        const stats = await fs.stat(path);
        if (!stats.isDirectory()) return serve(path);

        const idxPath = join(path, 'index.html');
        if ((await fs.stat(idxPath).catch(() => ({}))).isFile?.()) return serve(idxPath);

        const
			files = await fs.readdir(path),
			list = files.map(f => `<li><a href="${join(url, f).replace(/\\/g, '/')}">${f}</a></li>`).join(''),
			parent = url === '/' ? '' : '<li><a href="..">⬆️ Parent Directory</a></li>'
		;
        
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><meta charset="utf-8"><h1>📂 ${url}</h1><ul>${parent}${list}</ul>`);

	} catch (e) {

		const is404 = e.code === 'ENOENT';
        res.writeHead(is404 ? 404 : 500).end(is404 ? '404 Not Found' : '500 Internal Server Error');

	}

}).listen(PORT, () => console.log(`Server: http://localhost:${PORT}\nRoot: ${ROOT}`));