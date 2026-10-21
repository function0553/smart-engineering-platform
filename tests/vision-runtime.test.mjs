import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve('.');
const baseSpec = JSON.parse(readFileSync(join(root, 'vision/base-models.json'), 'utf8'));
const specialistSpec = JSON.parse(readFileSync(join(root, 'vision/specialist-models.json'), 'utf8')).smoking;
const python = process.env.VISION_PYTHON_PATH || resolve('.data/ai-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const models = process.env.AI_MODELS_PATH || resolve('.data/ai-models');
const statusCode = `const {modelStatus}=await import('./server/vision-models.mjs'); console.log(JSON.stringify(modelStatus()));`;

function run(code, directory, interpreter = python, extra = {}) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 45000, maxBuffer: 256 * 1024,
    env: { ...process.env, AI_MODELS_PATH: directory, VISION_PYTHON_PATH: interpreter, ...extra },
  });
  assert.equal(child.error, undefined, child.error?.code);
  assert.equal(child.status, 0, `Isolated Node check failed (${child.status})`);
  return JSON.parse(child.stdout.trim());
}
function isolatedModels(t) {
  const directory = mkdtempSync(join(tmpdir(), 'smart-runtime-test-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), 'smart-runtime-test-')));
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(join(directory, 'smoking'));
  for (const file of baseSpec.models) {
    assert.ok(existsSync(join(models, file.name)), 'Prepare the controlled model set before running runtime acceptance');
    copyFileSync(join(models, file.name), join(directory, file.name));
  }
  for (const file of specialistSpec.files) copyFileSync(join(models, 'smoking', file.name), join(directory, 'smoking', file.name));
  if (existsSync(join(models, 'smoking/runtime.json'))) copyFileSync(join(models, 'smoking/runtime.json'), join(directory, 'smoking/runtime.json'));
  return directory;
}
function noPrivateDiagnostics(value, directory, interpreter) {
  const text = JSON.stringify(value);
  for (const secret of [directory, interpreter, 'Traceback', 'ModuleNotFoundError', 'site-packages']) assert.ok(!text.includes(secret), 'Native diagnostics and private interpreter/model paths must not reach the API');
}

test('controlled weights and the actual interpreter are ready without a downloaded manifest', t => {
  const directory = isolatedModels(t);
  const status = run(statusCode, directory);
  assert.equal(status.weightsVerified, true);
  assert.equal(status.installed, true);
  assert.equal(status.runtimeProbe.base.ready, true);
  assert.equal(status.runtimeProbe.versions.numpy, '2.2.6');
  assert.equal(status.runtimeProbe.versions.opencv, '4.12.0');
  assert.equal(status.runtimeProbe.versions.paddle, '3.2.2');
  assert.equal(status.algorithms.find(a => a.id === 'smoking').status, 'installed');
  assert.equal(status.modelCount, 4);
  noPrivateDiagnostics(status, directory, python);
});

test('a forged downloaded manifest cannot authorize different model bytes', t => {
  const directory = isolatedModels(t), entry = baseSpec.models[0];
  const bytes = readFileSync(join(directory, entry.name)); bytes[0] ^= 1;
  writeFileSync(join(directory, entry.name), bytes);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ models: baseSpec.models.map(m => m.name === entry.name ? { ...m, sha256: createHash('sha256').update(bytes).digest('hex') } : m) }));
  const status = run(statusCode, directory);
  assert.equal(status.models.find(m => m.name === entry.name).installed, false);
  assert.equal(status.weightsVerified, false);
  assert.equal(status.installed, false);
});

test('file presence does not make a missing interpreter or real bare venv ready', t => {
  const directory = isolatedModels(t), absent = join(directory, 'private-missing-interpreter');
  const missing = run(statusCode, directory, absent);
  assert.equal(missing.weightsVerified, true);
  assert.equal(missing.installed, false);
  assert.deepEqual(missing.runtimeProbe.errors, ['vision_python_missing']);
  noPrivateDiagnostics(missing, directory, absent);
  const venv = join(directory, 'bare-runtime');
  const creation = spawnSync(python, ['-m', 'venv', '--without-pip', venv], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(creation.status, 0, 'The isolated dependency-free venv must be created by the real interpreter');
  const barePython = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  assert.ok(existsSync(barePython));
  const bare = run(statusCode, directory, barePython);
  assert.equal(bare.weightsVerified, true);
  assert.equal(bare.installed, false);
  assert.equal(bare.runtimeProbe.base.ready, false);
  assert.ok(bare.runtimeProbe.errors.includes('numpy_import_failed'));
  assert.ok(bare.runtimeProbe.errors.includes('opencv_import_failed'));
  assert.ok(bare.runtimeProbe.errors.includes('paddle_import_failed'));
  noPrivateDiagnostics(bare, directory, barePython);
});

test('same-process model checksum and readiness caches invalidate on corruption', t => {
  const directory = isolatedModels(t);
  const result = run(`
    import {readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const {modelStatus,baseSpec}=await import('./server/vision-models.mjs');
    const before=modelStatus();
    const path=join(process.env.AI_MODELS_PATH,baseSpec.models[0].name);
    const bytes=readFileSync(path); bytes[0]^=1; writeFileSync(path,bytes);
    const after=modelStatus();
    bytes[0]^=1; writeFileSync(path,bytes);
    const restored=modelStatus();
    console.log(JSON.stringify({before,after,restored}));`, directory);
  assert.equal(result.before.installed, true);
  assert.equal(result.after.installed, false);
  assert.equal(result.after.weightsVerified, false);
  assert.equal(result.after.models[0].installed, false);
  assert.equal(result.restored.installed, true);
  assert.equal(result.restored.weightsVerified, true);
  assert.notEqual(result.before.runtimeProbe.checkedAt, result.after.runtimeProbe.checkedAt);
  noPrivateDiagnostics(result, directory, python);
});

test('authenticated model-status API reports safe readiness errors without private paths', t => {
  const directory = isolatedModels(t), absent = join(directory, 'private-account-runtime');
  const response = run(`
    import {createServer} from 'node:http'; import {randomBytes} from 'node:crypto';
    import {join} from 'node:path'; const {createApp}=await import('./server/app.mjs');
    const server=createServer(); await new Promise(done=>server.listen(0,'127.0.0.1',done));
    const baseUrl='http://127.0.0.1:'+server.address().port;
    const {app,store,vision}=createApp({database:':memory:',baseUrl,filesDir:join(process.env.AI_MODELS_PATH,'api-isolated'),distPath:join(process.env.AI_MODELS_PATH,'no-dist')});
    server.on('request',app);
    try {
      const unauthorized=await fetch(baseUrl+'/api/video/models');
      const setup=await fetch(baseUrl+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json','X-Workspace-Request':'1'},body:JSON.stringify({organization:'隔离运行环境测试',username:'runtime-test',name:'测试管理员',password:randomBytes(24).toString('hex')})});
      if(setup.status!==201) throw Error('isolated_setup_failed');
      const cookie=setup.headers.get('set-cookie').split(';')[0];
      const result=await fetch(baseUrl+'/api/video/models',{headers:{cookie}});
      console.log(JSON.stringify({anonymousStatus:unauthorized.status,status:result.status,data:await result.json()}));
    } finally {vision.close();server.closeAllConnections();await new Promise(done=>server.close(done));store.close();}`, directory, absent);
  assert.equal(response.anonymousStatus, 401);
  assert.equal(response.status, 200);
  assert.equal(response.data.installed, false);
  assert.equal(response.data.runtimeProbe.runtimeError, 'vision_python_missing');
  noPrivateDiagnostics(response, directory, absent);
});
