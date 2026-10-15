import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { GOOGLE_PLACE_TYPES } from './google-place-types';
import type {
  PlaceCandidate,
  PlaceSearchRequest,
  PlacesProvider,
} from './places-provider';

export const GOOGLE_NEARBY_SEARCH_URL =
  'https://places.googleapis.com/v1/places:searchNearby';
export const GOOGLE_PLACES_FIELD_MASK =
  'places.id,places.displayName,places.location,places.businessStatus,places.pureServiceAreaBusiness';
export const NEARBY_SEARCH_RADIUS_METERS = 3218.688;
export const NEARBY_CANDIDATE_LIMIT = 5;

const CLOSED_BUSINESS_STATUSES = new Set([
  'CLOSED_TEMPORARILY',
  'CLOSED_PERMANENTLY',
]);

interface GoogleNearbySearchResponse {
  places?: GooglePlace[];
}

interface GooglePlace {
  id?: string;
  displayName?: {
    text?: string;
  };
  location?: {
    latitude?: number;
    longitude?: number;
  };
  businessStatus?: string;
  pureServiceAreaBusiness?: boolean;
}

@Injectable()
export class GooglePlacesProvider implements PlacesProvider {
  private readonly logger = new Logger(GooglePlacesProvider.name);
  private requestCount = 0;

  constructor(private readonly config: ConfigService) {}

  async search(
    request: PlaceSearchRequest,
  ): Promise<readonly PlaceCandidate[]> {
    const apiKey = this.config.get<string>('GOOGLE_PLACES_API_KEY');

    if (!apiKey) {
      throw new ServiceUnavailableException(
        'Places requires GOOGLE_PLACES_API_KEY to be configured',
      );
    }

    const includedPrimaryTypes = [
      ...new Set(
        request.categories.flatMap((category) => GOOGLE_PLACE_TYPES[category]),
      ),
    ];

    const requestCount = ++this.requestCount;
    const startedAt = performance.now();
    let success = false;

    try {
      let response: Response;
      try {
        response = await fetch(GOOGLE_NEARBY_SEARCH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': GOOGLE_PLACES_FIELD_MASK,
          },
          body: JSON.stringify({
            includedPrimaryTypes,
            maxResultCount: NEARBY_CANDIDATE_LIMIT,
            rankPreference: 'DISTANCE',
            locationRestriction: {
              circle: {
                center: request.location,
                radius: NEARBY_SEARCH_RADIUS_METERS,
              },
            },
          }),
        });
      } catch {
        throw new BadGatewayException('Google Places request failed');
      }

      if (!response.ok) {
        throw new BadGatewayException(
          `Google Places request failed with status ${response.status}`,
        );
      }

      let body: GoogleNearbySearchResponse;
      try {
        body = (await response.json()) as GoogleNearbySearchResponse;
      } catch {
        throw new BadGatewayException(
          'Google Places returned an invalid response',
        );
      }

      const candidates = (body.places ?? []).flatMap((place) => {
        const { id, displayName, location } = place;

        if (
          !id ||
          !displayName?.text ||
          typeof location?.latitude !== 'number' ||
          typeof location.longitude !== 'number' ||
          CLOSED_BUSINESS_STATUSES.has(place.businessStatus ?? '') ||
          place.pureServiceAreaBusiness === true
        ) {
          return [];
        }

        return [
          {
            id,
            name: displayName.text,
            location: {
              latitude: location.latitude,
              longitude: location.longitude,
            },
          },
        ];
      });
      success = true;
      return candidates;
    } finally {
      this.logger.log({
        event: 'google_places.provider_request',
        categories: [...request.categories],
        requestCount,
        success,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  }
}
