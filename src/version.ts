import fs from 'node:fs';

/** Read from package.json (../ from both src/ and dist/), so the CLI, MCP server and templates never drift from it. */
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };

export const VERSION: string = pkg.version;
export const PACKAGE_NAME: string = pkg.name;
