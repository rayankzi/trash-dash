// Extract track-segment, obstacle, and prop-prefab data from Unity YAML into JSON
// the web runtime can consume. Produces:
//   src/data/segments/<theme>/<Name>.json  - path nodes, obstacle spawn data, visual node tree
//   src/data/obstacles.json                - obstacle behaviour type + visual node tree per prefab
//   src/data/props.json                    - shared nested prefabs referenced by segments
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import {
  UNITY_ROOT,
  CLASS,
  buildGuidMap,
  vec3,
  quat,
  fileID,
} from './lib/unity.mjs';
import { assetName as nameOfAsset, parsePrefab } from './lib/prefab.mjs';

const DATA_OUT = path.resolve(import.meta.dirname, '../src/data');
mkdirSync(path.join(DATA_OUT, 'segments'), { recursive: true });

const guidMap = buildGuidMap();
const guidOf = (scriptRel) => {
  const meta = readFileSync(path.join(UNITY_ROOT, scriptRel + '.meta'), 'utf8');
  return meta.match(/^guid: ([0-9a-f]{32})$/m)[1];
};

const TRACK_SEGMENT_GUID = guidOf('Assets/Scripts/Tracks/TrackSegment.cs');
const OBSTACLE_SCRIPTS = {
  [guidOf('Assets/Scripts/Obstacles/SimpleBarricade.cs')]: 'simpleBarricade',
  [guidOf('Assets/Scripts/Obstacles/AllLaneObstacle.cs')]: 'allLane',
  [guidOf('Assets/Scripts/Obstacles/PatrollingObstacle.cs')]: 'patrolling',
  [guidOf('Assets/Scripts/Obstacles/Missile.cs')]: 'missile',
};

const assetName = (guid) => {
  const p = guidMap.get(guid);
  return nameOfAsset(p);
};

/** Referenced source prefabs discovered while walking segments; parsed afterwards. */
const propQueue = new Set();

const parseRuntimePrefab = (filePath) =>
  parsePrefab(filePath, guidMap, { onNestedPrefab: (sourcePath) => propQueue.add(sourcePath) });

/** Path nodes for a TrackSegment: ordered children of pathParent (world-ish local space). */
function extractPath(docs, pathParentFileID) {
  const parentID = typeof pathParentFileID === 'string' ? pathParentFileID : fileID(pathParentFileID);
  const parent = parentID && docs.get(parentID);
  if (!parent) return [];
  const nodes = [];
  for (const child of parent.doc.m_Children ?? []) {
    const t = docs.get(fileID(child));
    if (!t) continue;
    nodes.push({
      order: t.doc.m_RootOrder ?? nodes.length,
      pos: vec3(t.doc.m_LocalPosition),
      rot: quat(t.doc.m_LocalRotation),
    });
  }
  nodes.sort((a, b) => a.order - b.order);
  // pathParent's own transform offsets every node
  const pp = parent.doc;
  return {
    parentPos: vec3(pp.m_LocalPosition),
    parentRot: quat(pp.m_LocalRotation),
    nodes: nodes.map(({ pos, rot }) => ({ pos, rot })),
  };
}

const refGuid = (ref) => ref?.m_AssetGUID ?? ref?.guid ?? null;

function validateRoadCoverage(rel, docs, output) {
  const isRoad = (asset) => /\/Road0[1-4](?:Night)?\.fbx$/i.test(asset ?? '');
  const sourceRoads = [];
  for (const entry of docs.values()) {
    if (entry.classId !== CLASS.MeshFilter) continue;
    const mesh = entry.doc.m_Mesh;
    const id = fileID(mesh);
    const asset = mesh?.guid && guidMap.get(mesh.guid);
    if (id && isRoad(asset)) {
      sourceRoads.push(`${mesh.guid}:${id}`);
    }
  }

  const generatedRoads = [];
  const walk = (node) => {
    if (node.mesh && isRoad(node.mesh.asset)) {
      generatedRoads.push(`${node.mesh.guid}:${node.mesh.fileID}`);
    }
    node.children?.forEach(walk);
  };
  walk(output.root);

  const expected = sourceRoads.sort();
  const actual = generatedRoads.sort();
  if (!expected.length || JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `Road coverage mismatch in ${rel}: source=${expected.length}, generated=${actual.length}`
    );
  }
  if (!output.root.mesh || !isRoad(output.root.mesh.asset)) {
    throw new Error(`Segment ${rel} has no enabled Road01-04 base mesh spanning its authored path`);
  }
  if (output.root.rendererEnabled === false || output.path.nodes.length < 2) {
    throw new Error(`Segment ${rel} cannot provide continuous road coverage from entry to exit`);
  }
}

