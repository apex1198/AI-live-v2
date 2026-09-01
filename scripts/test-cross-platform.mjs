import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const requiredFiles = [
  'setup_macos.sh',
  'start_macos.sh',
  'setup_windows.ps1',
  'start_windows.ps1',
  'services/qwen-tts/run_worker.bat',
  'services/qwen-tts/server_windows.py',
  'services/qwen-tts/setup_windows.ps1',
  'services/talking-head/livetalking/run_worker.bat',
  'services/talking-head/livetalking/setup_windows.ps1',
];

for (const file of requiredFiles) statSync(file);

const runtime = readFileSync('services/runtime-server/src/index.ts', 'utf8');
if (!runtime.includes("process.platform === 'win32' ? 'run_worker.bat' : 'run_worker.sh'")) {
  throw new Error('Runtime does not select platform-specific engine launchers');
}

const compile = spawnSync('python3', ['-m', 'py_compile', 'services/qwen-tts/server_windows.py'], {
  encoding: 'utf8',
});
if (compile.status !== 0) throw new Error(compile.stderr || 'Windows Qwen server failed Python syntax validation');

console.log('Cross-platform launchers and Windows Qwen backend validated.');
