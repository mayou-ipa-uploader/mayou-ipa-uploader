"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const javaBin = process.env.JAVA_TOOLS || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin") : path.join(root, "vendor/itms/java/bin"));
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const java = path.join(javaBin, "java" + executableSuffix);
const javac = path.join(javaBin, "javac" + executableSuffix);
const guard = path.join(root, "vendor/itms/lib/mayou-upload-guard.jar");

// Exercise the actual agent in a JVM against Apple's class/method contract.
// Without the guard this fixture selects version 1.0.2's Build 1.
test("bundled JVM guards repeated Build numbers across versions, and fails closed on an incompatible component", t => {
  if (![java, javac, guard].every(file => fs.existsSync(file))) {
    t.skip("需先准备独立的 Java 与上传兼容组件，见 source/README.md");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sources = {
    "com/apple/transporter/iris/contentdelivery/model/Build.java": `package com.apple.transporter.iris.contentdelivery.model; public class Build { public String getId() { return "NEW-BUILD"; } }`,
    "com/apple/transporter/iris/contentdelivery/api/BuildsApi.java": `package com.apple.transporter.iris.contentdelivery.api;
      public class BuildsApi { public static class BuildsGetCollectionApiRequest {
        public String version; public static class Builder {
          private java.util.List<String> versions;
          public Builder filterPreReleaseVersionVersion(java.util.List<String> value) { versions=value; return this; }
          public BuildsGetCollectionApiRequest build() { BuildsGetCollectionApiRequest r=new BuildsGetCollectionApiRequest(); r.version=versions==null?"1.0.2":versions.get(0); return r; }
        }
      } }`,
    "com/apple/transporter/software/builds/SoftwareUploader.java": `package com.apple.transporter.software.builds;
      import com.apple.transporter.iris.contentdelivery.api.BuildsApi.BuildsGetCollectionApiRequest;
      public class SoftwareUploader {
        private com.apple.transporter.iris.contentdelivery.model.Build build = new com.apple.transporter.iris.contentdelivery.model.Build();
        private BuildsGetCollectionApiRequest findExistingBuild() { return new BuildsGetCollectionApiRequest.Builder().build(); }
        public Object complete() { return null; }
        public static void main(String[] args) { SoftwareUploader u=new SoftwareUploader(); String version=u.findExistingBuild().version;
          if (!"1.0.3".equals(version)) throw new IllegalStateException("Reused old version "+version);
          u.complete(); System.out.println("VERIFIED 1.0.3 (1)"); }
      }`,
  };
  for (const [name, text] of Object.entries(sources)) {
    const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  }
  const compile = () => {
    const r = spawnSync(javac, ["--release", "11", "-d", dir, ...Object.keys(sources).map(name => path.join(dir, name))], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  compile();
  const args = ["-cp", dir, "com.apple.transporter.software.builds.SoftwareUploader"];
  const unguarded = spawnSync(java, args, { encoding: "utf8" });
  assert.notEqual(unguarded.status, 0);
  assert.match(unguarded.stderr, /Reused old version 1.0.2/);
  const guarded = spawnSync(java, [`-javaagent:${guard}`, ...args], { env: { ...process.env, IPAUPLOAD_EXPECTED_VERSION: "1.0.3" }, encoding: "utf8" });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /MSY_UPLOAD_VERSION_SCOPE=1.0.3/);
  assert.match(guarded.stdout, /MSY_UPLOAD_BUILD_ID=NEW-BUILD/);
  const file = path.join(dir, "com/apple/transporter/software/builds/SoftwareUploader.java");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("findExistingBuild", "changedLookup"));
  compile();
  const changed = spawnSync(java, [`-javaagent:${guard}`, ...args], { env: { ...process.env, IPAUPLOAD_EXPECTED_VERSION: "1.0.3" }, encoding: "utf8" });
  assert.equal(changed.status, 78);
  assert.match(changed.stderr, /upload stopped/);
  assert.doesNotMatch(changed.stdout, /VERIFIED/);
});
