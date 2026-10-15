import { offsetMeters, type MatchingCoordinates } from './distance';

export const MATCHING_FIXTURE_ANCHOR: MatchingCoordinates = {
  latitude: 34.05,
  longitude: -118.25,
};

export const REQUIRED_FIXTURE_KINDS = [
  'pharmacy',
  'convenience-store',
  'gas-station-market',
  'embedded-pharmacy',
  'duplicate-business',
  'dense-intersection',
] as const;

export type RequiredFixtureKind = (typeof REQUIRED_FIXTURE_KINDS)[number];

export type FixtureKind =
  RequiredFixtureKind | 'grocery-store' | 'department-store';

/**
 * Synthetic Nearby Search catalog entry.
 * `types` is evaluation metadata. Production requests filter on primary type
 * and the field mask does not return types.
 */
export type SyntheticGooglePlace = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  primaryType: string;
  types: readonly string[];
  kind: FixtureKind;
};

type PlaceInput = {
  id: string;
  name: string;
  northMeters: number;
  eastMeters?: number;
  primaryType: string;
  types: readonly string[];
  kind: FixtureKind;
  anchor?: MatchingCoordinates;
};

function place({
  id,
  name,
  northMeters,
  eastMeters = 0,
  primaryType,
  types,
  kind,
  anchor = MATCHING_FIXTURE_ANCHOR,
}: PlaceInput): SyntheticGooglePlace {
  const location = offsetMeters(anchor, northMeters, eastMeters);
  return {
    id,
    name,
    latitude: location.latitude,
    longitude: location.longitude,
    primaryType,
    types,
    kind,
  };
}

export const PHARMACY_BROADCAST_PLACES = [
  place({
    id: 'broadcast-cvs',
    name: 'CVS Pharmacy',
    northMeters: 80,
    primaryType: 'pharmacy',
    types: ['pharmacy'],
    kind: 'pharmacy',
  }),
  place({
    id: 'broadcast-seven-eleven',
    name: '7-Eleven',
    northMeters: 140,
    primaryType: 'convenience_store',
    types: ['convenience_store'],
    kind: 'convenience-store',
  }),
  place({
    id: 'broadcast-walgreens',
    name: 'Walgreens',
    northMeters: 200,
    primaryType: 'drugstore',
    types: ['drugstore'],
    kind: 'pharmacy',
  }),
  place({
    id: 'broadcast-whole-foods',
    name: 'Whole Foods',
    northMeters: 280,
    primaryType: 'grocery_store',
    types: ['grocery_store'],
    kind: 'grocery-store',
  }),
  place({
    id: 'broadcast-target',
    name: 'Target',
    northMeters: 360,
    primaryType: 'department_store',
    types: ['department_store'],
    kind: 'department-store',
  }),
  place({
    id: 'broadcast-memorial',
    name: 'Memorial Outpatient Pharmacy',
    northMeters: 460,
    primaryType: 'pharmacy',
    types: ['pharmacy'],
    kind: 'pharmacy',
  }),
] as const satisfies readonly SyntheticGooglePlace[];

export const GAS_STATION_MARKET_PLACES = [
  place({
    id: 'gas-whole-foods',
    name: 'Whole Foods',
    northMeters: 100,
    primaryType: 'grocery_store',
    types: ['grocery_store'],
    kind: 'grocery-store',
  }),
  place({
    id: 'gas-seven-eleven',
    name: '7-Eleven',
    northMeters: 180,
    primaryType: 'convenience_store',
    types: ['convenience_store'],
    kind: 'convenience-store',
  }),
  place({
    id: 'gas-cvs',
    name: 'CVS Pharmacy',
    northMeters: 270,
    primaryType: 'pharmacy',
    types: ['pharmacy'],
    kind: 'pharmacy',
  }),
  place({
    id: 'gas-ampm',
    name: 'ampm',
    northMeters: 360,
    primaryType: 'convenience_store',
    types: ['convenience_store', 'gas_station'],
    kind: 'gas-station-market',
  }),
  place({
    id: 'gas-shell',
    name: 'Shell Food Mart',
    northMeters: 460,
    primaryType: 'convenience_store',
    types: ['convenience_store', 'gas_station'],
    kind: 'gas-station-market',
  }),
  place({
    id: 'gas-chevron',
    name: 'Chevron ExtraMile',
    northMeters: 560,
    primaryType: 'gas_station',
    types: ['gas_station', 'convenience_store'],
    kind: 'gas-station-market',
  }),
] as const satisfies readonly SyntheticGooglePlace[];

