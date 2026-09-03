// SPIKE — fake-only fixture. Not production code.
//
// panel-sources.mjs — builders for fake panel sources inside the injected
// filesystem port. Every "directory" lives only in the fake fs; nothing is
// created on disk here.
//
// A valid fake panel source is:
//   <root>/<name>/manifest.json   (user-owned, <= 65536 bytes)
//   <root>/<name>/Panel.qml       (user-owned, <= 1048576 bytes)
// with kinds exactly ["panel"] and exactly one panel entry point.

export function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'spike.fixture.console',
    name: 'Fixture Console',
    version: '1.0.0',
    author: 'spike fixtures',
    description: 'fake panel used by seam tests',
    kinds: ['panel'],
    entryPoints: { panel: 'Panel.qml' },
    ...overrides,
  }
}

/** Add a complete valid source directory and return its canonical path. */
export function addValidSource(fs, root, name = 'fixture-console', manifest = validManifest()) {
  const dir = `${root}/${name}`
  fs.addDirectory(dir)
  fs.addFile(`${dir}/manifest.json`, JSON.stringify(manifest))
  fs.addFile(`${dir}/Panel.qml`, '// fake panel item\n')
  return dir
}

/** Add a source with a raw manifest body (for malformed JSON cases). */
export function addRawManifestSource(fs, root, name, rawManifest, extraFiles = {}) {
  const dir = `${root}/${name}`
  fs.addDirectory(dir)
  fs.addFile(`${dir}/manifest.json`, rawManifest)
  for (const [name_, content] of Object.entries(extraFiles)) {
    fs.addFile(`${dir}/${name_}`, content)
  }
  return dir
}

/** A manifest whose serialized form exceeds the 65536-byte bound. */
export function oversizedManifest(id = 'spike.fixture.too-big') {
  return validManifest({ id, description: 'x'.repeat(70000) })
}

/** A plain object nested `depth` levels deep. */
export function nestedObject(depth, leaf = true) {
  let value = leaf
  for (let i = 0; i < depth; i += 1) value = { nested: value }
  return value
}