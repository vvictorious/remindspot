import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import {
  CLASSIFICATION_PROVIDER,
  ClassificationProvider,
} from '../src/classification/classification-provider';
import {
  DESTINATION_TAXONOMY_VERSION,
  ItemClassificationResponse,
} from '../src/classification/classification-response';
import { PLACES_PROVIDER, PlacesProvider } from '../src/places/places-provider';

describe('API (e2e)', () => {
  let app: INestApplication<App>;
  const classify = vi.fn<ClassificationProvider['classify']>();
  const search = vi.fn<PlacesProvider['search']>();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CLASSIFICATION_PROVIDER)
      .useValue({ classify } satisfies ClassificationProvider)
      .overrideProvider(PLACES_PROVIDER)
      .useValue({ search } satisfies PlacesProvider)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true,
      }),
    );
    await app.init();
  });

  it('GET /health', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it.each([
    {
      outcome: 'classified',
      categories: ['grocery-store', 'convenience-store'],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
    {
      outcome: 'no-destination',
      categories: [],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
    {
      outcome: 'needs-clarification',
      categories: [],
      clarificationQuestion: 'What item do you need?',
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
    {
      outcome: 'unsupported-destination',
      categories: [],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
  ] satisfies ItemClassificationResponse[])(
    'POST /classification returns a validated $outcome response',
    async (providerResponse) => {
      classify.mockResolvedValueOnce(providerResponse);

      await request(app.getHttpServer())
        .post('/classification')
        .send({ text: 'Milk' })
        .expect(200)
        .expect(providerResponse);

      expect(classify).toHaveBeenLastCalledWith('Milk');
    },
  );

  it.each([
    {},
    { text: null },
    { text: 42 },
    { text: '' },
    { text: '   ' },
    { text: 'a'.repeat(501) },
    { text: 'Milk', unexpected: true },
  ])('POST /classification rejects invalid input', async (body) => {
    classify.mockClear();

    await request(app.getHttpServer())
      .post('/classification')
      .send(body)
      .expect(400);

    expect(classify).not.toHaveBeenCalled();
  });

  it('POST /classification rejects a malformed provider response', async () => {
    classify.mockResolvedValueOnce({
      outcome: 'classified',
      categories: [],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    });

    await request(app.getHttpServer())
      .post('/classification')
      .send({ text: 'Milk' })
      .expect(502);
  });

  it('POST /places/candidates returns store-centric candidates', async () => {
    search.mockResolvedValueOnce([
      {
        id: 'market-1',
        name: 'Neighborhood Market',
        location: { latitude: 34.001, longitude: -118.401 },
      },
    ]);

    const response = await request(app.getHttpServer())
      .post('/places/candidates')
      .send({
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store'],
          },
        ],
        location: { latitude: 34, longitude: -118.4 },
      })
      .expect(200);

    expect(response.body).toEqual({
      status: 'complete',
      stores: [
        {
          placeId: 'market-1',
          name: 'Neighborhood Market',
          location: { latitude: 34.001, longitude: -118.401 },
          itemIds: ['item-1'],
        },
      ],
      categoryFailures: [],
    });
    expect(search).toHaveBeenCalledWith({
      categories: ['grocery-store'],
      location: { latitude: 34, longitude: -118.4 },
    });
  });

  it('rejects unsupported categories without searching', async () => {
    search.mockClear();

    await request(app.getHttpServer())
      .post('/places/candidates')
      .send({
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['bakery'],
          },
        ],
        location: { latitude: 34, longitude: -118.4 },
      })
      .expect(400);

    expect(search).not.toHaveBeenCalled();
  });

  it('returns shared stores with every applicable item ID', async () => {
    search.mockReset();
    search.mockResolvedValue([
      {
        id: 'shared-place',
        name: 'Shared Store',
        location: { latitude: 34.001, longitude: -118.401 },
      },
    ]);

    await request(app.getHttpServer())
      .post('/places/candidates')
      .send({
        items: [
          {
            id: 'item-1',
            revision: 1,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store', 'pharmacy'],
          },
          {
            id: 'item-2',
            revision: 3,
            taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
            categories: ['grocery-store'],
          },
        ],
        location: { latitude: 34, longitude: -118.4 },
      })
      .expect(200)
      .expect({
        status: 'complete',
        stores: [
          {
            placeId: 'shared-place',
            name: 'Shared Store',
            location: { latitude: 34.001, longitude: -118.401 },
            itemIds: ['item-1', 'item-2'],
          },
        ],
        categoryFailures: [],
      });

    expect(search).toHaveBeenCalledTimes(2);
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
          revision: 1,
          taxonomyVersion: 999,
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
      location: { latitude: 90.1, longitude: -118.4 },
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
      location: { latitude: 34, longitude: 180.1 },
    },
  ])('rejects invalid candidate input', async (body) => {
    await request(app.getHttpServer())
      .post('/places/candidates')
      .send(body)
      .expect(400);
  });

  afterAll(async () => {
    await app.close();
  });
});

describe('unconfigured classification provider (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: () => undefined })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true,
      }),
    );
    await app.init();
  });

  it('starts the backend and returns 503 from POST /classification', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });

    await request(app.getHttpServer())
      .post('/classification')
      .send({ text: 'Milk' })
      .expect(503)
      .expect({
        message: 'Classification service is unavailable',
        error: 'Service Unavailable',
        statusCode: 503,
      });
  });

  afterAll(async () => {
    await app.close();
  });
});
