import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// Exercise the real browser implementation, without importing React/JSX or copying the algorithm into a test fixture.
const source = readFileSync(new URL('../src/EngineeringSiteRecords.tsx', import.meta.url), 'utf8');
const start = source.indexOf('export class SiteFileSha256'), end = source.indexOf('export function EngineeringSiteRecords', start);
assert.ok(start >= 0 && end > start, 'real frontend hashing exports must remain discoverable');
const { SiteFileSha256, hashSiteFile } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source.slice(start, end), { mode: 'strip' })).toString('base64'));
const expected = bytes => createHash('sha256').update(bytes).digest('hex'), MiB = 1048576;

test('real frontend incremental SHA-256 matches known vectors and padding/block boundaries', () => {
  for (const input of [Buffer.alloc(0), Buffer.from('abc'), Buffer.from('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), Buffer.from('现场施工资料：施工日报、监理日报、隐蔽工程图片'), Buffer.alloc(1000000, 97)]) assert.equal(new SiteFileSha256().update(input).digest(), expected(input));
  for (const length of [1, 7, 31, 55, 56, 57, 63, 64, 65, 111, 119, 120, 127, 128, 129, 255, 256, 257, 1023, 1024, 1025]) {
    const bytes = randomBytes(length), h = new SiteFileSha256(); for (const b of bytes) h.update(Uint8Array.of(b)); assert.equal(h.digest(), expected(bytes), 'one-byte updates length ' + length);
  }
});

test('real frontend incremental SHA-256 matches Node crypto for random update sizes across blocks and over one MiB', () => {
  let seed = 0x510e527f; const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (const length of [63, 64, 65, MiB - 1, MiB, MiB + 1, 2 * MiB + 333]) {
    const bytes = randomBytes(length), h = new SiteFileSha256(); let offset = 0;
    h.update(new Uint8Array(0)); while (offset < length) { const count = Math.min(length - offset, next() % 8193 + 1); h.update(bytes.subarray(offset, offset + count)); h.update(new Uint8Array(0)); offset += count; }
    assert.equal(h.digest(), expected(bytes), 'random slices total ' + length);
  }
});

test('real hashSiteFile reads sequential slices of at most one MiB and never requests whole-file arrayBuffer', async () => {
  const bytes = randomBytes(3 * MiB + 97), calls = [], progress = []; let active = 0, maximumActive = 0, wholeFileCalls = 0;
  const file = {
    size: bytes.length,
    async arrayBuffer() { wholeFileCalls++; throw new Error('whole-file arrayBuffer is forbidden for video hashing'); },
    slice(start, end) {
      assert.ok(Number.isInteger(start) && Number.isInteger(end)); assert.ok(end - start <= MiB); assert.ok(start >= 0 && start < bytes.length);
      calls.push([start, Math.min(end, bytes.length)]);
      return { async arrayBuffer() {
        active++; maximumActive = Math.max(maximumActive, active);
        try { await new Promise(resolve => setTimeout(resolve, 1)); const part = bytes.subarray(start, Math.min(end, bytes.length)); return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength); } finally { active--; }
      } };
    },
  };
  assert.equal(await hashSiteFile(file, n => progress.push(n)), expected(bytes));
  assert.equal(wholeFileCalls, 0); assert.equal(maximumActive, 1); assert.equal(active, 0);
  assert.deepEqual(calls, [[0, MiB], [MiB, 2 * MiB], [2 * MiB, 3 * MiB], [3 * MiB, bytes.length]]);
  assert.deepEqual(progress, [MiB, 2 * MiB, 3 * MiB, bytes.length]);
});

test('real hashSiteFile preserves empty and actual Blob results on one MiB slice boundaries', async () => {
  const empty = { size: 0, slice() { throw new Error('empty files require no reads'); }, arrayBuffer() { throw new Error('no whole-file reads'); } };
  assert.equal(await hashSiteFile(empty), expected(Buffer.alloc(0)));
  for (const length of [MiB - 1, MiB, MiB + 1, 2 * MiB]) { const bytes = randomBytes(length); assert.equal(await hashSiteFile(new Blob([bytes])), expected(bytes), 'actual Blob length ' + length); }
});
