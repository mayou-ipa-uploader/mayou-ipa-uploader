import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let electron;
try { electron = createRequire(import.meta.url)('electron'); }
catch { console.error('Electron 未安装完整，请先运行 npm ci（不要使用 --ignore-scripts），然后 npm run setup。'); process.exit(1); }
const env = { ...process.env, IPAUPLOADER_CERT_MANAGER_ONLY: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