// ---- Segments ----------------------------------------------------------------
const themeDirs = { Default: 'day', NightTime: 'night' };
let segmentCount = 0;

const segmentPrefabs = fg.sync('Assets/Bundles/Themes/*/{Industrial,Suburbs,Urban}/*.prefab', {
  cwd: UNITY_ROOT,
});
for (const rel of segmentPrefabs) {
  const themeFolder = rel.split('/')[3];
  const theme = themeDirs[themeFolder] ?? themeFolder.toLowerCase();
  const { docs, root, monoBehaviours } = parseRuntimePrefab(path.join(UNITY_ROOT, rel));
  const seg = monoBehaviours.find((d) => d.doc.m_Script?.guid === TRACK_SEGMENT_GUID)?.doc;
  if (!seg || !root) {
    console.warn(`no TrackSegment component in ${rel}, skipping`);
    continue;
  }
  const out = {
    name: path.basename(rel, '.prefab'),
    theme,
    path: extractPath(docs, fileID(seg.pathParent)),
    obstaclePositions: seg.obstaclePositions ?? [],
    possibleObstacles: (seg.possibleObstacles ?? []).map((r) => assetName(refGuid(r))).filter(Boolean),
    root,
  };
  validateRoadCoverage(rel, docs, out);
  const dir = path.join(DATA_OUT, 'segments', theme);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, out.name + '.json'), JSON.stringify(out));
  segmentCount++;
}

// ---- Obstacles ---------------------------------------------------------------
// Both themes use the same obstacle prefab names, so key by theme first.
const obstacles = {};
for (const rel of fg.sync('Assets/Bundles/Themes/*/Obstacles/*.prefab', { cwd: UNITY_ROOT })) {
  const themeFolder = rel.split('/')[3];
  const theme = themeDirs[themeFolder] ?? themeFolder.toLowerCase();
  const { root, monoBehaviours } = parseRuntimePrefab(path.join(UNITY_ROOT, rel));
  if (!root) continue;
  let type = 'simpleBarricade';
  let extra = {};
  for (const mb of monoBehaviours) {
    const t = OBSTACLE_SCRIPTS[mb.doc.m_Script?.guid];
    if (t) {
      type = t;
      if (t === 'patrolling') extra = { minTime: mb.doc.minTime ?? 2, maxTime: mb.doc.maxTime ?? 5 };
      break;
    }
  }
  (obstacles[theme] ??= {})[path.basename(rel, '.prefab')] = { type, ...extra, root };
}
writeFileSync(path.join(DATA_OUT, 'obstacles.json'), JSON.stringify(obstacles));

// ---- Shared props (nested prefabs), resolved recursively ---------------------
const props = {};
const seen = new Set();
for (;;) {
  const pending = [...propQueue].filter((p) => !seen.has(p));
  if (pending.length === 0) break;
  for (const rel of pending) {
    seen.add(rel);
    const abs = path.join(UNITY_ROOT, rel);
    if (!existsSync(abs)) continue;
    const { root } = parseRuntimePrefab(abs); // may add more to propQueue
    if (root) props[path.basename(rel, '.prefab')] = root;
  }
}
writeFileSync(path.join(DATA_OUT, 'props.json'), JSON.stringify(props));

console.log(
  `segments: ${segmentCount} extracted, ${Object.keys(obstacles).length} obstacles, ${Object.keys(props).length} props`
);
