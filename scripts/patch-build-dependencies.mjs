import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
let manifest;
try {
    manifest = require.resolve('picomatch/package.json');
} catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') process.exit(0); // Omitted from production installs.
    throw error;
}

const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
if (version !== '4.0.7') throw new Error('Review the picomatch advisory before changing the pinned build dependency.');

const parser = join(dirname(manifest), 'lib', 'parse.js');
const source = readFileSync(parser, 'utf8');
const anchor = 'const analyzeRepeatedExtglob = (body, options) => {';
const mitigation = [
    anchor,
    '  // iCash build mitigation for GHSA-fc5q-39xc-vjpf.',
    '  // Treat single-branch repeated wildcard patterns as literals.',
    '  if (splitTopLevel(body).length === 1 && /[*?]/.test(body)) {',
    '    return { risky: true };',
    '  }',
].join('\n');
if (!source.includes(mitigation)) {
    if (!source.includes(anchor)) throw new Error('The pinned picomatch parser did not match its expected source.');
    writeFileSync(parser, source.replace(anchor, mitigation));
}

const invensysManifest = require.resolve('invensys-ng/package.json');
const invensys = JSON.parse(readFileSync(invensysManifest, 'utf8'));
if (invensys.version === '23.3.3') {
    const bundle = join(dirname(invensysManifest), invensys.module);
    const tableSource = readFileSync(bundle, 'utf8');
    // ITable mutates its sort inputs without invalidating its computed row list.
    // Refresh that computation so the library still handles sorting and filtering.
    const patches = [
        ['\tprocessedData = computed(() => {\n', '\tsortRevision = signal(0);\n\tprocessedData = computed(() => {\n\t\tthis.sortRevision();\n'],
        ['\t\tthis.onSort.emit({\n\t\t\tfield: this.sortField,', '\t\tthis.sortRevision.update((revision) => revision + 1);\n\t\tthis.onSort.emit({\n\t\t\tfield: this.sortField,'],
    ];
    let patched = tableSource;
    for (const [original, replacement] of patches) {
        if (patched.includes(replacement)) continue;
        if (!patched.includes(original)) throw new Error('The pinned Invensys table did not match its expected source.');
        patched = patched.replace(original, replacement);
    }
    if (patched !== tableSource) writeFileSync(bundle, patched);
}
