import { DESTINATION_TAXONOMY_VERSION } from '../../src/classification/classification-response';
import type { DestinationCategory } from '../../src/places/destination-category';
import { GOOGLE_PLACE_TYPES } from '../../src/places/google-place-types';
import {
  NEARBY_CANDIDATE_LIMIT,
  NEARBY_SEARCH_RADIUS_METERS,
} from '../../src/places/google-places.provider';
import type {
  PlaceCandidate,
  PlacesProvider,
} from '../../src/places/places-provider';
import { PlacesService } from '../../src/places/places.service';
import {
  compareStrings,
  distanceInMeters,
  type MatchingCoordinates,
} from './distance';
import type { SyntheticGooglePlace } from './fixtures';
import {
  selectMonitoredStores,
  type CollapsedStoreRecord,
  type MonitoredStore,
} from './monitored-selection';
import type { MatchingScenario } from './scenarios';

export type DiscoveredStore = {
  placeId: string;
  name: string;
  distanceMeters: number;
  itemIds: string[];
};

export type CategorySearchTrace = {
  category: DestinationCategory;
  returnedPlaceIds: string[];
  cappedPlaceIds: string[];
};

export type MatchingSimulation = {
  searchCount: number;
  searches: CategorySearchTrace[];
  discovered: DiscoveredStore[];
  collapsed: CollapsedStoreRecord[];
  monitored: MonitoredStore[];
  excludedByMonitoredLimit: MonitoredStore[];
};

function primaryTypesFor(
  categories: readonly DestinationCategory[],
): Set<string> {
  return new Set(
    categories.flatMap((category) => [...GOOGLE_PLACE_TYPES[category]]),
  );
}

export function selectNearbyPlaces(
  places: readonly SyntheticGooglePlace[],
  anchor: MatchingCoordinates,
  categories: readonly DestinationCategory[],
): { returned: SyntheticGooglePlace[]; capped: SyntheticGooglePlace[] } {
  const allowedPrimaryTypes = primaryTypesFor(categories);
  const ranked = places
    .filter((place) => allowedPrimaryTypes.has(place.primaryType))
    .map((place) => ({
      place,
      distanceMeters: distanceInMeters(anchor, place),
    }))
    .filter((entry) => entry.distanceMeters <= NEARBY_SEARCH_RADIUS_METERS)
    .sort(
      (left, right) =>
        left.distanceMeters - right.distanceMeters ||
        compareStrings(left.place.id, right.place.id),
    );

  return {
    returned: ranked
      .slice(0, NEARBY_CANDIDATE_LIMIT)
      .map((entry) => entry.place),
    capped: ranked.slice(NEARBY_CANDIDATE_LIMIT).map((entry) => entry.place),
  };
}

export function nearbyCategoryRank(
  places: readonly SyntheticGooglePlace[],
  anchor: MatchingCoordinates,
  category: DestinationCategory,
  placeId: string,
): number | null {
  const { returned, capped } = selectNearbyPlaces(places, anchor, [category]);
  const ranked = [...returned, ...capped];
  const index = ranked.findIndex((place) => place.id === placeId);
  return index === -1 ? null : index + 1;
}

function toCandidate(place: SyntheticGooglePlace): PlaceCandidate {
  return {
    id: place.id,
    name: place.name,
    location: {
      latitude: place.latitude,
      longitude: place.longitude,
    },
  };
}

export async function simulateMatchingScenario(
  scenario: MatchingScenario,
): Promise<MatchingSimulation> {
  const searches: CategorySearchTrace[] = [];
  const provider: PlacesProvider = {
    search(request) {
      const category = request.categories[0];
      if (request.categories.length !== 1 || category === undefined) {
        throw new Error(
          'Synthetic discovery expects one category per PlacesService search.',
        );
      }

      const { returned, capped } = selectNearbyPlaces(
        scenario.places,
        scenario.anchor,
        request.categories,
      );
      searches.push({
        category,
        returnedPlaceIds: returned.map((place) => place.id),
        cappedPlaceIds: capped.map((place) => place.id),
      });
      return Promise.resolve(returned.map(toCandidate));
    },
  };
  const service = new PlacesService(provider);
  const result = await service.findCandidates({
    items: scenario.items.map((item) => ({
      id: item.id,
      revision: item.revision,
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      categories: item.categories,
    })),
    location: scenario.anchor,
  });

  if (result.status !== 'complete') {
    throw new Error(
      `Synthetic discovery for ${scenario.id} returned ${result.status}.`,
    );
  }

  const discovered = result.stores.map((store) => ({
    placeId: store.placeId,
    name: store.name,
    distanceMeters: distanceInMeters(scenario.anchor, store.location),
    itemIds: [...store.itemIds],
  }));
  const selected = selectMonitoredStores({
    anchor: scenario.anchor,
    stores: result.stores.map((store) => ({
      placeId: store.placeId,
      name: store.name,
      location: store.location,
      itemIds: store.itemIds,
    })),
  });

  return {
    searchCount: searches.length,
    searches,
    discovered,
    collapsed: selected.collapsed,
    monitored: selected.monitored,
    excludedByMonitoredLimit: selected.excluded,
  };
}
