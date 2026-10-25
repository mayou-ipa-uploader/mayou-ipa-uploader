import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { javaTool } from './java-tools.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let missing = 0;
function check(label, ready, hint) { console.log(`${ready ? 'OK' : '缺少'}  ${label}${ready ? '' : '：' + hint}`); if (!ready) missing++; }
check('Node.js 22+', Number(process.versions.node.split('.')[0]) >= 22, '安装 Node.js 22 或更新兼容版本');
check('Go', spawnSync('go', ['version']).status === 0, '安装 Go 1.22+');
try { javaTool('java'); javaTool('javac'); javaTool('jar'); check('JDK', true); } catch (error) { check('JDK', false, error.message); }
let electron = ''; try { electron = createRequire(import.meta.url)('electron'); } catch {}
check('Electron', !!electron && existsSync(electron), '运行 npm ci，允许官方 Electron 安装脚本完成下载');
check('本地配置', existsSync(join(root, 'apple-certificate-manager.config.json')), '运行 npm run setup');
check('本地 daemon', existsSync(join(root, 'daemon', process.platform === 'win32' ? 'ipauploader-daemon.exe' : 'ipauploader-daemon')), '运行 npm run setup');
check('上传兼容组件', existsSync(join(root, 'vendor/itms/lib/mayou-upload-guard.jar')), '运行 npm run setup');
console.log('外部依赖：Apple Transporter、码友服务与账户权限需另行准备，doctor 不登录或探测线上账户。');
process.exitCode = missing ? 1 : 0;
