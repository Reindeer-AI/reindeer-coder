import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { looksLikeUuid } from './api.js';

describe('looksLikeUuid', () => {
	it('accepts canonical v4 UUID', () => {
		assert.equal(looksLikeUuid('7d2ff0eb-ffbc-45d6-b84b-a2e7ede12416'), true);
	});

	it('accepts uppercase UUID', () => {
		assert.equal(looksLikeUuid('7D2FF0EB-FFBC-45D6-B84B-A2E7EDE12416'), true);
	});

	it('rejects a plain name', () => {
		assert.equal(looksLikeUuid('dani'), false);
	});

	it('rejects a UUID missing a dash', () => {
		assert.equal(looksLikeUuid('7d2ff0ebffbc-45d6-b84b-a2e7ede12416'), false);
	});

	it('rejects a UUID with a trailing character', () => {
		assert.equal(looksLikeUuid('7d2ff0eb-ffbc-45d6-b84b-a2e7ede12416x'), false);
	});

	it('rejects a UUID with a leading character', () => {
		assert.equal(looksLikeUuid('x7d2ff0eb-ffbc-45d6-b84b-a2e7ede12416'), false);
	});

	it('rejects an empty string', () => {
		assert.equal(looksLikeUuid(''), false);
	});
});
