const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

for (const variant of ['证书管理客户端']) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const statusCode = source.slice(source.indexOf('function isCertificateManagerStatusFileRunning()'), source.indexOf('function forceCloseStandaloneCertificateManager()'));
  const slotCode = source.slice(source.indexOf('async function ensureCertificateManagerLaunchSlot('), source.indexOf('function readWindowsRegistryString('));

  test(`${variant}: Windows running certificate manager retains its status`, () => {
    let removed = false;
    const status = { pid: 42, updatedAt: Date.now(), appPath: 'C:\\Program Files\\码友证书管理\\码友证书管理.exe' };
    const sandbox = {
      process: { platform: 'win32' }, path, Date,
      readCertificateManagerStatusFile: () => status,
      isPidRunning: pid => pid === 42,
      certificateManagerStatusPath: () => 'status.json',
      fs: { unlinkSync: () => { removed = true; } },
    };
    vm.runInNewContext(statusCode, sandbox);
    assert.equal(sandbox.isCertificateManagerStatusFileRunning(), true);
    assert.equal(removed, false);
    status.appPath = 'C:\\other.exe';
    assert.equal(sandbox.isCertificateManagerStatusFileRunning(), false);
    assert.equal(removed, true);
  });

  test(`${variant}: replacement waits for process exit after status removal`, async () => {
    let status = { pid: 42, launchMode: 'independent' };
    let alive = true;
    let waits = 0;
    const sandbox = {
      console: { warn() {} },
      isStandaloneCertificateManagerRunning: () => !!status,
      readCertificateManagerStatusFile: () => status,
      forceCloseStandaloneCertificateManager: () => { status = null; },
      isPidRunning: pid => pid === 42 && alive,
      setTimeout: callback => { waits += 1; if (waits === 3) alive = false; callback(); },
    };
    vm.runInNewContext(slotCode, sandbox);
    await sandbox.ensureCertificateManagerLaunchSlot({ id: 'new' });
    assert.equal(waits, 3);
    assert.equal(alive, false);
  });

  test(`${variant}: blocked old process reports failure instead of launching`, async () => {
    let waits = 0;
    const sandbox = {
      console: { warn() {} },
      isStandaloneCertificateManagerRunning: () => true,
      readCertificateManagerStatusFile: () => ({ pid: 42, launchMode: 'independent' }),
      forceCloseStandaloneCertificateManager() {},
      isPidRunning: () => true,
      setTimeout: callback => { waits += 1; callback(); },
    };
    vm.runInNewContext(slotCode, sandbox);
    await assert.rejects(sandbox.ensureCertificateManagerLaunchSlot({}), /旧的证书管理进程仍在运行/);
    assert.equal(waits, 20);
  });

  test(`${variant}: same account reuses existing process`, async () => {
    const sandbox = {
      isStandaloneCertificateManagerRunning: () => true,
      readCertificateManagerStatusFile: () => ({ pid: 42, launchMode: 'browser-bound', accountId: 'same', appleId: 'a@example.com' }),
      forceCloseStandaloneCertificateManager: () => assert.fail('must preserve existing process'),
    };
    vm.runInNewContext(slotCode, sandbox);
    await sandbox.ensureCertificateManagerLaunchSlot({ id: 'same', appleId: 'a@example.com' });
  });
}
