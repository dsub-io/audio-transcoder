import { readdir, readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const distUrl = new URL('../examples/vite/dist/', import.meta.url);
const distPath = fileURLToPath(distUrl);
const manifest = JSON.parse(
  await readFile(new URL('.vite/manifest.json', distUrl), 'utf8'),
);
const indexHtml = await readFile(new URL('index.html', distUrl), 'utf8');
const javascript = new Map();

for (const relativePath of await listFiles(distPath)) {
  if (!relativePath.endsWith('.js')) continue;

  const contents = await readFile(new URL(relativePath, distUrl));
  javascript.set(relativePath, {
    bytes: contents.byteLength,
    code: contents.toString('utf8'),
  });
}

const entryRecord = Object.values(manifest).find(
  (record) => record.isEntry === true && record.src === 'index.html',
);

assert(entryRecord, 'Vite manifest does not contain the index.html entry');
assert(
  javascript.has(entryRecord.file),
  `Vite entry is missing: ${entryRecord.file}`,
);

const mainGraph = collectStaticGraph([entryRecord.file]);
const workerReferences = unique(
  [...mainGraph].flatMap((path) =>
    extractWorkerSpecifiers(javascript.get(path).code)
      .map((specifier) => resolveJavascript(path, specifier))
      .filter(Boolean),
  ),
);

assert(workerReferences.length > 0, 'Built entry does not reference a Worker');

const workerMatches = workerReferences
  .map((workerPath) => analyzeWorker(workerPath))
  .filter((analysis) => analysis !== null);

assert(
  workerMatches.length === 1,
  `Expected one codec Worker with separate MP3, FLAC, and resampler imports, found ${workerMatches.length}`,
);

const [{ workerPath, mp3, flac, resampler }] = workerMatches;
const lazyPaths = new Set([
  mp3.dynamicRoot,
  mp3.implementationPath,
  flac.dynamicRoot,
  flac.implementationPath,
  resampler.dynamicRoot,
  resampler.implementationPath,
]);

assert(
  mp3.dynamicRoot !== flac.dynamicRoot,
  'MP3 and FLAC must have separate dynamic import roots',
);
assert(
  mp3.implementationPath !== flac.implementationPath,
  'MP3 and FLAC implementations must be emitted in separate chunks',
);
assert(
  resampler.implementationPath !== mp3.implementationPath &&
    resampler.implementationPath !== flac.implementationPath,
  'The sample-rate converter must be emitted separately from codec implementations',
);

const eagerWorkerGraph = collectStaticGraph([workerPath]);
for (const path of eagerWorkerGraph) {
  const code = javascript.get(path).code;
  assert(
    !exportsRegistration(code, 'registerMp3Encoder') &&
      !code.includes('@mediabunny/mp3-encoder loaded') &&
      !code.includes('AGFzbQE'),
    `Eager Worker graph contains the MP3 encoder implementation or WASM payload: ${path}`,
  );
  assert(
    !exportsRegistration(code, 'registerFlacEncoder') &&
      !code.includes('@mediabunny/flac-encoder loaded') &&
      !code.includes('libFLAC'),
    `Eager Worker graph contains the FLAC encoder implementation or WASM payload: ${path}`,
  );
  assert(
    !classifyResampler(code),
    `Eager Worker graph contains the sample-rate converter or WASM payload: ${path}`,
  );
}

for (const lazyPath of lazyPaths) {
  assert(
    !mainGraph.has(lazyPath),
    `Built app entry statically imports a lazy codec chunk: ${lazyPath}`,
  );
  assert(
    !eagerWorkerGraph.has(lazyPath),
    `Worker statically imports a lazy codec chunk: ${lazyPath}`,
  );
  assert(
    !indexHtml.includes(posix.basename(lazyPath)),
    `index.html eagerly references or preloads a lazy codec chunk: ${lazyPath}`,
  );
}

for (const path of mainGraph) {
  const code = javascript.get(path).code;
  for (const lazyPath of lazyPaths) {
    assert(
      !code.includes(posix.basename(lazyPath)),
      `Built app entry references a lazy codec chunk: ${path} -> ${lazyPath}`,
    );
  }
}

console.log('Verified Vite production Worker codec splitting:');
printAsset('app entry', entryRecord.file);
printAsset('main Worker', workerPath);
printAsset('MP3 lazy chunk', mp3.implementationPath);
printAsset('FLAC lazy chunk', flac.implementationPath);
printAsset('resampler lazy chunk', resampler.implementationPath);

function analyzeWorker(workerPath) {
  const worker = javascript.get(workerPath);
  if (!worker) return null;

  const eagerGraph = collectStaticGraph([workerPath]);
  const dynamicRoots = unique(
    [...eagerGraph].flatMap((path) =>
      extractDynamicImportSpecifiers(javascript.get(path).code)
        .map((specifier) => resolveJavascript(path, specifier))
        .filter(Boolean),
    ),
  );
  const codecMatches = { flac: [], mp3: [] };
  const resamplerMatches = [];

  for (const dynamicRoot of dynamicRoots) {
    const graph = collectStaticGraph([dynamicRoot]);
    for (const implementationPath of graph) {
      const code = javascript.get(implementationPath).code;
      const kind = classifyCodec(code);
      if (kind) {
        codecMatches[kind].push({ dynamicRoot, implementationPath });
      }
      if (classifyResampler(code)) {
        resamplerMatches.push({ dynamicRoot, implementationPath });
      }
    }
  }

  if (
    codecMatches.mp3.length !== 1 ||
    codecMatches.flac.length !== 1 ||
    resamplerMatches.length !== 1
  ) {
    return null;
  }

  return {
    flac: codecMatches.flac[0],
    mp3: codecMatches.mp3[0],
    resampler: resamplerMatches[0],
    workerPath,
  };
}

function classifyCodec(code) {
  if (
    exportsRegistration(code, 'registerMp3Encoder') &&
    code.includes('@mediabunny/mp3-encoder loaded') &&
    code.includes('WebAssembly') &&
    code.includes('AGFzbQE')
  ) {
    return 'mp3';
  }

  if (
    exportsRegistration(code, 'registerFlacEncoder') &&
    code.includes('@mediabunny/flac-encoder loaded') &&
    code.includes('WebAssembly') &&
    code.includes('libFLAC')
  ) {
    return 'flac';
  }

  return null;
}

function classifyResampler(code) {
  return (
    code.includes('dataOut must be at least ceil(srcRatio * dataIn.length) samples long') &&
    code.includes('invalid nChannels submitted') &&
    code.includes('invalid converterType') &&
    code.includes('AudioWorkletGlobalScope')
  );
}

function exportsRegistration(code, exportName) {
  const escapedName = exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\bexport\\s*\\{[^}]*\\b(?:[\\w$]+\\s+as\\s+)?${escapedName}\\b[^}]*\\}`,
  ).test(code);
}

function collectStaticGraph(roots) {
  const visited = new Set();
  const pending = [...roots];

  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;

    const asset = javascript.get(path);
    assert(asset, `JavaScript graph references a missing asset: ${path}`);
    visited.add(path);

    for (const specifier of extractStaticImportSpecifiers(asset.code)) {
      const dependency = resolveJavascript(path, specifier);
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }

  return visited;
}

function resolveJavascript(importerPath, specifier) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  let resolved;

  if (cleanSpecifier.startsWith('/')) {
    resolved = posix.normalize(cleanSpecifier.slice(1));
  } else if (cleanSpecifier.startsWith('.')) {
    resolved = posix.normalize(
      posix.join(posix.dirname(importerPath), cleanSpecifier),
    );
  } else {
    return null;
  }

  assert(
    resolved !== '..' && !resolved.startsWith('../'),
    `Asset reference escapes the Vite output directory: ${specifier}`,
  );
  assert(
    javascript.has(resolved),
    `JavaScript asset does not exist: ${importerPath} -> ${specifier}`,
  );
  return resolved;
}

function extractStaticImportSpecifiers(code) {
  return unique([
    ...extractMatches(
      code,
      /\bimport(?!\s*\()\s*[^"'`;]*?\s*from\s*(["'`])([^"'`]+)\1/g,
    ),
    ...extractMatches(
      code,
      /\bimport(?!\s*\()\s*(["'`])([^"'`]+)\1/g,
    ),
  ]);
}

function extractDynamicImportSpecifiers(code) {
  return extractMatches(
    code,
    /\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
  );
}

function extractWorkerSpecifiers(code) {
  return extractMatches(
    code,
    /\bnew\s+Worker\s*\(\s*new\s+URL\s*\(\s*(["'`])([^"'`]+)\1/g,
  );
}

function extractMatches(code, pattern) {
  return [...code.matchAll(pattern)].map((match) => match[2]);
}

async function listFiles(directory, prefix = '') {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix
      ? posix.join(prefix, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      paths.push(...(await listFiles(`${directory}/${entry.name}`, relativePath)));
    } else if (entry.isFile()) {
      paths.push(relativePath);
    }
  }
  return paths;
}

function printAsset(label, path) {
  const { bytes } = javascript.get(path);
  const kibibytes = (bytes / 1024).toFixed(2);
  console.log(
    `- ${label}: ${path} (${bytes.toLocaleString('en-US')} bytes, ${kibibytes} KiB)`,
  );
}

function unique(values) {
  return [...new Set(values)];
}

function assert(condition, message) {
  if (!condition) throw new Error(`Demo build verification failed: ${message}`);
}
