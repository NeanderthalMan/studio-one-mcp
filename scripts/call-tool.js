#!/usr/bin/env node
// Dev helper: call one tool on the local server.  node scripts/call-tool.js [tool] ['{json args}']
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [new URL('../src/server.js', import.meta.url).pathname] }));
const [, , tool, args] = process.argv;
if (!tool) console.log((await c.listTools()).tools.map(t => t.name).join(' '));
else { const r = await c.callTool({ name: tool, arguments: JSON.parse(args || '{}') }); console.log(r.isError ? 'ERROR ' : '', r.content[0].text.slice(0, 2500)); }
await c.close();
