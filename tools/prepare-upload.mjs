import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '待上传仓库');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const selections = [
  '.gitignore', '.github', 'README.md', 'README.en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md', 'SECURITY.md', 'GitHub仓库设置.md', 'tools',
  'docs/images', 'docs/Release-v0.1.388.md', 'docs/源码验证记录.md', 'docs/上传GitHub指南.md',
  'source/src', 'source/tests', 'source/scripts', 'source/assets',
  'source/package.json', 'source/package-lock.json', 'source/tsconfig.json', 'source/README.md',
  'source/apple-certificate-manager.config.example.json', 'source/daemon/main.go', 'source/daemon/go.mod',
  'source/uploader.py', 'source/appstore_providers.py', 'source/appstore_upload_errors.py',
  'source/transporter_locator.py', 'source/vendor/ipa-upload-guard/LICENSE.txt',
];
const collected = [];
function walk(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`拒绝复制符号链接：${relative(root, path)}`);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === '.DS_Store' || entry.startsWith('._') || ['node_modules', '.git', '__pycache__'].includes(entry)) continue;
      walk(join(path, entry));
    }
  } else if (stat.isFile()) collected.push(relative(root, path).split('\\').join('/'));
}
for (const selection of selections) walk(join(root, selection));
const files = collected.sort().map(path => {
  const bytes = readFileSync(join(root, path));
  if (bytes.length > 50 * 1024 * 1024) throw new Error(`文件过大，请放入 Releases：${path}`);
  if (/\.(?:p8|p12|pfx|key|pem|db|sqlite|jar|exe|dmg|zip)$/i.test(path)) throw new Error(`不允许的发布文件：${path}`);
  const text = bytes.toString('utf8');
  // 只扫描常见高置信度模式，不在报错中输出内容。
  const signatures = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /gh[pousr]_[A-Za-z0-9]{30,}/, /AKIA[0-9A-Z]{16}/];
  if (signatures.some(pattern => pattern.test(text))) throw new Error(`发现疑似凭据，请人工检查：${path}`);
  return { path, size: bytes.length, sha256: digest(bytes) };
});
// 如用户已修改导出副本或手工添加文件，停止而不是覆盖。
const marker = join(output, 'docs/release-manifest.json');
if (existsSync(output)) {
  if (!existsSync(marker)) throw new Error('目标目录已存在且没有本工具清单，请保留原目录并重新选择工作位置');
  const previous = JSON.parse(readFileSync(marker, 'utf8'));
  for (const file of previous.files) {
    if (!file.path || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').includes('..') || file.path.split('/').includes('.git')) throw new Error('发布清单存在非法路径，停止覆盖');
  }
  const expected = new Map(previous.files.map(file => [file.path, file]));
  const actual = [];
  function inspect(path) {
    for (const entry of readdirSync(path)) {
      if (entry === '.git' || entry === '.DS_Store') continue;
      const file = join(path, entry), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('目标目录存在符号链接，停止覆盖');
      if (stat.isDirectory()) inspect(file); else actual.push(relative(output, file).split('\\').join('/'));
    }
  }
  inspect(output);
  for (const path of actual) {
    if (path === 'docs/release-manifest.json') continue;
    if (!expected.has(path) || digest(readFileSync(join(output, path))) !== expected.get(path).sha256) throw new Error(`导出副本已被手工修改，停止：${path}`);
  }
  for (const [path] of expected) if (!existsSync(join(output, path))) throw new Error(`导出副本中有文件被删除，停止：${path}`);
  const incoming = new Set(files.map(file => file.path));
  for (const [path] of expected) if (!incoming.has(path)) rmSync(join(output, path));
}
mkdirSync(output, { recursive: true });
for (const file of files) {
  const target = join(output, file.path); mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, file.path), target);
}
const sourceFiles = files.filter(file => file.path.startsWith('source/')).map(file => ({ ...file, path: file.path.slice('source/'.length) }));
const sourceManifest = JSON.stringify({ sourceVersion: '0.1.388', files: sourceFiles }, null, 2) + '\n';
for (const base of [root, output]) { mkdirSync(join(base, 'docs'), { recursive: true }); writeFileSync(join(base, 'docs/source-manifest.json'), sourceManifest); }
files.push({ path: 'docs/source-manifest.json', size: Buffer.byteLength(sourceManifest), sha256: digest(Buffer.from(sourceManifest)) });
writeFileSync(marker, JSON.stringify({ files }, null, 2) + '\n');
console.log(`已导出 ${files.length} 个公开文件到：${output}`);
console.log('未复制安装包、原图、本地配置、依赖和运行时；未创建提交或推送。');
