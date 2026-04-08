import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { table } from './util.js';

describe('table', () => {
	it('renders headers and rows with consistent column widths', () => {
		const out = table(
			['ID', 'NAME', 'STATUS'],
			[
				['abc', 'short', 'ready'],
				['abcdef', 'longer-name', 'stopped'],
			],
		);
		const lines = out.split('\n');
		assert.equal(lines.length, 3);
		// All lines should have the same visual width since columns are padded.
		assert.equal(lines[0]?.length, lines[1]?.length);
		assert.equal(lines[1]?.length, lines[2]?.length);
	});

	it('handles zero rows', () => {
		const out = table(['A', 'B'], []);
		assert.equal(out, 'A  B');
	});

	it('pads to the widest cell even when only the header is wider', () => {
		const out = table(['LONG_HEADER'], [['x']]);
		const [header, row] = out.split('\n');
		assert.equal(header, 'LONG_HEADER');
		assert.equal(row, 'x          ');
	});

	it('tolerates ragged row arrays (missing trailing cells)', () => {
		const out = table(['A', 'B', 'C'], [['1', '2'], ['3', '4', '5']]);
		const lines = out.split('\n');
		assert.equal(lines.length, 3);
		// Sanity: header + two rows, no crash on undefined cell.
		assert.match(lines[0] ?? '', /^A  B  C\s*$/);
	});
});
