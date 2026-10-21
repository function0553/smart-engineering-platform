import { spawn } from 'node:child_process';
const children = [
  spawn(process.execPath, ['--watch', 'server/index.mjs'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { for (const child of children) child.kill(); process.exit(); });
for (const child of children) child.on('exit', (code) => { for (const other of children) if (other !== child) other.kill(); process.exit(code ?? 1); });
