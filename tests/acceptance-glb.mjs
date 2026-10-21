import { BoxGeometry } from 'three';

// Technical fixture only; never inserted into the user's normal workspace.
export function acceptanceGlb(external = false) {
  const geometry = new BoxGeometry(12, 6, 8);
  const positions = Buffer.from(geometry.attributes.position.array.buffer);
  const normals = Buffer.from(geometry.attributes.normal.array.buffer);
  const indices = Buffer.from(geometry.index.array.buffer);
  const binary = Buffer.concat([positions, normals, indices]);
  const document = {
    asset: { version: '2.0', generator: 'Smart Workspace isolated acceptance fixture - NOT a real site' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: '验收用几何体（非真实场地）' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [.45, .67, .55, 1], metallicFactor: 0, roughnessFactor: .8 } }],
    buffers: [{ byteLength: binary.length, ...(external ? { uri: 'https://example.invalid/not-allowed.bin' } : {}) }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }, { buffer: 0, byteOffset: positions.length, byteLength: normals.length }, { buffer: 0, byteOffset: positions.length + normals.length, byteLength: indices.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: geometry.attributes.position.count, type: 'VEC3', min: [-6, -3, -4], max: [6, 3, 4] }, { bufferView: 1, componentType: 5126, count: geometry.attributes.normal.count, type: 'VEC3' }, { bufferView: 2, componentType: 5123, count: geometry.index.count, type: 'SCALAR' }],
  };
  const json = Buffer.from(JSON.stringify(document)); const paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const bytes = Buffer.alloc(12 + 8 + paddedJson.length + 8 + binary.length);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(paddedJson.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); paddedJson.copy(bytes, 20);
  const offset = 20 + paddedJson.length; bytes.writeUInt32LE(binary.length, offset); bytes.writeUInt32LE(0x004e4942, offset + 4); binary.copy(bytes, offset + 8); geometry.dispose(); return bytes;
}
