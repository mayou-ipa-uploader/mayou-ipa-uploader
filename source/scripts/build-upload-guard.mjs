import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { javaTool, run } from './java-tools.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const javac = javaTool('javac'), jar = javaTool('jar');
const dependency = join(root, 'vendor/ipa-upload-guard/asm-9.7.1.jar');
const expected = '8cadd43ac5eb6d09de05faecca38b917a040bb9139c7edeb4cc81c740b713281';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (!existsSync(dependency)) {
  const response = await fetch('https://repo.maven.apache.org/maven2/org/ow2/asm/asm/9.7.1/asm-9.7.1.jar', { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`ASM 下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== expected) throw new Error('ASM SHA-256 校验失败');
  mkdirSync(dirname(dependency), { recursive: true });
  writeFileSync(dependency + '.partial', bytes);
  renameSync(dependency + '.partial', dependency);
}
if (digest(readFileSync(dependency)) !== expected) throw new Error('ASM SHA-256 校验失败，请移除本地缓存后重试');
const temp = mkdtempSync(join(tmpdir(), 'mayou-upload-guard-'));
try {
  run(javac, ['--release', '11', '-cp', dependency, '-d', temp, join(root, 'scripts/java/TransporterBuildGuard.java')]);
  run(jar, ['xf', dependency], { cwd: temp });
  rmSync(join(temp, 'module-info.class'), { force: true });
  const manifest = join(temp, 'guard-manifest.txt');
  writeFileSync(manifest, 'Manifest-Version: 1.0\nPremain-Class: com.mayou.upload.TransporterBuildGuard\n\n');
  const output = join(root, 'vendor/itms/lib'); mkdirSync(output, { recursive: true });
  run(jar, ['cfm', join(output, 'mayou-upload-guard.jar'), manifest, '-C', temp, 'com', '-C', temp, 'org']);
  copyFileSync(join(root, 'vendor/ipa-upload-guard/LICENSE.txt'), join(output, 'mayou-upload-guard-LICENSE.txt'));
  console.log('上传兼容组件编译完成（Java 11 字节码），未下载或执行 Apple 上传器。');
} finally { rmSync(temp, { recursive: true, force: true }); }
