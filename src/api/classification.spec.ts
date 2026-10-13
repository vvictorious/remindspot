import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLASSIFICATION_REQUEST_TIMEOUT_MS,
  ClassificationCancelledError,
  ClassificationHttpError,
  ClassificationNetworkError,
  ClassificationTimeoutError,
  InvalidClassificationResponseError,
  classifyItem,
  parseItemClassificationResult,
} from './classification';

const successfulResults = [
  {
    outcome: 'classified',
    categories: ['grocery-store', 'convenience-store'],
    taxonomyVersion: 1,
  },
  {
    outcome: 'no-destination',
    categories: [],
    taxonomyVersion: 1,
  },
  {
    outcome: 'needs-clarification',
    categories: [],
    clarificationQuestion: 'Which kind of charger?',
    taxonomyVersion: 1,
  },
  {
    outcome: 'unsupported-destination',
    categories: [],
    taxonomyVersion: 1,
  },
] as const;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseItemClassificationResult', () => {
  it.each(successfulResults)('parses the $outcome outcome', (result) => {
    expect(parseItemClassificationResult(result)).toEqual(result);
  });

  it('trims a valid clarification question', () => {
    expect(
      parseItemClassificationResult({
        outcome: 'needs-clarification',
        categories: [],
        clarificationQuestion: '  Which kind?  ',
        taxonomyVersion: 1,
      }),
    ).toEqual({
      outcome: 'needs-clarification',
      categories: [],
      clarificationQuestion: 'Which kind?',
      taxonomyVersion: 1,
    });
  });

  it.each([
    null,
    {},
    {
      outcome: 'classified',
      categories: [],
      taxonomyVersion: 1,
    },
    {
      outcome: 'classified',
      categories: ['restaurant'],
      taxonomyVersion: 1,
    },
    {
      outcome: 'classified',
      categories: ['grocery-store', 'grocery-store'],
      taxonomyVersion: 1,
    },
    {
      outcome: 'classified',
      categories: ['grocery-store'],
      taxonomyVersion: 2,
    },
    {
      outcome: 'no-destination',
      categories: ['grocery-store'],
      taxonomyVersion: 1,
    },
    {
      outcome: 'needs-clarification',
      categories: [],
      clarificationQuestion: ' ',
      taxonomyVersion: 1,
    },
    {
      outcome: 'needs-clarification',
      categories: [],
      clarificationQuestion: 'x'.repeat(161),
      taxonomyVersion: 1,
    },
    {
      outcome: 'unsupported-destination',
      categories: [],
      taxonomyVersion: 1,
      extra: true,
    },
  ])('rejects an invalid response: %j', (response) => {
    expect(() => parseItemClassificationResult(response)).toThrow(
      InvalidClassificationResponseError,
    );
  });

  it('accepts every supported category slug', () => {
    expect(
      parseItemClassificationResult({
        outcome: 'classified',
        categories: [
          'grocery-store',
          'convenience-store',
          'pharmacy',
          'pet-store',
          'hardware-store',
          'electronics-store',
          'department-store',
          'clothing-store',
          'auto-parts-store',
          'home-goods-store',
        ],
        taxonomyVersion: 1,
      }),
    ).toMatchObject({ outcome: 'classified' });
  });
});

describe('classifyItem', () => {
  it.each(successfulResults)(
    'returns the $outcome response',
    async (result) => {
      vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://192.168.1.23:3000/');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          }),
        ),
      );

      await expect(classifyItem({ text: 'Milk' })).resolves.toEqual(result);
    },
  );

  it('posts the request to the configured classification endpoint', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://192.168.1.23:3000/');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(successfulResults[0]), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await classifyItem({ text: 'Milk' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://192.168.1.23:3000/classification',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'Milk' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('returns a typed HTTP error with the response status', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://localhost:3000');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 503,
          statusText: 'Service Unavailable',
        }),
      ),
    );

    const error = await classifyItem({ text: 'Milk' }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ClassificationHttpError);
    expect(error).toMatchObject({
      kind: 'http',
      status: 503,
      statusText: 'Service Unavailable',
    });
  });

  it('returns a typed network error and preserves its cause', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://localhost:3000');
    const cause = new TypeError('Network request failed');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));

    const error = await classifyItem({ text: 'Milk' }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ClassificationNetworkError);
    expect(error).toMatchObject({ kind: 'network', cause });
  });

  it('returns a typed invalid-response error for malformed JSON', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://localhost:3000');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('not json', {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      ),
    );

    await expect(classifyItem({ text: 'Milk' })).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('times out and aborts the request after the client deadline', async () => {
    expect(CLASSIFICATION_REQUEST_TIMEOUT_MS).toBe(22_000);
    vi.useFakeTimers();
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://localhost:3000');
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );

    const request = classifyItem({ text: 'Milk' });
    const expectation = expect(request).rejects.toBeInstanceOf(
      ClassificationTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(CLASSIFICATION_REQUEST_TIMEOUT_MS);

    await expectation;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('cancels and aborts the request through the caller signal', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://localhost:3000');
    const callerController = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );

    const request = classifyItem(
      { text: 'Milk' },
      { signal: callerController.signal },
    );
    callerController.abort();

    await expect(request).rejects.toBeInstanceOf(ClassificationCancelledError);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('does not start a request with an already-cancelled signal', async () => {
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://localhost:3000');
    const callerController = new AbortController();
    callerController.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      classifyItem({ text: 'Milk' }, { signal: callerController.signal }),
    ).rejects.toBeInstanceOf(ClassificationCancelledError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cleans up its timer and caller cancellation listener on success', async () => {
    vi.useFakeTimers();
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'http://localhost:3000');
    const callerController = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return Promise.resolve(
          new Response(JSON.stringify(successfulResults[0]), { status: 200 }),
        );
      }),
    );

    await classifyItem({ text: 'Milk' }, { signal: callerController.signal });
    callerController.abort();
    await vi.advanceTimersByTimeAsync(CLASSIFICATION_REQUEST_TIMEOUT_MS);

    expect(requestSignal?.aborted).toBe(false);
  });
});
