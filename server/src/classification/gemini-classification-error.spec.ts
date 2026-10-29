import { describe, expect, it } from 'vitest';

import { geminiErrorDiagnostics } from './gemini-classification-error';

const itemText = 'Chia seeds';
const apiKey = 'AIzaSyTESTKEY1234567890abcdEFGH';
const bearerToken = 'field-test-bearer-token';

function sdkError(body: unknown): Error {
  const error = new Error(
    typeof body === 'string' ? body : JSON.stringify(body),
  );
  error.name = 'ApiError';
  return error;
}

describe('geminiErrorDiagnostics', () => {
  it('copies allowlisted status, reason, and structural field paths', () => {
    const diagnostics = geminiErrorDiagnostics(
      sdkError({
        error: {
          code: 400,
          message: 'Request contains an invalid argument.',
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'API_KEY_INVALID',
              domain: 'googleapis.com',
              metadata: { item: itemText, apiKey },
            },
            {
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [
                {
                  field: 'generationConfig.responseJsonSchema',
                  description: 'Unknown name "additionalProperties".',
                },
              ],
            },
            {
              '@type': 'type.googleapis.com/google.rpc.DebugInfo',
              detail: `UNALLOWLISTED ${itemText} ${apiKey}`,
              stackEntries: [itemText],
            },
          ],
        },
      }),
    );

    expect(diagnostics).toEqual({
      upstreamStatus: 'INVALID_ARGUMENT',
      upstreamReason: 'API_KEY_INVALID',
      fieldViolations: [{ field: 'generationConfig.responseJsonSchema' }],
    });
    const logged = JSON.stringify(diagnostics);
    expect(logged).not.toContain(itemText);
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain('Request contains an invalid argument.');
    expect(logged).not.toContain('Unknown name');
    expect(logged).not.toContain('additionalProperties');
    expect(logged).not.toContain('metadata');
    expect(logged).not.toContain('DebugInfo');
    expect(diagnostics).not.toHaveProperty('upstreamMessage');
  });

  it('omits item fragments, upstream messages, descriptions, and credentials', () => {
    const diagnostics = geminiErrorDiagnostics(
      sdkError({
        error: {
          message: `Invalid contents: ${itemText}. Authorization: Bearer ${bearerToken} ya29.oauth-token`,
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'SEEDS',
            },
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'CHIA',
            },
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'CHIA_SEEDS',
            },
            {
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [
                {
                  field: 'items.seeds',
                  description: `Rejected ${itemText} key=${apiKey}`,
                },
                {
                  field: 'items.Chia',
                  description: `chia ${bearerToken}`,
                },
                {
                  field: 'contents[0].parts[0].text',
                  description: `Rejected chia key=${apiKey}`,
                },
              ],
            },
            {
              '@type': 'type.googleapis.com/google.rpc.DebugInfo',
              detail: `${itemText} ${apiKey} Bearer ${bearerToken}`,
            },
          ],
        },
      }),
    );

    expect(diagnostics).toEqual({
      upstreamStatus: 'INVALID_ARGUMENT',
      fieldViolations: [{ field: 'contents[0].parts[0].text' }],
    });
    const logged = JSON.stringify(diagnostics);
    expect(logged).not.toContain(itemText);
    expect(logged).not.toContain('chia');
    expect(logged).not.toContain('Chia');
    expect(logged).not.toContain('seeds');
    expect(logged).not.toContain('SEEDS');
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain(bearerToken);
    expect(logged).not.toContain('Bearer');
    expect(logged).not.toContain('ya29.');
    expect(logged).not.toContain('Invalid contents');
    expect(logged).not.toContain('Rejected');
    expect(diagnostics).not.toHaveProperty('upstreamMessage');
    expect(diagnostics.fieldViolations?.[0]).not.toHaveProperty('description');
  });

  it('keeps a later allowlisted reason after skipping item-like reasons', () => {
    expect(
      geminiErrorDiagnostics(
        sdkError({
          error: {
            message: `invalid item ${itemText}`,
            status: 'PERMISSION_DENIED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'CHIA_SEEDS',
              },
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'SERVICE_DISABLED',
                metadata: { apiKey, authorization: `Bearer ${bearerToken}` },
              },
            ],
          },
        }),
      ),
    ).toEqual({
      upstreamStatus: 'PERMISSION_DENIED',
      upstreamReason: 'SERVICE_DISABLED',
    });
  });

  it('omits unknown statuses, reasons, and field paths', () => {
    const diagnostics = geminiErrorDiagnostics(
      sdkError({
        error: {
          message: 'Request contains an invalid argument.\nsecret line',
          status: 'NOT_A_STATUS',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'not-a-reason',
            },
            {
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [
                {
                  field: 'contents chia seeds',
                  description: 'safe description',
                },
                {
                  field: 'generationConfig.property0',
                  description: '{ "raw": "body" }',
                },
              ],
            },
          ],
        },
      }),
    );

    expect(diagnostics).toEqual({});
    expect(JSON.stringify(diagnostics)).not.toContain(apiKey);
    expect(JSON.stringify(diagnostics)).not.toContain('secret line');
    expect(JSON.stringify(diagnostics)).not.toContain('safe description');
  });

  it('keeps at most five allowlisted field paths', () => {
    const fields = [
      'generationConfig.responseJsonSchema',
      'generationConfig.responseMimeType',
      'generationConfig.responseSchema',
      'contents[0].parts[0].text',
      'contents[0].parts[0].role',
      'systemInstruction',
    ];

    expect(
      geminiErrorDiagnostics(
        sdkError({
          error: {
            status: 'INVALID_ARGUMENT',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.BadRequest',
                fieldViolations: [
                  { field: 'items.seeds', description: itemText },
                  ...fields.map((field) => ({
                    field,
                    description: `Unknown name ${itemText}`,
                  })),
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual({
      upstreamStatus: 'INVALID_ARGUMENT',
      fieldViolations: fields.slice(0, 5).map((field) => ({ field })),
    });
  });

  it('returns no diagnostics for an unstructured SDK message', () => {
    expect(
      geminiErrorDiagnostics(sdkError('secret sdk message with response body')),
    ).toEqual({});
  });
});
