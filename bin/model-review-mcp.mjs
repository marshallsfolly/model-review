#!/usr/bin/env node
// model-review's MCP server, for Claude Code and other MCP clients: stdio, newline-delimited JSON-RPC.
//   claude mcp add --scope user model-review -- node /path/to/model-review/bin/model-review-mcp.mjs

import { serveMcp } from '../lib/mcp.mjs';

const server = serveMcp(process.stdin, process.stdout);
// (when the client closes stdin, answer what is in hand, then stop)
process.stdin.on('end', () => server.idle().then(() => process.exit(0)));
