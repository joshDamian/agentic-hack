import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveTypesVersion } from './typediff.js';

export interface CompileError {
  file: string;
  line: number;
  message: string;
}

export interface CompileCheckResult {
  errors: CompileError[];
  ran: boolean;
}

// Resolve tsc from our own project so the temp dir doesn't need typescript installed
const TSC_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..', '..', '..', 'node_modules', '.bin', 'tsc',
);

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
  },
};

export async function compileCheck(
  packageName: string,
  newVersion: string,
  sourceFiles: Map<string, string>,
): Promise<CompileCheckResult> {
  if (sourceFiles.size === 0) return { errors: [], ran: false };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depbot-cc-'));

  try {
    const deps: Record<string, string> = { [packageName]: newVersion, '@types/node': '*' };
    const typesPackage = `@types/${packageName.replace('@', '').replace('/', '__')}`;
    const major = newVersion.split('.')[0];
    const typesVer = resolveTypesVersion(typesPackage, major);
    if (typesVer) deps[typesPackage] = typesVer;
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'compile-check', private: true, dependencies: deps }),
    );
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify(TSCONFIG));

    for (const [filePath, content] of sourceFiles) {
      const dest = path.join(tmpDir, path.basename(filePath));
      fs.writeFileSync(dest, content);
    }

    try {
      execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: tmpDir, encoding: 'utf-8', timeout: 60_000, stdio: 'pipe',
      });
    } catch {
      return { errors: [], ran: false };
    }

    let tscOutput = '';
    try {
      execFileSync(TSC_PATH, ['--noEmit'], {
        cwd: tmpDir, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
      });
      return { errors: [], ran: true };
    } catch (err: any) {
      tscOutput = err.stdout ?? '';
    }

    const errors = parseTscErrors(tscOutput, packageName, sourceFiles);
    return { errors, ran: true };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseTscErrors(
  output: string,
  packageName: string,
  sourceFiles: Map<string, string>,
): CompileError[] {
  const sourceBasenames = new Set([...sourceFiles.keys()].map((f) => path.basename(f)));
  const errors: CompileError[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const match = line.match(/^(.+?)\((\d+),\d+\):\s*error\s+TS\d+:\s*(.+)/);
    if (!match) continue;

    const [, file, lineStr, message] = match;
    const basename = path.basename(file);

    if (!sourceBasenames.has(basename)) continue;
    if (isNoiseError(message, packageName)) continue;

    const originalPath = [...sourceFiles.keys()].find((f) => path.basename(f) === basename) ?? file;
    const cleanMessage = message.replace(/["']\/[^"']*\/node_modules\//g, '"');
    errors.push({ file: originalPath, line: parseInt(lineStr, 10), message: cleanMessage });
  }

  return errors;
}

function isNoiseError(message: string, packageName: string): boolean {
  if (message.includes('Cannot find module') && !message.includes(packageName)) return true;
  if (message.includes('implicitly has an \'any\' type')) return true;
  if (message.includes('Cannot find name') && !message.includes(packageName)) return true;
  if (message.includes('install type definitions for')) return true;
  return false;
}
