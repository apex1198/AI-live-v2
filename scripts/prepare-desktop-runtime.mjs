import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePackageRoot = path.join(workspaceRoot, 'services', 'runtime-server');
const bundleRoot = path.join(workspaceRoot, 'src-tauri', 'desktop-runtime');
const backendRoot = path.join(bundleRoot, 'backend');
const dashboardRoot = path.join(bundleRoot, 'operator-dashboard');
const qwenTtsRoot = path.join(bundleRoot, 'qwen-tts');
const engineRoot = path.join(bundleRoot, 'engine');
const binRoot = path.join(bundleRoot, 'bin');
const require = createRequire(import.meta.url);

rmSync(bundleRoot, { recursive: true, force: true });
mkdirSync(path.join(backendRoot, 'node_modules'), { recursive: true });

const runtimePackage = JSON.parse(readFileSync(path.join(runtimePackageRoot, 'package.json'), 'utf8'));
cpSync(path.join(runtimePackageRoot, 'package.json'), path.join(backendRoot, 'package.json'));
cpSync(path.join(runtimePackageRoot, 'dist'), path.join(backendRoot, 'dist'), { recursive: true });

const copiedDependencies = new Map();

function resolveDependencyRoot(ownerRoot, dependencyName) {
  let cursor = ownerRoot;
  while (true) {
    const candidates = [
      path.join(cursor, 'node_modules', dependencyName),
      ...(path.basename(cursor) === 'node_modules' ? [path.join(cursor, dependencyName)] : []),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return realpathSync(candidate);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`Could not resolve desktop dependency ${dependencyName} from ${ownerRoot}`);
}

function copyRuntimeDependency(dependencyName, ownerRoot, optional = false) {
  let source;
  try {
    source = resolveDependencyRoot(ownerRoot, dependencyName);
  } catch (error) {
    if (optional) return;
    throw error;
  }
  if (copiedDependencies.has(dependencyName)) return;
  copiedDependencies.set(dependencyName, source);
  const target = path.join(backendRoot, 'node_modules', ...dependencyName.split('/'));
  mkdirSync(target, { recursive: true });
  if (dependencyName.startsWith('@idol/')) {
    cpSync(path.join(source, 'package.json'), path.join(target, 'package.json'));
    cpSync(path.join(source, 'dist'), path.join(target, 'dist'), { recursive: true });
  } else {
    cpSync(source, target, { recursive: true, dereference: true });
  }

  const packageJsonPath = path.join(source, 'package.json');
  if (!existsSync(packageJsonPath)) return;
  const dependencyPackage = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  for (const childName of Object.keys(dependencyPackage.dependencies || {})) {
    copyRuntimeDependency(childName, source, false);
  }
  for (const childName of Object.keys(dependencyPackage.optionalDependencies || {})) {
    copyRuntimeDependency(childName, source, true);
  }
}

for (const dependencyName of Object.keys(runtimePackage.dependencies || {})) {
  copyRuntimeDependency(dependencyName, runtimePackageRoot);
}

function stripDevelopmentFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      stripDevelopmentFiles(absolutePath);
      continue;
    }
    if (entry.name.endsWith('.map') || entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      rmSync(absolutePath, { force: true });
    }
  }
}

stripDevelopmentFiles(backendRoot);
cpSync(path.join(workspaceRoot, 'operator-dashboard'), dashboardRoot, { recursive: true });
mkdirSync(qwenTtsRoot, { recursive: true });
cpSync(path.join(workspaceRoot, 'services', 'qwen-tts', 'server.py'), path.join(qwenTtsRoot, 'server.py'));
const excludedEngineRootEntries = new Set([
  '.git', '.venv', '__pycache__', 'data', 'models', 'outputs', 'results', 'temp', 'tmp',
]);
function includeEngineSource(source, serviceRoot, excludedSuffixes) {
  const relative = path.relative(serviceRoot, source);
  const rootEntry = relative.split(path.sep)[0];
  if (relative && excludedEngineRootEntries.has(rootEntry)) return false;
  if (path.basename(source) === '__pycache__') return false;
  return !excludedSuffixes.some((suffix) => source.endsWith(suffix));
}
const liveTalkingSource = path.join(workspaceRoot, 'services', 'talking-head', 'livetalking');
cpSync(
  liveTalkingSource,
  path.join(engineRoot, 'services', 'talking-head', 'livetalking'),
  {
    recursive: true,
    filter: (source) => includeEngineSource(source, liveTalkingSource, ['.pyc', '.log']),
  },
);
const qwenTtsSource = path.join(workspaceRoot, 'services', 'qwen-tts');
cpSync(
  qwenTtsSource,
  path.join(engineRoot, 'services', 'qwen-tts'),
  {
    recursive: true,
    filter: (source) => includeEngineSource(source, qwenTtsSource, ['.pyc', '.wav']),
  },
);
mkdirSync(binRoot, { recursive: true });
const bundledNode = path.join(binRoot, process.platform === 'win32' ? 'node.exe' : 'node');
cpSync(process.execPath, bundledNode);
if (process.platform !== 'win32') chmodSync(bundledNode, 0o755);
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
if (!ffmpegPath || !existsSync(ffmpegPath)) throw new Error('ffmpeg-static binary is missing; run pnpm install with build scripts enabled');
if (!ffprobePath || !existsSync(ffprobePath)) throw new Error('ffprobe-static binary is missing');
for (const [source, name] of [
  [ffmpegPath, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'],
  [ffprobePath, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'],
]) {
  const target = path.join(binRoot, name);
  cpSync(source, target);
  if (process.platform !== 'win32') chmodSync(target, 0o755);
}

function collectFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(absolutePath, files);
    else files.push(absolutePath);
  }
  return files;
}

const runtimeHash = createHash('sha256');
for (const file of collectFiles(backendRoot).sort()) {
  runtimeHash.update(path.relative(backendRoot, file).split(path.sep).join('/'));
  runtimeHash.update('\0');
  runtimeHash.update(readFileSync(file));
  runtimeHash.update('\0');
}
writeFileSync(path.join(backendRoot, 'runtime-build-id.txt'), `${runtimeHash.digest('hex').slice(0, 16)}\n`);

console.log(`Desktop runtime prepared at ${bundleRoot}`);
