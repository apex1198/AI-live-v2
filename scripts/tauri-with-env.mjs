import { spawnSync } from 'node:child_process';

const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(executable, ['exec', 'tauri', ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
