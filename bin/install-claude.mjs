#!/usr/bin/env node
// Set model-review up for Claude Code: link the skill into the skills folder, then print (never run) the command that
// registers the MCP server, and a config snippet for other MCP clients. Run it again any time; it changes nothing
// that is already in place.

import { symlinkSync, lstatSync, readlinkSync, mkdirSync, accessSync, constants } from 'node:fs';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skill = join(repo, 'skill', 'model-review');
const skillsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills');
const link = join(skillsDir, 'model-review');
const mcp = join(repo, 'bin', 'model-review-mcp.mjs');

/** Whether a program is on the PATH. @param {string} name */
function onPath(name) {
	const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
	return (process.env.PATH || '').split(delimiter).some((d) =>
		exts.some((ext) => {
			try {
				accessSync(join(d, name + ext), constants.X_OK);
				return true;
			} catch {
				return false;
			}
		}),
	);
}

mkdirSync(skillsDir, { recursive: true });
let existing = null;
try {
	existing = lstatSync(link);
} catch (e) {
	if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
}
if (!existing) {
	symlinkSync(skill, link, process.platform === 'win32' ? 'junction' : 'dir');
	console.log(`Linked the skill: ${link} -> ${skill}`);
} else if (existing.isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === skill) {
	console.log(`The skill is already linked: ${link}`);
} else {
	console.error(`${link} already exists and isn't a link to this skill. Move it away and run this again.`);
	process.exit(1);
}

console.log(`
To give Claude Code the MCP tools for every project, run this yourself:

  claude mcp add --scope user model-review -- node ${mcp}
`);
if (!onPath('node')) {
	console.log(`node isn't on this PATH, so Claude Code may not find it either. Give its full path in place of "node"${
		onPath('nix') ? `, or let Nix provide it:\n\n  claude mcp add --scope user model-review -- nix shell nixpkgs#nodejs_22 -c node ${mcp}\n` : '.\n'
	}`);
}
console.log(`Other MCP clients (Claude Desktop, Cursor, VS Code, …) take a stdio server entry like this:

${JSON.stringify({ mcpServers: { 'model-review': { command: 'node', args: [mcp] } } }, null, 2)}
`);
