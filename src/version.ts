import fs from 'node:fs';

/** Read from package.json (../ from both src/ and dist/), so the CLI and MCP server never drift from it. */
export const VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
