import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const java = process.env.REPORT_JAVA_HOME || '/Users/chaofan/Documents/CodexMigration/runtime/java21/jdk-21.0.12.1+1/Contents/Home';
const platform = process.env.REPORT_ANDROID_PLATFORM || '/Users/chaofan/Documents/CodexMigration/runtime/android-sdk-mac/platforms/android-35/android.jar';
const tools = process.env.REPORT_ANDROID_TOOLS || '/Users/chaofan/Documents/CodexMigration/runtime/android-sdk-mac/build-tools/35.0.0';
const available = existsSync(path.join(java, 'bin/javac')) && existsSync(platform) && existsSync(path.join(tools, 'lib/d8.jar'));

test('actual native save and camera result branches handle provider failures without false success or stale photos', {
  skip: available ? false : 'Host Java/Android SDK required; this is not physical-device validation',
  timeout: 45000,
}, () => {
  const python = process.env.REPORT_PYTHON || '/Users/chaofan/Documents/CodexMigration/runtime/venv/bin/python';
  const result = spawnSync(existsSync(python) ? python : 'python3', ['scripts/native-media-check.py'], { cwd: root, encoding: 'utf8', timeout: 40000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(readFileSync(path.join(root, 'outputs/app-stability-audit-20261021/native-fix/receipt.json'), 'utf8'));
  for (const key of ['passed', 'actualMainActivityResultBranchExecuted', 'saveCallbacksOnce', 'writeFlushAndCloseFailureNeverSaved', 'failedOutputDeletedOrTruncated', 'originalSaveBytesUnchanged', 'oldCaptureNotReturned', 'successfulCaptureKeptReadable', 'independentCaptureBytes', 'externalCameraGrantsRevoked', 'androidAllJavaCompiled', 'minApi26D8Passed']) assert.equal(receipt[key], true, key);
  assert.equal(receipt.saveProviderCasesPassed, 7);
  assert.equal(receipt.captureCasesPassed, 6);
  assert.equal(receipt.providerBoundaryCasesPassed, 5);
  assert.equal(receipt.pickerCasesPassed, 3);
  assert.equal(receipt.physicalPhoneTested, false);
  assert.equal(receipt.productionConnected, false);
  assert.equal(receipt.signedOrPublished, false);
});
