import { writeFile } from 'node:fs/promises';
import { createAlphaCorrespondenceFixture } from '@accountability/correspondence';
import { renderInbox } from '../dist/inbox.js';
const fixture = createAlphaCorrespondenceFixture();
await writeFile(new URL('../docs/examples/private-inbox.html', import.meta.url), renderInbox(fixture.steps[0].context, fixture.state));
