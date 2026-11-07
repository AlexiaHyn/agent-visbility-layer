import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const localNode = fileURLToPath(new URL('../node_modules/node-win-x64/bin/node.exe', import.meta.url));
const executable = process.platform === 'win32' && existsSync(localNode) ? localNode : process.execPath;
const child = spawn(executable, process.argv.slice(2), { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: process.env });
let stopping = false;
let stopTimer;
function forceStop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else child.kill('SIGKILL');
}
function stop(signal) {
  if (stopping) return forceStop();
  stopping = true;
  // IPC reaches the server on Windows, where POSIX signal forwarding is unreliable.
  if (child.connected) child.send({ type: 'shutdown', signal }, error => {
    if (error && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  else child.kill('SIGTERM');
  stopTimer = setTimeout(forceStop, 7000);
  stopTimer.unref();
}
for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) {
  process.on(signal, () => stop(signal));
}
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  clearTimeout(stopTimer);
  process.exitCode = stopping ? (code ?? (signal ? 1 : 0)) : (code ?? 1);
});
