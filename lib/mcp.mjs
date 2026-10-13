// model-review's tools for any MCP client: an MCP server over stdio, speaking newline-delimited JSON-RPC 2.0.
// Nothing but protocol messages goes to stdout; problems go to stderr.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { initProject, addModel, updateModel, loadProject, inside, nodeNames } from './project.mjs';
import { Review, STATE_FILTERS, noteState } from './review.mjs';
import { listProjects, registerProject, resolveProject } from './registry.mjs';
import { ensureServer, runningServer } from './running.mjs';
import { noteSummary, noteDetail, numbers, partLabel } from './describe.mjs';
import { exportArtifact } from './artifact.mjs';
import { VERSION } from './server.mjs';

const LATEST_PROTOCOL = '2025-06-18';
const MAX_INLINE_IMAGE = 3.75 * 1024 * 1024; // bigger images are given as paths (clients cap images near 5 MB of base64)
const WAIT_MAX_SECONDS = 300;

const INSTRUCTIONS = `model-review keeps reviews of 3D models (GLB). A person opens a model in the browser, pins notes to spots on it with reference images and a snapshot of the view, and gives each model a verdict. You read the notes, change the model, and reply under each note saying concretely what you changed.
The loop: list_projects (or create_project / open_project); serve, and give the person the URL; list_notes; get_note for each open note (its images come back as images); fix the model and re-export the GLB into the project (add_model with replace, or overwrite the file in place: the page reloads it); reply under each note; wait_for_changes to hear what the person says next. Leave marking notes fixed to the person.
Coordinates are the GLB's own frame: metres, y up. A note's "local" point is in its node's frame and moves with that node; "world" is the model's frame as posed when pinned; k is the action's pose (0 at rest, 1 fully worked).`;

/** @typedef {{ type: 'text', text: string } | { type: 'image', data: string, mimeType: string }} Content */
/** @typedef {{ name: string, description: string, inputSchema: any, run: (args: any) => Promise<Content[]> }} Tool */

const PROJECT = { type: 'string', description: 'The project: its title, its folder name, or the path to its folder. May be left out when only one project is known.' };
const NOTE = { type: 'string', description: 'The note id, or the start of it (at least 4 characters).' };
const text = (/** @type {string} */ t) => /** @type {Content[]} */ ([{ type: 'text', text: t }]);
const json = (/** @type {unknown} */ v) => JSON.stringify(v, null, 2);

/** A project's folder, model list and review data. @param {string | undefined} ref */
function open(ref) {
	const dir = resolveProject(ref);
	return { dir, project: loadProject(dir), review: new Review(dir) };
}

