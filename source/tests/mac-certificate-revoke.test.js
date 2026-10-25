const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("Mac certificate revocation uses Apple's REST endpoint without a type parameter", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const handlerStart = main.indexOf('ipcMain.handle("apple-developer-revoke-certificate",');
  const handler = main.slice(handlerStart, main.indexOf("function appleDeveloperNetworkFilePath", handlerStart));
  const macRoute = handler.slice(handler.indexOf("const isMacCertificate"), handler.indexOf("const referer"));
  const deleteHeaders = macRoute.slice(macRoute.indexOf("const headers ="), macRoute.indexOf("const warmCertificateRevokeSession"));

  assert.ok(handlerStart >= 0);
  assert.match(macRoute, /item\.id === typeId && String\(item\.platform \|\| ""\)\.toLowerCase\(\) === "macos"/);
  assert.match(macRoute, /services-account\/v1\/certificates\/\$\{encodeURIComponent\(certificateId\)\}/);
  assert.match(macRoute, /const requestBody = \{ teamId: team\.id \};/);
  assert.match(macRoute, /certificateTypeId,certificateTypeName,displayName,platform/);
  assert.match(macRoute, /"X-HTTP-Method-Override": "GET"/);
  assert.match(macRoute, /const warmCertificateRevokeSession = async \(\)/);
  assert.match(macRoute, /csrf: String\(detailResponse\.headers\.get\("csrf"\) \|\| ""\)/);
  assert.match(macRoute, /headers: \{ \.\.\.headers, csrf: sessionWarmup\.csrf, csrf_ts: sessionWarmup\.csrfTimestamp \}/);
  assert.match(macRoute, /"X-HTTP-Method-Override": "DELETE"/);
  assert.match(macRoute, /await ses\.closeAllConnections\(\);/);
  assert.match(macRoute, /if \(response\.status === 421\)/);
  assert.doesNotMatch(macRoute, /fetchAppleDeveloperCreateViaOriginalSocks/);
  assert.doesNotMatch(deleteHeaders, /Origin:/);
  assert.doesNotMatch(macRoute, /type:\s*typeId/);
  assert.match(handler, /QH65B2\/account\/ios\/certificate\/revokeCertificate\.action/);
});
