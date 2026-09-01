// Build themes.json (from ThemeData ScriptableObjects) and materials.json
// (material name -> shader + main texture) so the runtime can rebuild Unity
// materials as three.js materials.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import {
  CLASS,
  UNITY_ROOT,
  buildGuidMap,
  fileID,
  parseUnityYaml,
  prefabInstanceTransform,
  vec3,
} from './lib/unity.mjs';
import { modelPath, parsePrefab } from './lib/prefab.mjs';

const DATA_OUT = path.resolve(import.meta.dirname, '../src/data');
mkdirSync(DATA_OUT, { recursive: true });

const guidMap = buildGuidMap();
const assetName = (guid) => {
  const p = guid && guidMap.get(guid);
  return p ? path.basename(p, path.extname(p)) : null;
};
const modelPathOf = (guid) => {
  const p = guid && guidMap.get(guid);
  return modelPath(p);
};
const refGuid = (ref) => ref?.m_AssetGUID ?? ref?.guid ?? null;
const color = (c) => [c?.r ?? 1, c?.g ?? 1, c?.b ?? 1];

const textureUrlOf = (guid) => {
  const asset = guid && guidMap.get(guid);
  if (!asset) return null;
  const ext = path.extname(asset).toLowerCase();
  const name = path.basename(asset, path.extname(asset));
  if (ext === '.tif' || ext === '.tiff') return `textures/${name}.webp`;
  if (ext === '.png' && asset.startsWith('Assets/Textures/')) return `textures/${name}.png`;
  if (ext === '.png' && asset.startsWith('Assets/UI/')) return `ui/${name}.png`;
  throw new Error(`Unsupported material texture ${asset}; add it to convert-textures.mjs`);
};

const shaderFamily = (shader) => {
  switch (shader) {
    case 'CurvedUnlit':
    case 'CurvedRotation':
      return 'curvedOpaque';
    case 'CurvedUnlitAlpha':
      return 'curvedAlpha';
    case 'CurvedUnlitCloud':
      return 'curvedCloud';
    case 'UnlitBlinking':
      return 'blinking';
    case 'VertexColor':
      return 'vertexColor';
    default:
      return 'standard';
  }
};

// The active gameplay sky is parented to the runner and authored as a Sky
// prefab instance. Capture its transform override rather than the UI/menu sky.
const sceneDocs = parseUnityYaml(path.join(UNITY_ROOT, 'Assets/Scenes/Main.unity'));
const skyPrefabGuid = [...guidMap].find(([, asset]) => asset === 'Assets/Prefabs/Sky.prefab')?.[0];
let skyTransform = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] };
for (const entry of sceneDocs.values()) {
  if (entry.classId !== CLASS.PrefabInstance || entry.doc.m_SourcePrefab?.guid !== skyPrefabGuid) continue;
  const candidate = prefabInstanceTransform(entry.doc);
  if (candidate.pos[1] > skyTransform.pos[1]) skyTransform = candidate;
}

// ---- themes.json -------------------------------------------------------------
const themes = {};
for (const rel of fg.sync('Assets/Bundles/Themes/*/themeData.asset', { cwd: UNITY_ROOT })) {
  const docs = parseUnityYaml(path.join(UNITY_ROOT, rel));
  const data = [...docs.values()].find((d) => d.type === 'MonoBehaviour')?.doc;
  if (!data) continue;
  const key = data.themeName === 'Day' ? 'day' : data.themeName === 'NightTime' ? 'night' : data.themeName;
  const cloudPrefabs = [];
  for (const cloudRef of data.cloudPrefabs ?? []) {
    const guid = refGuid(cloudRef);
    const prefabAsset = guid && guidMap.get(guid);
    if (!prefabAsset || !prefabAsset.endsWith('.prefab')) {
      throw new Error(`Unresolved cloud prefab ${guid ?? '<missing-guid>'} in ${rel}`);
    }
    const { root } = parsePrefab(path.join(UNITY_ROOT, prefabAsset), guidMap);
    if (!root) throw new Error(`Cloud prefab has no root: ${prefabAsset}`);
    cloudPrefabs.push({ name: assetName(guid), root });
  }
  themes[key] = {
    name: data.themeName,
    cost: data.cost ?? 0,
    premiumCost: data.premiumCost ?? 0,
    fogColor: color(data.fogColor),
    zones: (data.zones ?? []).map((z) => ({
      length: z.length,
      segments: (z.prefabList ?? []).map((r) => assetName(refGuid(r))).filter(Boolean),
    })),
    skyModel: modelPathOf(data.skyMesh?.guid),
    cloudModels: (data.cloudPrefabs ?? []).map((r) => assetName(refGuid(r))).filter(Boolean),
    cloudPrefabs,
    cloudMinimumDistance: vec3(data.cloudMinimumDistance),
    cloudSpread: vec3(data.cloudSpread),
    cloudNumber: data.cloudNumber ?? 20,
    skyTransform,
    parallaxRatio: 0.8,
    fogStart: 50,
    fogEnd: 80,
  };
}
writeFileSync(path.join(DATA_OUT, 'themes.json'), JSON.stringify(themes, null, 2));

// ---- materials.json ----------------------------------------------------------
const materials = {};
for (const rel of fg.sync('Assets/**/*.mat', { cwd: UNITY_ROOT })) {
  const docs = parseUnityYaml(path.join(UNITY_ROOT, rel));
  const mat = [...docs.values()].find((d) => d.type === 'Material')?.doc;
  if (!mat) continue;

  // Two serialization eras: `- _MainTex: {...}` (modern) and `- first: {name: _MainTex} second: {...}` (older).
  const propEntry = (entry) => {
    if (entry.first?.name !== undefined) return [entry.first.name, entry.second];
    return Object.entries(entry)[0];
  };
  let mainTex = null;
  for (const entry of mat.m_SavedProperties?.m_TexEnvs ?? []) {
    const [prop, value] = propEntry(entry);
    if (prop === '_MainTex' || prop === '_BaseMap') {
      mainTex = textureUrlOf(value?.m_Texture?.guid) ?? mainTex;
    }
  }
  let tint = null;
  for (const entry of mat.m_SavedProperties?.m_Colors ?? []) {
    const [prop, value] = propEntry(entry);
    if (prop === '_Color' || prop === '_BaseColor') tint = color(value);
  }
  const shader = assetName(mat.m_Shader?.guid) ?? 'standard';
  materials[path.basename(rel, '.mat')] = {
    shader,
    shaderFamily: shaderFamily(shader),
    texture: mainTex,
    tint,
  };
}
writeFileSync(path.join(DATA_OUT, 'materials.json'), JSON.stringify(materials));

console.log(`manifest: ${Object.keys(themes).length} themes, ${Object.keys(materials).length} materials`);