/** @type {Tool[]} */
const TOOLS = [
	{
		name: 'list_projects',
		description: 'List the review projects this user has opened, with their models, unresolved notes and whether a server is running for each.',
		inputSchema: { type: 'object', properties: {} },
		async run() {
			const projects = listProjects();
			if (!projects.length) return text('No projects yet. Make one with create_project, or register an existing folder (one with project.json) with open_project.');
			const lines = [];
			for (const p of projects) {
				if (!p.ok) {
					lines.push(`${p.title}  ${p.dir}\n  can't be read: ${p.problem}`);
					continue;
				}
				const project = loadProject(p.dir);
				const notes = new Review(p.dir).listNotes({ state: 'unresolved' });
				const server = await runningServer(p.dir);
				lines.push(`${p.title}  ${p.dir}\n  ${project.models.length} model${project.models.length === 1 ? '' : 's'} (${project.models.map((m) => m.id).join(', ') || 'none'}); ${notes.filter((n) => noteState(n) === 'open').length} open notes, ${notes.filter((n) => noteState(n) === 'addressed').length} addressed; ${server ? `served at ${server.url}` : 'not served'}`);
			}
			return text(lines.join('\n\n'));
		},
	},
	{
		name: 'create_project',
		description: 'Start a review project in a folder (created if need be) and remember it.',
		inputSchema: { type: 'object', properties: { dir: { type: 'string', description: 'The folder for the project.' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['dir'] },
		async run({ dir, title, description }) {
			const full = resolve(dir);
			const project = initProject(full, { title, description });
			registerProject(full);
			return text(`Started "${project.title}" in ${full}. Add a model with add_model.`);
		},
	},
	{
		name: 'open_project',
		description: 'Remember an existing project folder (one with project.json), so other tools can name it.',
		inputSchema: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] },
		async run({ dir }) {
			const full = resolve(dir);
			const project = loadProject(full);
			registerProject(full);
			return text(`Opened "${project.title}" (${full}): ${project.models.map((m) => `${m.id} (${m.name})`).join(', ') || 'no models yet'}.`);
		},
	},
	{
		name: 'get_project',
		description: "A project's description: each model with its GLB's absolute path, its node names, parts, action, info and views (project.json, with paths made absolute).",
		inputSchema: { type: 'object', properties: { project: PROJECT } },
		async run({ project: ref }) {
			const { dir, project } = open(ref);
			const models = project.models.map((m) => {
				let nodes;
				try {
					nodes = nodeNames(inside(dir, m.file));
				} catch (e) {
					nodes = [`(can't read: ${/** @type {Error} */ (e).message})`];
				}
				return { ...m, path: inside(dir, m.file), ...(m.lod ? { lodPath: inside(dir, m.lod) } : {}), nodes };
			});
			return text(json({ dir, title: project.title, description: project.description, models }));
		},
	},
	{
		name: 'add_model',
		description: 'Copy a GLB into the project and list it, or give an existing model new files (replace: true). Returns its node names, which name its parts and the parts its action moves.',
		inputSchema: {
			type: 'object',
			properties: {
				project: PROJECT,
				file: { type: 'string', description: 'Path to the .glb.' },
				id: { type: 'string', description: 'Lowercase id; default from the name or file name.' },
				name: { type: 'string' },
				group: { type: 'string', description: 'A heading to group models under in the page.' },
				lod: { type: 'string', description: 'Path to a lighter .glb with the same node names.' },
				maps: { type: 'object', description: 'External texture maps used in place of the GLB\'s materials: { color, orm, normal, normalSpace: "tangent" | "object" } (paths).', properties: { color: { type: 'string' }, orm: { type: 'string' }, normal: { type: 'string' }, normalSpace: { type: 'string', enum: ['tangent', 'object'] } } },
				parts: { type: 'object', description: 'GLB node name to label, for the parts a reviewer may hide and that notes name.', additionalProperties: { type: 'string' } },
				replace: { type: 'boolean', description: 'Give the model with this id new files.' },
			},
			required: ['file'],
		},
		async run({ project: ref, ...options }) {
			const { dir } = open(ref);
			const { model, nodes, warnings, created } = addModel(dir, options);
			return text([`${created ? 'Added' : 'Replaced the files of'} "${model.name}" (id ${model.id}) as ${model.file}.`, `Nodes: ${nodes.slice(0, 200).join(', ')}${nodes.length > 200 ? ` and ${nodes.length - 200} more` : ''}`, ...warnings.map((w) => `Warning: ${w}`)].join('\n'));
		},
	},
	{
		name: 'update_model',
		description: "Change a model's name, group, parts, action, info or views (null removes one). The action is checked against the GLB's nodes. action: { name?, states?: [{ at, text }], steps: [{ type: 'move', part, by: [x,y,z] } | { type: 'turn', part, axis, pivot, angle } | { type: 'hide' | 'show', part, at } | { type: 'linkage', crank, coupler, slider, pivot, knee, pin, angle, axis, line? }] }, each step with optional from, to (0..1) and ease ('smooth' | 'linear'). Coordinates in the GLB's frame at rest, metres, y up; angles in radians.",
		inputSchema: {
			type: 'object',
			properties: {
				project: PROJECT,
				model: { type: 'string', description: 'The model id.' },
				name: { type: 'string' },
				group: { type: ['string', 'null'] },
				parts: { type: ['object', 'null'] },
				action: { type: ['object', 'null'] },
				info: { type: ['object', 'null'], description: '{ lede, facts: [[name, value]], notes: [..], sources: [..] }' },
				views: { type: ['object', 'null'], description: '{ "View name": { pos: [x,y,z], target: [x,y,z] } }' },
			},
			required: ['model'],
		},
		async run({ project: ref, model, ...changes }) {
			const { dir } = open(ref);
			const { model: updated, warnings } = updateModel(dir, model, changes);
			return text([`Updated ${updated.id}: ${Object.keys(changes).join(', ') || 'nothing'}. Open pages reload it.`, ...warnings.map((w) => `Warning: ${w}`)].join('\n'));
		},
	},
	{
		name: 'serve',
		description: "Start the project's review server in the background on 127.0.0.1 if it isn't running, and return the page's URL to give the person.",
		inputSchema: { type: 'object', properties: { project: PROJECT, port: { type: 'number', description: 'Default: the first free port from 8795.' } } },
		async run({ project: ref, port }) {
			const { dir, project } = open(ref);
			const { url, started } = await ensureServer(dir, { port });
			return text(`${started ? 'Started' : 'Already running'}: ${url}\nThe person reviews "${project.title}" there: pin notes by clicking the model, attach reference images, give each model a verdict.`);
		},
	},
	{
		name: 'list_notes',
		description: 'List notes, oldest first, with where each is pinned and its state: open (needs you), addressed (you replied last), resolved (the person marked it fixed).',
		inputSchema: {
			type: 'object',
			properties: {
				project: PROJECT,
				model: { type: 'string', description: 'Only notes on this model id.' },
				status: { type: 'string', enum: STATE_FILTERS, description: 'Default unresolved (open and addressed).' },
				since: { type: 'string', description: 'Only notes changed at or after this ISO 8601 time.' },
			},
		},
		async run({ project: ref, model, status = 'unresolved', since }) {
			const { project, review } = open(ref);
			const notes = review.listNotes({ model, state: status, since });
			const no = numbers(review.listNotes());
			if (!notes.length) return text(`No ${status === 'all' ? '' : `${status} `}notes${model ? ` on ${model}` : ''}.`);
			return text(`${notes.length} note${notes.length === 1 ? '' : 's'}:\n\n${notes.map((n) => noteSummary(n, project.models.find((m) => m.id === n.model), no.get(n.id))).join('\n\n')}\n\nRead one in full, with its images, with get_note.`);
		},
	},
	{
		name: 'get_note',
		description: 'A note in full: its text, where it is pinned (node, coordinates, area), the pose and camera it was made in, its replies, and its reference images and snapshot of the view as images.',
		inputSchema: { type: 'object', properties: { project: PROJECT, note: NOTE }, required: ['note'] },
		async run({ project: ref, note: id }) {
			const { dir, project, review } = open(ref);
			const note = review.findNote(id);
			const model = project.models.find((m) => m.id === note.model);
			const path = (/** @type {string} */ img) => review.imageFile(img)?.path || null;
			/** @type {Content[]} */
			const content = text(`${noteDetail(note, model, path, numbers(review.listNotes()).get(note.id))}${model ? `\n\nModel file: ${inside(dir, model.file)}${note.node ? `\nPinned node ${note.node} is labelled "${partLabel(model, note.node)}".` : ''}` : ''}`);
			const images = [...note.images.map((img, i) => [img, `Reference image ${i + 1} of ${note.images.length}:`]), ...(note.snapshot ? [[note.snapshot, 'Snapshot of the view as it was pinned, the area lit:']] : [])];
			for (const [img, label] of images) {
				const file = review.imageFile(img);
				if (!file) content.push({ type: 'text', text: `${label} missing (${img})` });
				else if (statSync(file.path).size > MAX_INLINE_IMAGE) content.push({ type: 'text', text: `${label} too big to send inline; it is at ${file.path}` });
				else content.push({ type: 'text', text: label }, { type: 'image', data: readFileSync(file.path).toString('base64'), mimeType: file.type });
			}
			return content;
		},
	},
	{
		name: 'reply',
		description: 'Reply under a note as the agent: say concretely what you changed (which part, by how much, where) or ask what you need to know. The person sees it at once; the note shows as addressed until they reply or mark it fixed.',
		inputSchema: { type: 'object', properties: { project: PROJECT, note: NOTE, text: { type: 'string' }, name: { type: 'string', description: 'The name shown on the reply. Default "Agent".' } }, required: ['note', 'text'] },
		async run({ project: ref, note: id, text: body, name }) {
			const { review } = open(ref);
			const note = review.addReply(review.findNote(id).id, { by: 'agent', name: name || 'Agent', text: body });
			return text(`Replied under ${note.id} (${note.replies.length} repl${note.replies.length === 1 ? 'y' : 'ies'} now).`);
		},
	},
	{
		name: 'set_status',
		description: "Mark a note resolved or open again. Normally the person marks notes fixed; do this only when they ask you to.",
		inputSchema: { type: 'object', properties: { project: PROJECT, note: NOTE, status: { type: 'string', enum: ['open', 'resolved'] } }, required: ['note', 'status'] },
		async run({ project: ref, note: id, status }) {
			const { review } = open(ref);
			const note = review.updateNote(review.findNote(id).id, { status }, { by: 'agent' });
			return text(`Note ${note.id} is ${note.status}.`);
		},
	},
	{
		name: 'get_verdicts',
		description: "Each model's verdict: approved, changes (needs changes) or none yet.",
		inputSchema: { type: 'object', properties: { project: PROJECT } },
		async run({ project: ref }) {
			const { project, review } = open(ref);
			const verdicts = review.getVerdicts();
			return text(project.models.map((m) => {
				const v = verdicts[m.id];
				return `${m.id} (${m.name}): ${v ? `${v.state === 'approved' ? 'approved' : 'needs changes'} by ${v.by || 'someone'} at ${v.at}` : 'no verdict yet'}`;
			}).join('\n') || 'No models.');
		},
	},
	{
		name: 'wait_for_changes',
		description: 'Wait until the person changes something (a new note, an edit, a reply, a status or a verdict), or until the timeout. Pass the cursor from the last call to hear only what came after it; without one, waits for the next change from now. Returns the changes and a new cursor.',
		inputSchema: {
			type: 'object',
			properties: {
				project: PROJECT,
				since: { type: 'string', description: 'A cursor from a previous call (or from list_notes --json).' },
				timeout: { type: 'number', description: `Seconds to wait, at most ${WAIT_MAX_SECONDS}. Default 120.` },
				include_agents: { type: 'boolean', description: "Also wake on agents' own changes (replies). Default false." },
			},
		},
		async run({ project: ref, since, timeout = 120, include_agents = false }, cancelled = () => false) {
			const { project, review } = open(ref);
			let cursor = since ?? review.cursor();
			const giveUp = Date.now() + Math.min(Math.max(0, Number(timeout) || 0), WAIT_MAX_SECONDS) * 1000;
			for (;;) {
				const batch = review.changesSince(cursor);
				cursor = batch.cursor;
				const events = batch.events.filter((e) => include_agents || e.by !== 'agent');
				if (events.length) {
					const no = numbers(review.listNotes());
					const lines = events.map((e) => {
						if (e.type === 'verdict') return `${e.at} verdict on ${e.model}: ${e.what}`;
						const note = e.id ? review.getNote(e.id) : null;
						const head = `${e.at} note ${e.id} on ${e.model}: ${e.what}${e.by === 'agent' ? ' (by an agent)' : ''}`;
						return note ? `${head}\n${noteSummary(note, project.models.find((m) => m.id === note.model), no.get(note.id))}` : head;
					});
					return text(`${events.length} change${events.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}\n\ncursor: ${cursor}`);
				}
				if (Date.now() >= giveUp || cancelled()) return text(`No changes. cursor: ${cursor}`);
				await new Promise((ok) => setTimeout(ok, 500));
			}
		},
	},
	{
		name: 'export_artifact',
		description: "Build the review page and its files for publishing as a claude.ai Artifact, so people on claude.ai can review there. Returns the Artifact tool's publish arguments (file_path, files, capabilities, icon). Notes left there come back with import-artifact on the CLI.",
		inputSchema: { type: 'object', properties: { project: PROJECT, out: { type: 'string', description: 'Output folder. Default <project>/artifact.' } } },
		async run({ project: ref, out }) {
			const { dir } = open(ref);
			const result = exportArtifact(dir, { out });
			return text([`Built ${result.page} and ${Object.keys(result.files).length} files (${(result.bytes / 1048576).toFixed(1)} MB).`, ...result.warnings.map((w) => `Warning: ${w}`), `Publish with the Artifact tool using these arguments (also in ${resolve(result.out, 'publish.json')}):`, json(result.publish)].join('\n'));
		},
	},
];

