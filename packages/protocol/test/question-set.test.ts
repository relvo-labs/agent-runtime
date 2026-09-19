/**
 * The keyed multi-question contract (ADR-0018).
 *
 * Every assertion here is about a property a host or an adapter is entitled to
 * rely on: batches are ordered, answers are keyed, a batch is answered
 * completely or not at all, and the legacy single-question form is untouched.
 */

import { describe, expect, it } from 'vitest';

import {
  InteractionRequestSchema,
  InteractionResponseSchema,
  QuestionSetRequestSchema,
  QuestionSetResponseSchema,
  WIRE_VERSION,
  checkResponseAgainstRequest,
  type QuestionSetRequest,
} from '../src/index.ts';

const batch: QuestionSetRequest = QuestionSetRequestSchema.parse({
  kind: 'question_set',
  questions: [
    {
      key: 'q1',
      prompt: 'Which database?',
      header: 'Database',
      choices: [
        { value: 'pg', label: 'PostgreSQL' },
        { value: 'sqlite', label: 'SQLite' },
      ],
    },
    {
      key: 'q2',
      prompt: 'Which regions?',
      choices: [
        { value: 'eu', label: 'EU' },
        { value: 'us', label: 'US' },
      ],
      multiSelect: true,
    },
    { key: 'q3', prompt: 'Anything else?' },
  ],
});

describe('question_set request', () => {
  it('is a distinct member of the interaction request union', () => {
    expect(InteractionRequestSchema.parse(batch).kind).toBe('question_set');
    // The legacy form is unchanged and still parses.
    expect(InteractionRequestSchema.parse({ kind: 'question', prompt: 'Continue?' }).kind).toBe('question');
  });

  it('preserves the provider order of the questions', () => {
    expect(batch.questions.map((question) => question.key)).toStrictEqual(['q1', 'q2', 'q3']);
  });

  it('defaults every optional per-question fact conservatively', () => {
    const [first] = batch.questions;
    expect(first?.multiSelect).toBe(false);
    expect(first?.allowFreeText).toBe(false);
    expect(first?.sensitive).toBe(false);
  });

  it('rejects duplicate question keys', () => {
    const result = QuestionSetRequestSchema.safeParse({
      kind: 'question_set',
      questions: [
        { key: 'q1', prompt: 'a' },
        { key: 'q1', prompt: 'b' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('tolerates a repeated choice value, exactly as the legacy form does', () => {
    // A `value` *is* the choice's identity, so two entries sharing one value
    // are one selectable answer shown twice — a display oddity, not an
    // ambiguity. Rejecting here would be stricter than `QuestionRequest`, which
    // ships with the same tolerance.
    const result = QuestionSetRequestSchema.safeParse({
      kind: 'question_set',
      questions: [
        {
          key: 'q1',
          prompt: 'a',
          choices: [
            { value: 'x', label: 'X' },
            { value: 'x', label: 'X again' },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty batch and an unknown property', () => {
    expect(QuestionSetRequestSchema.safeParse({ kind: 'question_set', questions: [] }).success).toBe(false);
    expect(
      QuestionSetRequestSchema.safeParse({
        kind: 'question_set',
        questions: [{ key: 'q1', prompt: 'a', nativeId: 'call-7' }],
      }).success,
    ).toBe(false);
  });
});

describe('question_set response', () => {
  const answer = (answers: Record<string, unknown>): unknown => ({ kind: 'question_set', answers });

  it('accepts a complete, well-typed answer set', () => {
    const response = InteractionResponseSchema.parse(
      answer({
        q1: { type: 'selection', values: ['pg'] },
        q2: { type: 'selection', values: ['eu', 'us'] },
        q3: { type: 'text', text: 'nothing else' },
      }),
    );
    expect(checkResponseAgainstRequest(batch, response)).toBeUndefined();
  });

  it('refuses a partial answer set', () => {
    const response = QuestionSetResponseSchema.parse(answer({ q1: { type: 'selection', values: ['pg'] } }));
    expect(checkResponseAgainstRequest(batch, response)).toContain('unanswered');
  });

  it('refuses an answer for a question that was not asked', () => {
    const response = QuestionSetResponseSchema.parse(
      answer({
        q1: { type: 'selection', values: ['pg'] },
        q2: { type: 'selection', values: ['eu'] },
        q3: { type: 'text', text: 'x' },
        q4: { type: 'text', text: 'smuggled' },
      }),
    );
    expect(checkResponseAgainstRequest(batch, response)).toContain('was not asked');
  });

  it('refuses an unknown choice value', () => {
    const response = QuestionSetResponseSchema.parse(
      answer({
        q1: { type: 'selection', values: ['mysql'] },
        q2: { type: 'selection', values: ['eu'] },
        q3: { type: 'text', text: 'x' },
      }),
    );
    expect(checkResponseAgainstRequest(batch, response)).toContain('unknown choice');
  });

  it('refuses more than one selection on a single-select question', () => {
    const response = QuestionSetResponseSchema.parse(
      answer({
        q1: { type: 'selection', values: ['pg', 'sqlite'] },
        q2: { type: 'selection', values: ['eu'] },
        q3: { type: 'text', text: 'x' },
      }),
    );
    expect(checkResponseAgainstRequest(batch, response)).toContain('multiple selections');
  });

  it('refuses a repeated selection', () => {
    const response = QuestionSetResponseSchema.parse(
      answer({
        q1: { type: 'selection', values: ['pg'] },
        q2: { type: 'selection', values: ['eu', 'eu'] },
        q3: { type: 'text', text: 'x' },
      }),
    );
    expect(checkResponseAgainstRequest(batch, response)).toContain('repeated');
  });

  it('refuses free text where the question offers only choices', () => {
    const response = QuestionSetResponseSchema.parse(
      answer({
        q1: { type: 'text', text: 'mongo' },
        q2: { type: 'selection', values: ['eu'] },
        q3: { type: 'text', text: 'x' },
      }),
    );
    expect(checkResponseAgainstRequest(batch, response)).toContain('does not accept free text');
  });

  it('accepts free text where the question opted into it', () => {
    const request = QuestionSetRequestSchema.parse({
      kind: 'question_set',
      questions: [
        {
          key: 'q1',
          prompt: 'Which database?',
          choices: [{ value: 'pg', label: 'PostgreSQL' }],
          allowFreeText: true,
        },
      ],
    });
    const response = QuestionSetResponseSchema.parse(answer({ q1: { type: 'text', text: 'mongo' } }));
    expect(checkResponseAgainstRequest(request, response)).toBeUndefined();
  });

  it('refuses selections where the question has no choices', () => {
    const request = QuestionSetRequestSchema.parse({
      kind: 'question_set',
      questions: [{ key: 'q1', prompt: 'Anything else?' }],
    });
    const response = QuestionSetResponseSchema.parse(answer({ q1: { type: 'selection', values: ['x'] } }));
    expect(checkResponseAgainstRequest(request, response)).toContain('offers no choices');
  });

  it('refuses a response whose kind does not match the request', () => {
    expect(checkResponseAgainstRequest(batch, { kind: 'question', answer: 'pg' })).toContain('question_set');
    expect(
      checkResponseAgainstRequest(
        { kind: 'question', prompt: 'Continue?', multiSelect: false },
        {
          kind: 'question_set',
          answers: {},
        },
      ),
    ).toContain('question');
  });
});

describe('wire version', () => {
  it('moved, because a new closed-union member is a break', () => {
    // The exact value is asserted once, in `contract.test.ts`. What matters
    // here is that the batch form did not ship on the line that predates it.
    expect(WIRE_VERSION).not.toBe('0.4');
  });
});
