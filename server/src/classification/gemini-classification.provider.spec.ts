import {
  BadGatewayException,
  GatewayTimeoutException,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GEMINI_CLASSIFICATION_DEADLINE_MS,
  GEMINI_CLASSIFICATION_MIN_RETRY_BUDGET_MS,
  GEMINI_CLASSIFICATION_MODEL,
} from './gemini-classification-config';
import { GEMINI_CLASSIFICATION_PROMPT_V3 } from './gemini-classification-prompt';
import { GEMINI_CLASSIFICATION_SCHEMA } from './gemini-classification-schema';
import { GeminiClassificationProvider } from './gemini-classification.provider';

const sdk = vi.hoisted(() => ({
  construct: vi.fn(),
  generateContent: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    readonly models = { generateContent: sdk.generateContent };

    constructor(options: unknown) {
      sdk.construct(options);
    }
  },
}));

describe('GeminiClassificationProvider', () => {
  function createProvider(apiKey: string | undefined = 'test-api-key') {
    const config = {
      get: vi.fn().mockReturnValue(apiKey),
    } as unknown as ConfigService;

    return new GeminiClassificationProvider(config);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T17:00:00.000Z'));
    sdk.construct.mockClear();
    sdk.generateContent.mockReset();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends the evaluated model, v3 prompt, JSON schema, and MIME type', async () => {
    const response = {
      outcome: 'classified',
      categories: ['grocery-store'],
      taxonomyVersion: 1,
    };
    sdk.generateContent.mockResolvedValue({ text: JSON.stringify(response) });

    await expect(createProvider().classify('Milk')).resolves.toEqual(response);
    expect(sdk.construct).toHaveBeenCalledWith({ apiKey: 'test-api-key' });
    expect(sdk.generateContent).toHaveBeenCalledWith({
      model: GEMINI_CLASSIFICATION_MODEL,
      contents: 'Milk',
      config: {
        systemInstruction: GEMINI_CLASSIFICATION_PROMPT_V3,
        responseMimeType: 'application/json',
        responseJsonSchema: GEMINI_CLASSIFICATION_SCHEMA,
        abortSignal: expect.any(AbortSignal) as unknown,
        httpOptions: {
          timeout: GEMINI_CLASSIFICATION_DEADLINE_MS,
          retryOptions: { attempts: 1 },
        },
      },
    });
  });

  it('returns 503 without constructing the SDK when the key is missing', async () => {
    await expect(createProvider('').classify('Milk')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(sdk.construct).not.toHaveBeenCalled();
    expect(sdk.generateContent).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   ', '{not-json'])(
    'returns 502 for an empty or malformed response',
    async (text) => {
      sdk.generateContent.mockResolvedValue({ text });

      await expect(createProvider().classify('Milk')).rejects.toEqual(
        new BadGatewayException(
          'Classification provider returned an invalid response',
        ),
      );
      expect(sdk.generateContent).toHaveBeenCalledTimes(1);
    },
  );

  it('enforces one total 20-second deadline', async () => {
    expect(GEMINI_CLASSIFICATION_DEADLINE_MS).toBe(20_000);
    sdk.generateContent.mockReturnValue(new Promise(() => undefined));

    const result = expect(
      createProvider().classify('Milk'),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
    await vi.advanceTimersByTimeAsync(GEMINI_CLASSIFICATION_DEADLINE_MS);

    await result;
    expect(sdk.generateContent).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 408 },
    { code: 'ETIMEDOUT' },
    { status: 'DEADLINE_EXCEEDED' },
  ])('returns 504 for provider timeout errors', async (error) => {
    sdk.generateContent.mockRejectedValue(error);

    await expect(createProvider().classify('Milk')).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
    expect(sdk.generateContent).toHaveBeenCalledTimes(1);
  });

  it('retries one transient network failure', async () => {
    const response = {
      outcome: 'no-destination',
      categories: [],
      taxonomyVersion: 1,
    };
    sdk.generateContent
      .mockRejectedValueOnce(new TypeError('network failed'))
      .mockResolvedValueOnce({ text: JSON.stringify(response) });

    await expect(createProvider().classify('Call Mom')).resolves.toEqual(
      response,
    );
    expect(sdk.generateContent).toHaveBeenCalledTimes(2);
  });

  it.each(['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET'])(
    'retries transient network error %s',
    async (code) => {
      const response = {
        outcome: 'no-destination',
        categories: [],
        taxonomyVersion: 1,
      };
      sdk.generateContent
        .mockRejectedValueOnce({ code })
        .mockResolvedValueOnce({ text: JSON.stringify(response) });

      await expect(createProvider().classify('Call Mom')).resolves.toEqual(
        response,
      );
      expect(sdk.generateContent).toHaveBeenCalledTimes(2);
    },
  );

  it('skips retry when less than the one-second retry budget remains', async () => {
    sdk.generateContent.mockImplementationOnce(() => {
      vi.setSystemTime(
        Date.now() +
          GEMINI_CLASSIFICATION_DEADLINE_MS -
          GEMINI_CLASSIFICATION_MIN_RETRY_BUDGET_MS +
          1,
      );
      return Promise.reject(new TypeError('network failed'));
    });

    await expect(createProvider().classify('Milk')).rejects.toEqual(
      new BadGatewayException('Classification provider request failed'),
    );
    expect(GEMINI_CLASSIFICATION_MIN_RETRY_BUDGET_MS).toBe(1_000);
    expect(sdk.generateContent).toHaveBeenCalledTimes(1);
  });

  it('retries when exactly the one-second retry budget remains', async () => {
    const response = {
      outcome: 'no-destination',
      categories: [],
      taxonomyVersion: 1,
    };
    sdk.generateContent
      .mockImplementationOnce(() => {
        vi.setSystemTime(
          Date.now() +
            GEMINI_CLASSIFICATION_DEADLINE_MS -
            GEMINI_CLASSIFICATION_MIN_RETRY_BUDGET_MS,
        );
        return Promise.reject(new TypeError('network failed'));
      })
      .mockResolvedValueOnce({ text: JSON.stringify(response) });

    await expect(createProvider().classify('Call Mom')).resolves.toEqual(
      response,
    );
    expect(sdk.generateContent).toHaveBeenCalledTimes(2);
  });

  it('returns 503 after the single rate-limit retry is exhausted', async () => {
    sdk.generateContent.mockRejectedValue({ status: 429 });

    await expect(createProvider().classify('Milk')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(sdk.generateContent).toHaveBeenCalledTimes(2);
  });

  it('returns 502 after a transient provider failure exhausts its retry', async () => {
    sdk.generateContent.mockRejectedValue(new TypeError('network failed'));

    await expect(createProvider().classify('Milk')).rejects.toEqual(
      new BadGatewayException('Classification provider request failed'),
    );
    expect(sdk.generateContent).toHaveBeenCalledTimes(2);
  });

  it('returns 502 for a non-transient provider error without retrying', async () => {
    sdk.generateContent.mockRejectedValue({ status: 403 });

    await expect(createProvider().classify('Milk')).rejects.toEqual(
      new BadGatewayException('Classification provider request failed'),
    );
    expect(sdk.generateContent).toHaveBeenCalledTimes(1);
  });

  it('returns 422 for an upstream HTTP 400 without retrying', async () => {
    sdk.generateContent.mockRejectedValue({ status: 400 });

    await expect(createProvider().classify('Milk')).rejects.toEqual(
      new UnprocessableEntityException(
        'Classification provider request failed',
      ),
    );
    expect(sdk.generateContent).toHaveBeenCalledTimes(1);
  });

  it.each([503, 504])(
    'retries upstream HTTP %s and returns 502 when the retry is exhausted',
    async (status) => {
      sdk.generateContent.mockRejectedValue({ status });

      await expect(createProvider().classify('Milk')).rejects.toEqual(
        new BadGatewayException('Classification provider request failed'),
      );
      expect(sdk.generateContent).toHaveBeenCalledTimes(2);
    },
  );

  it('logs a safe failure when the API key is missing', async () => {
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    try {
      await expect(
        createProvider('').classify('Batteries'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(errorLog).toHaveBeenCalledOnce();
      expect(errorLog.mock.calls[0]?.[0]).toEqual({
        event: 'gemini_classification.failed',
        statusCode: 503,
        errorType: 'ServiceUnavailableException',
        durationMs: expect.any(Number) as unknown,
      });
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('Batteries');
    } finally {
      errorLog.mockRestore();
    }
  });

  it('logs one safe failure after Gemini retries are exhausted', async () => {
    const apiKey = 'test-api-key';
    const itemText = 'Batteries for the cabin';
    const providerBody = 'raw provider payload with account details';
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    sdk.generateContent.mockRejectedValue(new TypeError(providerBody));

    try {
      await expect(createProvider(apiKey).classify(itemText)).rejects.toEqual(
        new BadGatewayException('Classification provider request failed'),
      );

      expect(sdk.generateContent).toHaveBeenCalledTimes(2);
      expect(errorLog).toHaveBeenCalledOnce();
      expect(errorLog.mock.calls[0]?.[0]).toEqual({
        event: 'gemini_classification.failed',
        statusCode: 502,
        errorType: 'BadGatewayException',
        durationMs: expect.any(Number) as unknown,
        failureReason: 'provider-request',
        sdkErrorType: 'TypeError',
      });
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).not.toContain(apiKey);
      expect(logged).not.toContain(itemText);
      expect(logged).not.toContain(providerBody);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('logs an invalid provider response without its body', async () => {
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    sdk.generateContent.mockResolvedValue({
      text: 'not-json secret-response',
    });

    try {
      await expect(createProvider().classify('Milk')).rejects.toEqual(
        new BadGatewayException(
          'Classification provider returned an invalid response',
        ),
      );

      expect(errorLog).toHaveBeenCalledOnce();
      expect(errorLog.mock.calls[0]?.[0]).toEqual({
        event: 'gemini_classification.failed',
        statusCode: 502,
        errorType: 'BadGatewayException',
        durationMs: expect.any(Number) as unknown,
        failureReason: 'invalid-response',
      });
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
        'secret-response',
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('Milk');
    } finally {
      errorLog.mockRestore();
    }
  });

  it('logs the SDK HTTP status without an unstructured error message', async () => {
    const secretMessage = 'secret sdk message with response body';
    const sdkError = new Error(secretMessage);
    sdkError.name = 'ApiError';
    Object.assign(sdkError, { status: 400 });
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    sdk.generateContent.mockRejectedValue(sdkError);

    try {
      await expect(createProvider().classify('Milk')).rejects.toEqual(
        new UnprocessableEntityException(
          'Classification provider request failed',
        ),
      );

      expect(sdk.generateContent).toHaveBeenCalledOnce();
      expect(errorLog).toHaveBeenCalledOnce();
      expect(errorLog.mock.calls[0]?.[0]).toEqual({
        event: 'gemini_classification.failed',
        statusCode: 422,
        errorType: 'UnprocessableEntityException',
        durationMs: expect.any(Number) as unknown,
        failureReason: 'provider-request',
        sdkErrorType: 'ApiError',
        sdkStatus: 400,
      });
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secretMessage);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('Milk');
      expect(errorLog.mock.calls[0]?.[0]).not.toHaveProperty('upstreamMessage');
    } finally {
      errorLog.mockRestore();
    }
  });

  it('logs allowlisted Gemini diagnostics without the raw error body', async () => {
    const itemText = 'Wheat bread';
    const apiKey = 'test-api-key';
    const body = {
      error: {
        code: 400,
        message: 'Request contains an invalid argument.',
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'API_KEY_INVALID',
            domain: 'googleapis.com',
            metadata: { requestEcho: itemText, apiKey },
          },
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [
              {
                field: 'generationConfig.responseJsonSchema',
                description: 'Unknown name "additionalProperties".',
                extra: itemText,
              },
            ],
          },
          {
            '@type': 'type.googleapis.com/google.rpc.DebugInfo',
            detail: `UNALLOWLISTED ${itemText}`,
            stackEntries: [apiKey],
          },
        ],
      },
    };
    const rawBody = JSON.stringify(body);
    const sdkError = new Error(rawBody);
    sdkError.name = 'ApiError';
    Object.assign(sdkError, { status: 400 });
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    sdk.generateContent.mockRejectedValue(sdkError);

    try {
      await expect(createProvider(apiKey).classify(itemText)).rejects.toEqual(
        new UnprocessableEntityException(
          'Classification provider request failed',
        ),
      );

      expect(sdk.generateContent).toHaveBeenCalledOnce();
      expect(errorLog.mock.calls[0]?.[0]).toEqual({
        event: 'gemini_classification.failed',
        statusCode: 422,
        errorType: 'UnprocessableEntityException',
        durationMs: expect.any(Number) as unknown,
        failureReason: 'provider-request',
        sdkErrorType: 'ApiError',
        sdkStatus: 400,
        upstreamStatus: 'INVALID_ARGUMENT',
        upstreamReason: 'API_KEY_INVALID',
        fieldViolations: [{ field: 'generationConfig.responseJsonSchema' }],
      });
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).not.toContain(rawBody);
      expect(logged).not.toContain(itemText);
      expect(logged).not.toContain(apiKey);
      expect(logged).not.toContain('Request contains an invalid argument.');
      expect(logged).not.toContain('Unknown name');
      expect(logged).not.toContain('additionalProperties');
      expect(logged).not.toContain('UNALLOWLISTED');
      expect(logged).not.toContain('stackEntries');
      expect(logged).not.toContain('metadata');
      expect(logged).not.toContain('@type');
      expect(errorLog.mock.calls[0]?.[0]).not.toHaveProperty('upstreamMessage');
    } finally {
      errorLog.mockRestore();
    }
  });

  it('omits item fragments, upstream messages, descriptions, and credentials', async () => {
    const itemText = 'Chia seeds';
    const apiKey = 'AIzaSyTESTKEY1234567890abcdEFGH';
    const bearerToken = 'field-test-bearer-token';
    const body = {
      error: {
        code: 400,
        message: `Invalid contents: ${itemText}. Authorization: Bearer ${bearerToken}`,
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [
              {
                field: 'contents[0].parts[0].text',
                description: `Rejected ${itemText} key=${apiKey}`,
              },
            ],
          },
          {
            '@type': 'type.googleapis.com/google.rpc.DebugInfo',
            detail: `${itemText} ${apiKey} Bearer ${bearerToken}`,
          },
        ],
      },
    };
    const sdkError = new Error(JSON.stringify(body));
    sdkError.name = 'ApiError';
    Object.assign(sdkError, { status: 400 });
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    sdk.generateContent.mockRejectedValue(sdkError);

    try {
      await expect(createProvider(apiKey).classify(itemText)).rejects.toEqual(
        new UnprocessableEntityException(
          'Classification provider request failed',
        ),
      );

      expect(sdk.generateContent).toHaveBeenCalledOnce();
      expect(errorLog.mock.calls[0]?.[0]).toEqual({
        event: 'gemini_classification.failed',
        statusCode: 422,
        errorType: 'UnprocessableEntityException',
        durationMs: expect.any(Number) as unknown,
        failureReason: 'provider-request',
        sdkErrorType: 'ApiError',
        sdkStatus: 400,
        upstreamStatus: 'INVALID_ARGUMENT',
        fieldViolations: [{ field: 'contents[0].parts[0].text' }],
      });
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).not.toContain(itemText);
      expect(logged).not.toContain('chia');
      expect(logged).not.toContain('Chia');
      expect(logged).not.toContain('seeds');
      expect(logged).not.toContain(apiKey);
      expect(logged).not.toContain(bearerToken);
      expect(logged).not.toContain('Bearer');
      expect(logged).not.toContain('Invalid contents');
      expect(logged).not.toContain('Rejected');
      expect(logged).not.toContain('DebugInfo');
      expect(errorLog.mock.calls[0]?.[0]).not.toHaveProperty('upstreamMessage');
    } finally {
      errorLog.mockRestore();
    }
  });

  it('logs a gateway timeout', async () => {
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    sdk.generateContent.mockReturnValue(new Promise(() => undefined));

    try {
      const result = expect(
        createProvider().classify('Milk'),
      ).rejects.toBeInstanceOf(GatewayTimeoutException);
      await vi.advanceTimersByTimeAsync(GEMINI_CLASSIFICATION_DEADLINE_MS);
      await result;

      expect(errorLog).toHaveBeenCalledOnce();
      const logEntry = errorLog.mock.calls[0]?.[0] as {
        durationMs: number;
      };
      expect(logEntry).toMatchObject({
        event: 'gemini_classification.failed',
        statusCode: 504,
        errorType: 'GatewayTimeoutException',
      });
      expect(logEntry.durationMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('Milk');
    } finally {
      errorLog.mockRestore();
    }
  });

  it('does not log a failure when classification succeeds', async () => {
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    sdk.generateContent.mockResolvedValue({
      text: JSON.stringify({
        outcome: 'no-destination',
        categories: [],
        taxonomyVersion: 1,
      }),
    });

    try {
      await createProvider('test-api-key').classify('Call Mom');
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('does not log a retried provider error that later succeeds', async () => {
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    sdk.generateContent
      .mockRejectedValueOnce(new TypeError('network failed'))
      .mockResolvedValueOnce({
        text: JSON.stringify({
          outcome: 'no-destination',
          categories: [],
          taxonomyVersion: 1,
        }),
      });

    try {
      await createProvider().classify('Call Mom');
      expect(sdk.generateContent).toHaveBeenCalledTimes(2);
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });
});
