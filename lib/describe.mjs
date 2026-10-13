// Notes in words, for the CLI and the MCP server: where a pin is, the pose it was pinned in, and the note in full with
// the paths of its images.

import { describePose, fmtLen } from '../app/action.js';
import { noteState } from './review.mjs';

/** @typedef {import('./review.mjs').Note} Note */
/** @typedef {import('./project.mjs').Model} Model */

/** A node's label from the model's parts, else its name. @param {Model | undefined} model @param {string} node */
export function partLabel(model, node) {
	return model?.parts?.[node] || node;
}

/** @param {number[]} p */
const point = (p) => `x ${fmtLen(p[0])}, y ${fmtLen(p[1])}, z ${fmtLen(p[2])}`;

/** Where a note is pinned, in one line. @param {Note} note @param {Model | undefined} model */
export function whereText(note, model) {
	if (!note.node && !note.world) return 'on the whole model';
	const part = note.node ? partLabel(model, note.node) : 'the model';
	return `${part}${note.node && part !== note.node ? ` (node ${note.node})` : ''} at ${note.world ? point(note.world) : '?'}${note.radius ? `, ${fmtLen(note.radius)} round` : ''}`;
}

/** The action's pose a note was pinned in, or null. @param {Note} note @param {Model | undefined} model */
export function poseText(note, model) {
	if (!model?.action || typeof note.k !== 'number') return null;
	const { state, moves } = describePose(model.action, note.k, (p) => partLabel(model, p));
	return [`k = ${note.k}`, state, moves.join(', ')].filter(Boolean).join(' · ');
}

/** Each note's number on its model (1 for the first pinned), as the page shows them. @param {Note[]} notes */
export function numbers(notes) {
	/** @type {Map<string, number>} */
	const out = new Map();
	/** @type {Map<string, number>} */
	const count = new Map();
	for (const n of [...notes].sort((a, b) => (a.at < b.at ? -1 : 1))) {
		const c = (count.get(n.model) || 0) + 1;
		count.set(n.model, c);
		out.set(n.id, c);
	}
	return out;
}

/** @param {string} iso */
const when = (iso) => iso.replace('T', ' ').slice(0, 16) + ' UTC';

/**
 * A note in a few lines, for lists.
 * @param {Note} note @param {Model | undefined} model @param {number | undefined} number
 */
export function noteSummary(note, model, number) {
	const head = `${model?.name || note.model} #${number ?? '?'}  ${note.id}  [${noteState(note)}]  ${note.author || 'someone'}, ${when(note.at)}`;
	const lines = [head, `  ${whereText(note, model)}`];
	if (note.text) lines.push(...note.text.split('\n').map((l) => `  > ${l}`));
	const extras = [];
	if (note.images.length) extras.push(`${note.images.length} image${note.images.length === 1 ? '' : 's'}`);
	if (note.snapshot) extras.push('a snapshot of the view');
	if (note.replies.length) extras.push(`${note.replies.length} repl${note.replies.length === 1 ? 'y' : 'ies'}, the last from ${note.replies.at(-1)?.by === 'agent' ? 'an agent' : 'a person'}`);
	if (extras.length) lines.push(`  (${extras.join('; ')})`);
	return lines.join('\n');
}

/**
 * A note in full: every field an agent needs, the images' paths and the replies.
 * @param {Note} note @param {Model | undefined} model @param {(id: string) => string | null} imagePath
 * @param {number | undefined} number
 */
export function noteDetail(note, model, imagePath, number) {
	const lines = [
		`Note ${note.id}: ${model?.name || note.model} #${number ?? '?'} (model id ${note.model})`,
		`State: ${noteState(note)}${note.status === 'resolved' ? ' (marked fixed)' : ''}`,
		`By ${note.author || 'someone'}, ${when(note.at)}${note.edited ? `, edited ${when(note.edited)}` : ''}`,
		`Where: ${whereText(note, model)}`,
	];
	if (note.node && note.local) lines.push(`  In node ${note.node}'s own frame: [${note.local.join(', ')}] (metres; this point moves with the node)`);
	if (note.world) lines.push(`  In the model's frame as posed: [${note.world.join(', ')}] (metres, glTF y-up)`);
	if (note.radius) lines.push(`  Area: a sphere of radius ${note.radius} m about the point`);
	const pose = poseText(note, model);
	if (pose) lines.push(`Pose: ${pose}`);
	if (note.hidden?.length) lines.push(`Hidden parts: ${note.hidden.map((h) => partLabel(model, h)).join(', ')}`);
	if (note.view) lines.push(`Camera: at [${note.view.pos.join(', ')}] looking at [${note.view.target.join(', ')}]`);
	lines.push('', note.text ? note.text : '(no text: see the images)');
	const images = note.images.map((id) => `  reference: ${imagePath(id) || `${id} (missing)`}`);
	if (note.snapshot) images.push(`  snapshot of the view, the area lit: ${imagePath(note.snapshot) || `${note.snapshot} (missing)`}`);
	if (images.length) lines.push('', 'Images:', ...images);
	if (note.replies.length) {
		lines.push('', 'Replies:');
		for (const r of note.replies) lines.push(`  ${r.by === 'agent' ? `${r.name || 'Agent'} (agent)` : r.name || 'Reviewer'}, ${when(r.at)}:`, ...r.text.split('\n').map((l) => `    ${l}`));
	}
	return lines.join('\n');
}
