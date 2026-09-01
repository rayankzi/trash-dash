// Validate generated runtime data and public asset references. This is part of
// `npm run assets`, so an incomplete Unity extraction cannot ship silently.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { UNITY_ROOT } from './lib/unity.mjs';

const WEB_ROOT = path.resolve(import.meta.dirname, '..');
const DATA_ROOT = path.join(WEB_ROOT, 'src/data');
const PUBLIC_ASSETS = path.join(WEB_ROOT, 'public/assets');
const materials = JSON.parse(readFileSync(path.join(DATA_ROOT, 'materials.json'), 'utf8'));
const themes = JSON.parse(readFileSync(path.join(DATA_ROOT, 'themes.json'), 'utf8'));
const obstacles = JSON.parse(readFileSync(path.join(DATA_ROOT, 'obstacles.json'), 'utf8'));

const errors = [];
const checkedModels = new Set();
const checkedMaterials = new Set();

const isLfsStub = (file) => {
  if (!existsSync(file) || statSync(file).size > 1024) return false;
  return readFileSync(file, 'utf8').startsWith('version https://git-lfs.github.com/spec/v1');
};

function validateNode(node, context) {
  if (node.mesh) {
    if (
      typeof node.mesh.fileID !== 'string' ||
      !/^-?\d+$/.test(node.mesh.fileID) ||
      !node.mesh.guid ||
      !node.mesh.name ||
      !node.mesh.asset
    ) {
      errors.push(`${context}/${node.name}: incomplete exact mesh identity`);
    }
    if (!node.model) {
      const source = node.mesh?.asset && path.join(UNITY_ROOT, node.mesh.asset);
      if (!(source && isLfsStub(source))) errors.push(`${context}/${node.name}: FBX mesh has no runtime model`);
    }
  }
  if (node.model && !checkedModels.has(node.model)) {
    checkedModels.add(node.model);
    const glb = path.join(PUBLIC_ASSETS, `${node.model}.glb`);
    if (!existsSync(glb)) {
      const source = node.mesh?.asset && path.join(UNITY_ROOT, node.mesh.asset);
      if (!(node.model === 'models/Dog' && source && isLfsStub(source))) {
        errors.push(`${context}: missing assets/${node.model}.glb`);
      }
    }
  }
  for (const material of node.materials ?? []) {
    if (typeof material !== 'string' || !material) {
      errors.push(`${context}/${node.name}: empty material slot`);
    } else {
      checkedMaterials.add(material);
      if (!materials[material]) errors.push(`${context}/${node.name}: unknown material ${material}`);
    }
  }
  node.children?.forEach((child) => validateNode(child, `${context}/${node.name}`));
}

const segmentFiles = fg.sync('segments/*/*.json', { cwd: DATA_ROOT }).sort();
if (segmentFiles.length !== 42) errors.push(`expected 42 generated theme segments, found ${segmentFiles.length}`);
for (const rel of segmentFiles) {
  const segment = JSON.parse(readFileSync(path.join(DATA_ROOT, rel), 'utf8'));
  validateNode(segment.root, rel);
}
for (const [theme, definitions] of Object.entries(obstacles)) {
  for (const [name, definition] of Object.entries(definitions)) {
    validateNode(definition.root, `obstacles/${theme}/${name}`);
  }
}
for (const [theme, data] of Object.entries(themes)) {
  if (data.cloudNumber !== 20) errors.push(`${theme}: expected 20 clouds, found ${data.cloudNumber}`);
  if (!Array.isArray(data.cloudPrefabs) || data.cloudPrefabs.length !== 3) {
    errors.push(`${theme}: expected 3 extracted cloud prefab trees`);
  }
  for (const cloud of data.cloudPrefabs ?? []) validateNode(cloud.root, `themes/${theme}/${cloud.name}`);
  if (data.skyModel) {
    checkedModels.add(data.skyModel);
    if (!existsSync(path.join(PUBLIC_ASSETS, `${data.skyModel}.glb`))) {
      errors.push(`${theme}: missing assets/${data.skyModel}.glb`);
    }
  }
}

const allowedFamilies = new Set([
  'curvedOpaque',
  'curvedAlpha',
  'curvedCloud',
  'blinking',
  'vertexColor',
  'standard',
]);
for (const [name, material] of Object.entries(materials)) {
  if (!allowedFamilies.has(material.shaderFamily)) errors.push(`${name}: unknown shaderFamily ${material.shaderFamily}`);
  if (material.texture) {
    if (!/\.(?:webp|png)$/i.test(material.texture)) errors.push(`${name}: texture URL lacks exact web extension`);
    if (!existsSync(path.join(PUBLIC_ASSETS, material.texture))) {
      errors.push(`${name}: missing assets/${material.texture}`);
    }
  }
}

if (errors.length) {
  console.error(`asset validation failed (${errors.length}):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(
    `validation: ${segmentFiles.length} segments, ${checkedModels.size} models, ` +
      `${checkedMaterials.size} referenced materials, 6 cloud prefabs`
  );
}
