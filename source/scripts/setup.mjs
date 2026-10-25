import { copyFileSync, existsSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './java-tools.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = join(root, 'apple-certificate-manager.config.json');
if (!existsSync(config)) {
  copyFileSync(join(root, 'apple-certificate-manager.config.example.json'), config, constants.COPYFILE_EXCL);
  console.log('已创建本地配置；生产服务地址可自行修改。');
} else console.log('保留已有本地配置。');
run('go', ['build', '-o', process.platform === 'win32' ? 'ipauploader-daemon.exe' : 'ipauploader-daemon', '.'], { cwd: join(root, 'daemon') });
run(process.execPath, [join(root, 'scripts/build-upload-guard.mjs')], { cwd: root });
console.log('本地服务与上传兼容组件已准备。运行 npm run doctor 检查环境。');
