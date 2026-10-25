import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
export function javaTool(name) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const directory = process.env.JAVA_TOOLS || (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin') : '');
  const command = directory ? join(directory, name + suffix) : name;
  if (directory && !existsSync(command)) throw new Error(`缺少 JDK 工具 ${command}`);
  const result = spawnSync(command, [name === 'jar' ? '--version' : '-version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`无法运行 ${name}，请安装 JDK 11+，设置 JAVA_HOME 或 JAVA_TOOLS。`);
  return command;
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败（${result.status}）`);
}
