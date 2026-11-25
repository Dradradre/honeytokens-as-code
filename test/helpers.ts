import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createService } from '../src/service.ts';

/** A throwaway git repo plus a throwaway honeytoken home, and a service bound to both. */
export function sandbox(baseUrl = 'https://hooks.example.com') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'honeytoken-'));
  const repo = path.join(root, 'acme-payments');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  };
  const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');
  return { root, repo, home, write, read, service: createService({ home, cwd: repo, baseUrl }) };
}
