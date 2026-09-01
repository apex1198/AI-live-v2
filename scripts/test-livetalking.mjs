import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceRoot = path.join(repositoryRoot, 'services', 'talking-head', 'livetalking');
const python = process.platform === 'win32'
  ? path.join(serviceRoot, '.venv', 'Scripts', 'python.exe')
  : path.join(serviceRoot, '.venv', 'bin', 'python');

if (!existsSync(python)) {
  throw new Error(`LiveTalking test runtime is missing: ${python}. Run the LiveTalking setup first.`);
}

const result = spawnSync(python, [
  '-m',
  'unittest',
  'discover',
  '-s',
  'tests',
  '-p',
  'test_*.py',
  '-v',
], {
  cwd: serviceRoot,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