export const EMBEDDED_PHARMACY_PLACES = [
  place({
    id: 'embedded-ralphs',
    name: 'Ralphs',
    northMeters: 120,
    primaryType: 'supermarket',
    types: ['supermarket', 'grocery_store', 'pharmacy'],
    kind: 'embedded-pharmacy',
  }),
  place({
    id: 'embedded-ralphs-pharmacy',
    name: 'Ralphs Pharmacy',
    northMeters: 120,
    eastMeters: 18,
    primaryType: 'pharmacy',
    types: ['pharmacy'],
    kind: 'embedded-pharmacy',
  }),
  place({
    id: 'embedded-cvs',
    name: 'CVS Pharmacy',
    northMeters: 260,
    primaryType: 'pharmacy',
    types: ['pharmacy'],
    kind: 'pharmacy',
  }),
  place({
    id: 'embedded-target',
    name: 'Target',
    northMeters: 420,
    primaryType: 'department_store',
    types: ['department_store', 'pharmacy'],
    kind: 'embedded-pharmacy',
  }),
] as const satisfies readonly SyntheticGooglePlace[];

export const DUPLICATE_BUSINESS_PLACES = [
  place({
    id: 'duplicate-walgreens',
    name: 'Walgreens',
    northMeters: 100,
    primaryType: 'pharmacy',
    types: ['pharmacy'],
    kind: 'duplicate-business',
  }),
  place({
    id: 'duplicate-walgreens-pharmacy',
    name: 'Walgreens Pharmacy',
    northMeters: 100,
    eastMeters: 18,
    primaryType: 'pharmacy',
    types: ['pharmacy'],
    kind: 'duplicate-business',
  }),
  place({
    id: 'duplicate-cvs',
    name: 'CVS',
    northMeters: 400,
    primaryType: 'pharmacy',
    types: ['pharmacy'],
    kind: 'duplicate-business',
  }),
  place({
    id: 'duplicate-cvs-pharmacy',
    name: 'CVS Pharmacy',
    northMeters: 460,
    primaryType: 'pharmacy',
    types: ['pharmacy'],
    kind: 'duplicate-business',
  }),
] as const satisfies readonly SyntheticGooglePlace[];

function numberedPlaces(input: {
  count: number;
  idPrefix: string;
  namePrefix: string;
  startMeters: number;
  stepMeters: number;
  primaryType: string;
}): SyntheticGooglePlace[] {
  return Array.from({ length: input.count }, (_, index) =>
    place({
      id: `${input.idPrefix}-${String(index + 1).padStart(2, '0')}`,
      name: `${input.namePrefix} ${String(index + 1)}`,
      northMeters: input.startMeters + index * input.stepMeters,
      primaryType: input.primaryType,
      types: [input.primaryType],
      kind: 'dense-intersection',
    }),
  );
}

export const DENSE_GROCERY_PLACES = numberedPlaces({
  count: 6,
  idPrefix: 'dense-grocery',
  namePrefix: 'Market',
  startMeters: 100,
  stepMeters: 100,
  primaryType: 'grocery_store',
});

export const DENSE_CONVENIENCE_PLACES = numberedPlaces({
  count: 5,
  idPrefix: 'dense-convenience',
  namePrefix: 'Corner Shop',
  startMeters: 150,
  stepMeters: 100,
  primaryType: 'convenience_store',
});

export const DENSE_PHARMACY_PLACES = numberedPlaces({
  count: 5,
  idPrefix: 'dense-pharmacy',
  namePrefix: 'Neighborhood Pharmacy',
  startMeters: 650,
  stepMeters: 100,
  primaryType: 'pharmacy',
});

export const DENSE_DEPARTMENT_PLACE = place({
  id: 'dense-department',
  name: 'Downtown Department Store',
  northMeters: 1100,
  primaryType: 'department_store',
  types: ['department_store'],
  kind: 'dense-intersection',
});

export const DENSE_AUTO_PARTS_PLACE = place({
  id: 'dense-auto-parts',
  name: 'Harbor Auto Parts',
  northMeters: 2000,
  primaryType: 'auto_parts_store',
  types: ['auto_parts_store'],
  kind: 'dense-intersection',
});

export const DENSE_PET_PLACE = place({
  id: 'dense-pet-store',
  name: 'Paws Pet Supply',
  northMeters: 2200,
  primaryType: 'pet_store',
  types: ['pet_store'],
  kind: 'dense-intersection',
});

export const DENSE_INTERSECTION_PLACES = [
  ...DENSE_GROCERY_PLACES,
  ...DENSE_CONVENIENCE_PLACES,
  ...DENSE_PHARMACY_PLACES,
  DENSE_DEPARTMENT_PLACE,
  DENSE_AUTO_PARTS_PLACE,
  DENSE_PET_PLACE,
];

export const INTENTIONALLY_UNMATCHED_PRIMARY_TYPES = ['gas_station'] as const;
