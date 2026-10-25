const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const roots = [
  ["standalone", path.join(__dirname, "..", "src")],
  ["browser", path.join(__dirname, "..", "src")],
];

for (const [variant, sourceRoot] of roots) {
  test(`${variant}: iPad 预览图按原始比例完整显示`, () => {
    const html = fs.readFileSync(path.join(sourceRoot, "certificate-manager.html"), "utf8");

    assert.match(html, /\.app-media-strip\{[^}]*overflow-x:auto/);
    assert.match(html, /figure:not\(\.app-media-uploading\)\{[^}]*width:max-content;[^}]*flex:0 0 auto/);
    assert.match(html, /figure:not\(\.app-media-uploading\) img\{[^}]*width:auto;[^}]*height:222px;[^}]*object-fit:contain/);
  });
}