/**
 * Check a tool call's arguments against the top level of its schema: required names present, simple types right.
 * @param {any} schema @param {any} args @returns {string | null}
 */
function checkArgs(schema, args) {
	if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
	for (const name of schema.required || []) if (args[name] === undefined) return `missing argument: ${name}`;
	for (const [name, value] of Object.entries(args)) {
		const spec = schema.properties?.[name];
		if (!spec) return `unknown argument: ${name}`;
		const types = [].concat(spec.type || []);
		const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
		if (types.length && !types.includes(actual)) return `${name} must be ${types.join(' or ')}`;
		if (spec.enum && !spec.enum.includes(value)) return `${name} must be one of ${spec.enum.join(', ')}`;
	}
	return null;
}

/** A JSON-RPC error. */
class RpcError extends Error {
	/** @param {number} code @param {string} message */
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/**
 * Run the MCP server on a pair of streams (stdin and stdout for a real client).
 * @param {NodeJS.ReadableStream} input @param {NodeJS.WritableStream} output
 * @returns {{ idle: () => Promise<void> }}  idle: resolves once every request received so far is answered
 */
export function serveMcp(input, output) {
	const send = (/** @type {unknown} */ msg) => output.write(JSON.stringify(msg) + '\n');
	/** @type {Set<string | number>} requests the client has cancelled */
	const cancelled = new Set();

	/** @param {string} method @param {any} params @param {string | number | undefined} id */
	async function dispatch(method, params, id) {
		switch (method) {
			case 'initialize':
				return {
					protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : LATEST_PROTOCOL,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'model-review', version: VERSION },
					instructions: INSTRUCTIONS,
				};
			case 'ping':
				return {};
			case 'tools/list':
				return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
			case 'tools/call': {
				const tool = TOOLS.find((t) => t.name === params.name);
				if (!tool) throw new RpcError(-32602, `unknown tool: ${params.name}`);
				const args = params.arguments ?? {};
				const problem = checkArgs(tool.inputSchema, args);
				if (problem) return { content: text(`${tool.name}: ${problem}`), isError: true };
				try {
					return { content: await /** @type {any} */ (tool.run)(args, () => id !== undefined && cancelled.has(id)) };
				} catch (e) {
					return { content: text(/** @type {Error} */ (e).message || String(e)), isError: true };
				}
			}
			default:
				throw new RpcError(-32601, `method not found: ${method}`);
		}
	}

