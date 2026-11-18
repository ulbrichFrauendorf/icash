import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import electron from 'electron';

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, ICASH_DEV_DATA: resolve('local-data/dev') },
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
