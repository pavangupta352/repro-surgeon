import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { totalCents } from './src/totals.mjs';

const invoice = JSON.parse(readFileSync(new URL('./fixtures/invoice.json', import.meta.url)));
assert.equal(totalCents(invoice.items), 32, 'Line totals must round only once');
