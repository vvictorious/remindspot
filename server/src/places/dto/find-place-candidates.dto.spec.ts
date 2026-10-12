import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { DESTINATION_TAXONOMY_VERSION } from '../../classification/classification-response';
import { FindPlaceCandidatesDto } from './find-place-candidates.dto';

async function validateRequest(value: unknown) {
  return validate(plainToInstance(FindPlaceCandidatesDto, value));
}

describe('FindPlaceCandidatesDto', () => {
  it('accepts a valid request', async () => {
    await expect(
      validateRequest({
        items: [
          {
            id: 'item-1',
            revision: 2,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store', 'convenience-store'],
          },
        ],
        location: { latitude: 34, longitude: -118.4 },
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    { items: [], location: { latitude: 34, longitude: -118.4 } },
    {
      items: [
        {
          id: '',
          revision: 1,
          taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
          categories: ['grocery-store'],
        },
      ],
      location: { latitude: 34, longitude: -118.4 },
    },
    {
      items: [
        {
          id: 'item-1',
          revision: 0,
          taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
          categories: ['grocery-store'],
        },
      ],
      location: { latitude: 34, longitude: -118.4 },
    },
    {
      items: [
        {
          id: 'item-1',
          revision: 1,
          taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
          categories: ['grocery-store'],
        },
      ],
      location: { latitude: 91, longitude: -118.4 },
    },
    {
      items: [
        {
          id: 'item-1',
          revision: 1,
          taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
          categories: ['grocery-store'],
        },
      ],
      location: { latitude: 34, longitude: -181 },
    },
  ])('rejects invalid input: %j', async (value) => {
    expect(await validateRequest(value)).not.toHaveLength(0);
  });

  it.each([
    ['unknown-store', DESTINATION_TAXONOMY_VERSION],
    ['grocery-store', DESTINATION_TAXONOMY_VERSION + 1],
  ])(
    'rejects category %j with taxonomy version %j',
    async (category, taxonomyVersion) => {
      expect(
        await validateRequest({
          items: [
            {
              id: 'item-1',
              revision: 1,
              taxonomyVersion,
              categories: [category],
            },
          ],
          location: { latitude: 34, longitude: -118.4 },
        }),
      ).not.toHaveLength(0);
    },
  );

  it('rejects duplicate categories and item IDs', async () => {
    expect(
      await validateRequest({
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store', 'grocery-store'],
          },
          {
            id: 'item-1',
            revision: 2,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['pharmacy'],
          },
        ],
        location: { latitude: 34, longitude: -118.4 },
      }),
    ).not.toHaveLength(0);
  });
});