	/** @param {string} line */
	async function handle(line) {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: each line must be one JSON-RPC message' } });
		}
		if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request: send one JSON-RPC 2.0 object per line' } });
		if (typeof msg.method !== 'string') return; // a response to a request we never make
		const notification = !('id' in msg);
		if (notification) {
			if (msg.method === 'notifications/cancelled' && msg.params?.requestId !== undefined) cancelled.add(msg.params.requestId);
			return; // notifications/initialized and the rest need no answer
		}
		try {
			const result = await dispatch(msg.method, msg.params || {}, msg.id);
			if (!cancelled.delete(msg.id)) send({ jsonrpc: '2.0', id: msg.id, result });
		} catch (e) {
			const err = /** @type {RpcError} */ (e);
			if (!cancelled.delete(msg.id)) send({ jsonrpc: '2.0', id: msg.id, error: { code: typeof err.code === 'number' ? err.code : -32603, message: err.message || 'internal error' } });
		}
	}

	/** @type {Set<Promise<void>>} */
	const pending = new Set();
	let buffer = '';
	input.setEncoding('utf8');
	input.on('data', (chunk) => {
		buffer += chunk;
		for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			const job = handle(line)
				.catch((e) => {
					process.stderr.write(`model-review-mcp: ${e.stack || e}\n`);
				})
				.finally(() => pending.delete(job));
			pending.add(job);
		}
	});
	return {
		idle: async () => {
			while (pending.size) await Promise.all(pending);
		},
	};
}
