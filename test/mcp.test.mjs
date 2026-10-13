import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { startServer } from '../lib/server.mjs';
import { ROOT, DEMO, PNG, tempDir } from './fixtures.mjs';

const config = tempDir('config');
const projectDir = join(tempDir('mcp'), 'review-project');
/** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
let child;
/** @type {Map<number, (msg: any) => void>} */
const waiting = new Map();
/** @type {any[]} */
const strays = [];
let nextId = 0;

/** Send raw text; the answer to an id comes back through `waiting`. @param {string} line */
const write = (line) => child.stdin.write(line + '\n');
/** @param {string} method @param {any} [params] @returns {Promise<any>} */
function rpc(method, params) {
	const id = ++nextId;
	return new Promise((ok) => {
		waiting.set(id, ok);
		write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
	});
}
/** Call a tool and return its result. @param {string} name @param {any} args */
const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
const textOf = (/** @type {any} */ result) => result.content.filter((/** @type {any} */ c) => c.type === 'text').map((/** @type {any} */ c) => c.text).join('\n');

before(() => {
	child = spawn(process.execPath, [join(ROOT, 'bin', 'model-review-mcp.mjs')], { env: { ...process.env, XDG_CONFIG_HOME: config }, stdio: ['pipe', 'pipe', 'pipe'] });
	let buffer = '';
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		buffer += chunk;
		for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
			const msg = JSON.parse(buffer.slice(0, nl));
			buffer = buffer.slice(nl + 1);
			const done = waiting.get(msg.id);
			if (done) {
				waiting.delete(msg.id);
				done(msg);
			} else strays.push(msg);
		}
	});
});
after(() => child.kill());

test('initialize echoes the protocol version; ping; notifications get no answer', async () => {
	const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
	assert.equal(init.result.protocolVersion, '2025-03-26');
	assert.equal(init.result.serverInfo.name, 'model-review');
	assert.ok(init.result.capabilities.tools);
	assert.match(init.result.instructions, /reply under each note/);
	write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
	assert.deepEqual((await rpc('ping')).result, {});
	assert.deepEqual(strays, [], 'nothing answered the notification');
});

test('clean errors: bad JSON, unknown methods, unknown tools, bad arguments', async () => {
	write('this is not json');
	await new Promise((ok) => setTimeout(ok, 200));
	assert.equal(strays.shift()?.error.code, -32700);
	assert.equal((await rpc('resources/list')).error.code, -32601);
	assert.equal((await rpc('tools/call', { name: 'no_such_tool', arguments: {} })).error.code, -32602);
	const bad = await tool('get_note', {});
	assert.equal(bad.isError, true);
	assert.match(textOf(bad), /missing argument: note/);
	assert.match(textOf(await tool('reply', { note: 'n1', text: 'x', colour: 'red' })), /unknown argument: colour/);
});

test('tools/list names every tool with a schema', async () => {
	const { tools } = (await rpc('tools/list')).result;
	const names = tools.map((/** @type {any} */ t) => t.name);
	for (const name of ['list_projects', 'create_project', 'open_project', 'get_project', 'add_model', 'update_model', 'serve', 'list_notes', 'get_note', 'reply', 'set_status', 'get_verdicts', 'wait_for_changes', 'export_artifact']) assert.ok(names.includes(name), name);
	for (const t of tools) assert.equal(t.inputSchema.type, 'object', t.name);
});

test('the loop: a project, a model, a note left in the page, read with its images, replied to', async () => {
	assert.match(textOf(await tool('create_project', { dir: projectDir, title: 'Test bench' })), /Started "Test bench"/);
	const added = await tool('add_model', { project: 'Test bench', file: join(DEMO, 'models', 'case.glb'), name: 'Case', parts: { lid: 'Lid', drawer: 'Drawer' } });
	assert.ok(!added.isError, textOf(added));
	assert.match(textOf(added), /Nodes: body, lid, lid_handle, hasp, stay, shoe, drawer, drawer_knob/);
	const action = { name: 'Open', steps: [{ type: 'turn', part: 'lid', axis: [-1, 0, 0], pivot: [0, 0.12, -0.1], angle: 1.7 }] };
	assert.ok(!(await tool('update_model', { project: 'Test bench', model: 'case', action })).isError);
	const wrong = await tool('update_model', { project: 'Test bench', model: 'case', action: { steps: [{ type: 'move', part: 'handle', by: [0, 0, 1] }] } });
	assert.equal(wrong.isError, true);
	assert.match(textOf(wrong), /no node named "handle"/);
	assert.match(textOf(await tool('list_projects', {})), /Test bench[\s\S]*1 model \(case\)/);

	// the person's side: the page posts an image and a note to the server
	const server = await startServer({ dir: projectDir, port: 0 });
	try {
		const post = (/** @type {string} */ path, /** @type {RequestInit} */ init) => fetch(new URL(path, server.url), init).then((r) => r.json());
		const image = (await post('api/images', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG })).id;
		const note = await post('api/notes', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: 'case', text: 'The lid should open further', images: [image], node: 'lid', local: [0, 0.02, 0.1], world: [0, 0.14, 0], radius: 0.01, view: { pos: [0.4, 0.4, 0.5], target: [0, 0.08, 0] }, k: 0.5, author: 'Sam' }),
		});

		const list = textOf(await tool('list_notes', { project: 'Test bench' }));
		assert.match(list, new RegExp(`Case #1  ${note.id}  \\[open\\]  Sam`));
		assert.match(list, /Lid \(node lid\) at x 0 mm, y 140 mm, z 0 mm, 10 mm round/);

		const got = await tool('get_note', { project: 'Test bench', note: note.id.slice(0, 9) });
		const images = got.content.filter((/** @type {any} */ c) => c.type === 'image');
		assert.equal(images.length, 1);
		assert.equal(images[0].mimeType, 'image/png');
		assert.deepEqual(Buffer.from(images[0].data, 'base64'), PNG);
		assert.match(textOf(got), /Pose: k = 0.5 · Lid turned 49° of 97°/);
		assert.match(textOf(got), /Model file: .*models\/case\.glb/);

		const before = textOf(await tool('wait_for_changes', { project: 'Test bench', timeout: 0 }));
		const cursor = /cursor: (\d+)/.exec(before)?.[1];
		assert.match(textOf(await tool('reply', { project: 'Test bench', note: note.id, text: 'Opened the lid to 110 degrees.', name: 'Claude' })), /Replied/);
		const seen = await post(`api/notes/${note.id}`, {});
		assert.equal(seen.replies[0].by, 'agent');
		assert.equal(seen.replies[0].name, 'Claude');
		assert.match(textOf(await tool('list_notes', { project: 'Test bench', status: 'addressed' })), /\[addressed\]/);

		// the agent's own reply doesn't wake it; the person's answer does
		assert.match(textOf(await tool('wait_for_changes', { project: 'Test bench', since: cursor, timeout: 0 })), /No changes/);
		const waited = tool('wait_for_changes', { project: 'Test bench', since: cursor, timeout: 10 });
		await post(`api/notes/${note.id}/replies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'human', name: 'Sam', text: 'Better, thanks' }) });
		assert.match(textOf(await waited), /1 change:[\s\S]*reply/);

		await post('api/verdicts/case', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'approved', by: 'Sam' }) });
		assert.match(textOf(await tool('get_verdicts', { project: 'Test bench' })), /case \(Case\): approved by Sam/);
		assert.match(textOf(await tool('set_status', { project: 'Test bench', note: note.id, status: 'resolved' })), /resolved/);
	} finally {
		await server.close();
	}
});
