"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
const restoreSource = main.slice(
  main.indexOf("async function restoreAppleDeveloperNetwork()"),
  main.indexOf("const APPLE_AUTH_TUNNEL_ID", main.indexOf("async function restoreAppleDeveloperNetwork()")),
);

function restoreContext(configure) {
  const context = {
    appleDeveloperAccountKey: "account-a",
    appleDeveloperNetwork: null,
    appleDeveloperNetworkRestoreAttempted: false,
    appleDeveloperNetworkRestoreError: null,
    appleDeveloperNetworkRestorePromise: null,
    appleDeveloperNetworkRestoreAccountKey: "",
    appleDeveloperNetworkFilePath: () => "network.json",
    fs: { readFileSync: () => JSON.stringify({ enabled: true, lastVerifiedIp: "203.0.113.10" }) },
    configureAppleDeveloperNetwork: configure,
    console: { warn() {} },
  };
  vm.runInNewContext(restoreSource, context);
  return context;
}

test("concurrent status and login checks wait for the same proxy restore", async () => {
  let release;
  let configureCount = 0;
  const context = restoreContext(() => {
    configureCount += 1;
    return new Promise(resolve => { release = resolve; });
  });
  const first = context.restoreAppleDeveloperNetwork();
  const second = context.restoreAppleDeveloperNetwork();
  assert.equal(configureCount, 1);
  assert.equal(context.appleDeveloperNetworkRestoreAccountKey, "account-a");

  let secondSettled = false;
  second.then(() => { secondSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondSettled, false);

  release({ ip: "203.0.113.10" });
  await Promise.all([first, second]);
  assert.equal(secondSettled, true);
  assert.equal(context.appleDeveloperNetworkRestorePromise, null);
  assert.equal(context.appleDeveloperNetworkRestoreAccountKey, "");
});

test("a configured network does not bypass an unfinished IP check", async () => {
  let release;
  const context = restoreContext(() => {
    context.appleDeveloperNetwork = { enabled: true, ip: "203.0.113.20" };
    return new Promise(resolve => { release = resolve; });
  });
  const first = context.restoreAppleDeveloperNetwork();
  const second = context.restoreAppleDeveloperNetwork();
  release({ ip: "203.0.113.20" });
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "rejected");
  assert.match(outcomes[1].reason.message, /代理出口 IP 已更换/);
});

test("proxy restore errors reach every waiting login check", async () => {
  let configureCount = 0;
  const context = restoreContext(async () => {
    configureCount += 1;
    throw new Error("代理不可达");
  });
  const outcomes = await Promise.allSettled([
    context.restoreAppleDeveloperNetwork(),
    context.restoreAppleDeveloperNetwork(),
  ]);
  assert.equal(configureCount, 1);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "rejected");
  assert.match(outcomes[1].reason.message, /代理不可达/);
  assert.equal(context.appleDeveloperNetworkRestorePromise, null);
});

test("account changes wait for network restoration and keep old partition connections intact", () => {
  const wait = main.slice(main.indexOf("async function waitForAppleContextRefreshes"), main.indexOf("function randomInt("));
  const launchSwitch = main.slice(main.indexOf("async function applyCertificateManagerLaunchContext"), main.indexOf("async function requireDesktopUserIdentity"));
  const historySwitch = main.slice(main.indexOf("function selectStandaloneLoginHistory"), main.indexOf("function restoreIndependentDeveloperAccount"));
  assert.match(wait, /appleDeveloperNetworkRestorePromise/);
  assert.match(launchSwitch, /await waitForAppleContextRefreshes\(true\)/);
  assert.doesNotMatch(launchSwitch, /previousPartition|closeAllConnections/);
  assert.doesNotMatch(historySwitch, /previousPartition|closeAllConnections/);
});
