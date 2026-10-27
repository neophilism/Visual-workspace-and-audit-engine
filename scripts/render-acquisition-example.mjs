import { writeFile } from 'node:fs/promises';
import { projectAcquisition } from '../dist/acquisition.js';
import { renderWorkspace } from '../dist/index.js';
import { view, fixture } from '../tests/acquisition-helpers.ts';
const snapshot = projectAcquisition(view, fixture(), 'tested');
await writeFile(new URL('../docs/examples/private-acquisition.html', import.meta.url), renderWorkspace(view, snapshot));
