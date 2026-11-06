import { expect, it } from 'vitest';
import { RegenerationFixture } from './model-regeneration-fixture.js';

it('[BT_M31] repairs an empty answer and non-string status without coercing rejected values', async () => {
  const fixture = new RegenerationFixture('assistance');
  fixture.replies = [
    { type: 'answer', text: '', status: { toString: null } },
    { type: 'answer', text: 'Complete review', status: 'success' },
  ];

  try {
    await fixture.run();
    await fixture.run(); // Consume the saved assistance result without another model request.

    expect(fixture.requests).toHaveLength(2);
    expect(fixture.repairs).toHaveLength(1);
    expect(fixture.h.context().assists[0]).toMatchObject({ status: 'success', answer: 'Complete review' });
    const feedback = JSON.parse(fixture.requests[1]!.messages.at(-1)!.content);
    expect(feedback.fieldRequirements.status).toBe('Omit status or use success, partial, or failed.');
    expect(JSON.stringify(feedback)).not.toContain('toString');
  } finally {
    fixture.close();
  }
});
