// Shared test fixtures: a copy of the example project in a temporary folder, a tiny PNG, a raw HTTP request.

import { mkdtempSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO = join(ROOT, 'examples', 'demo');

/** A 1×1 PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** @param {string} name */
export function tempDir(name) {
	return mkdtempSync(join(tmpdir(), `model-review-${name}-`));
}

/** The example project copied to a temporary folder (without any review data). */
export function demoProject() {
	const dir = tempDir('project');
	cpSync(join(DEMO, 'project.json'), join(dir, 'project.json'));
	cpSync(join(DEMO, 'models'), join(dir, 'models'), { recursive: true });
	return dir;
}

/**
 * An HTTP request with any headers (fetch won't send Host or Origin as given).
 * @param {string} url @param {{ method?: string, headers?: Record<string, string>, body?: string | Buffer }} [options]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
export function raw(url, { method = 'GET', headers = {}, body } = {}) {
	return new Promise((ok, no) => {
		const req = request(url, { method, headers }, (res) => {
			let data = '';
			res.setEncoding('utf8');
			res.on('data', (c) => (data += c));
			res.on('end', () => ok({ status: res.statusCode || 0, headers: res.headers, body: data }));
		});
		req.on('error', no);
		req.end(body);
	});
}
