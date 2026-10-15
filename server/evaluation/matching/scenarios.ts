import type { DestinationCategory } from '../../src/places/destination-category';
import type { MatchingCoordinates } from './distance';
import {
  DENSE_AUTO_PARTS_PLACE,
  DENSE_CONVENIENCE_PLACES,
  DENSE_DEPARTMENT_PLACE,
  DENSE_GROCERY_PLACES,
  DENSE_INTERSECTION_PLACES,
  DENSE_PET_PLACE,
  DENSE_PHARMACY_PLACES,
  DUPLICATE_BUSINESS_PLACES,
  EMBEDDED_PHARMACY_PLACES,
  GAS_STATION_MARKET_PLACES,
  MATCHING_FIXTURE_ANCHOR,
  PHARMACY_BROADCAST_PLACES,
  type SyntheticGooglePlace,
} from './fixtures';

export const MATCHING_LIMITATIONS = [
  'monitored-15-cap',
  'embedded-pharmacy-secondary-type',
  'primary-type-filter',
  'per-category-candidate-cap',
  'category-broadcast',
  'duplicate-beyond-30m',
] as const;

export type MatchingLimitation = (typeof MATCHING_LIMITATIONS)[number];

export type MatchingEvaluationItem = {
  id: string;
  text: string;
  revision: number;
  categories: readonly [DestinationCategory, ...DestinationCategory[]];
};

export type ExpectedAssociation = {
  itemId: string;
  placeId: string;
  judgment: 'reasonable' | 'false-positive';
  /**
   * Mechanism the current pipeline is known to use for this association.
   * Null means the association should be monitored. A value predicts a
   * false positive or a missed reasonable match under today's rules.
   */
  limitation: MatchingLimitation | null;
  reason: string;
};

export type MatchingScenario = {
  id: string;
  title: string;
  notes: string;
  anchor: MatchingCoordinates;
  items: readonly MatchingEvaluationItem[];
  places: readonly SyntheticGooglePlace[];
  expectations: readonly ExpectedAssociation[];
};

function item(
  id: string,
  text: string,
  categories: readonly [DestinationCategory, ...DestinationCategory[]],
): MatchingEvaluationItem {
  return { id, text, revision: 1, categories };
}

function reasonable(
  itemId: string,
  placeIds: readonly string[],
  reason: string,
  limitation: MatchingLimitation | null = null,
): ExpectedAssociation[] {
  return placeIds.map((placeId) => ({
    itemId,
    placeId,
    judgment: 'reasonable',
    limitation,
    reason,
  }));
}

function falsePositive(
  itemId: string,
  placeIds: readonly string[],
  limitation: MatchingLimitation,
  reason: string,
): ExpectedAssociation[] {
  return placeIds.map((placeId) => ({
    itemId,
    placeId,
    judgment: 'false-positive',
    limitation,
    reason,
  }));
}

const cortisoneCategories = [
  'pharmacy',
  'grocery-store',
  'department-store',
  'convenience-store',
] as const satisfies readonly [DestinationCategory, ...DestinationCategory[]];

const coughDropCategories = [
  'pharmacy',
  'grocery-store',
  'department-store',
  'convenience-store',
] as const satisfies readonly [DestinationCategory, ...DestinationCategory[]];

const batteryCategories = [
  'pharmacy',
  'grocery-store',
  'department-store',
  'convenience-store',
] as const satisfies readonly [DestinationCategory, ...DestinationCategory[]];

const pharmacyBroadcastScenario: MatchingScenario = {
  id: 'pharmacy-broadcast',
  title: 'Pharmacies inherit every pharmacy item',
  notes:
    'Standalone pharmacies, a drugstore, a grocery, a department store, and a convenience store are all close enough to be monitored. A dispensing-only outpatient pharmacy is returned with the same pharmacy types as CVS.',
  anchor: MATCHING_FIXTURE_ANCHOR,
  items: [
    item('cortisone', 'Cortisone cream', cortisoneCategories),
    item('prescription', 'Allergy prescription refill', ['pharmacy']),
    item('birthday-card', 'Birthday card', ['pharmacy', 'department-store']),
  ],
  places: PHARMACY_BROADCAST_PLACES,
  expectations: [
    ...reasonable(
      'cortisone',
      [
        'broadcast-cvs',
        'broadcast-walgreens',
        'broadcast-target',
        'broadcast-whole-foods',
        'broadcast-seven-eleven',
      ],
      'Cortisone is ordinary stock at retail pharmacies, groceries, department stores, and convenience stores.',
    ),
    ...reasonable(
      'prescription',
      ['broadcast-cvs', 'broadcast-walgreens', 'broadcast-memorial'],
      'A prescription refill belongs at a pharmacy, including a dispensing outpatient pharmacy.',
    ),
    ...reasonable(
      'birthday-card',
      ['broadcast-cvs', 'broadcast-walgreens', 'broadcast-target'],
      'Greeting cards are ordinary stock at retail pharmacies and department stores.',
    ),
    ...falsePositive(
      'cortisone',
      ['broadcast-memorial'],
      'category-broadcast',
      'The outpatient pharmacy matches the pharmacy type filter, so it inherits the OTC item.',
    ),
    ...falsePositive(
      'birthday-card',
      ['broadcast-memorial'],
      'category-broadcast',
      'The outpatient pharmacy inherits greeting cards because birthday cards include pharmacy.',
    ),
  ],
};

const gasStationScenario: MatchingScenario = {
  id: 'gas-station-markets',
  title: 'Convenience stores and gas-station markets',
  notes:
    '7-Eleven is a dedicated convenience store. ampm and Shell Food Mart are fuel-first markets whose primary type is still convenience_store. Chevron ExtraMile carries convenience_store only as a secondary type, with primary type gas_station.',
  anchor: MATCHING_FIXTURE_ANCHOR,
  items: [
    item('milk', 'Milk', ['grocery-store', 'convenience-store']),
    item('cough-drops', 'Cough drops and tissues', coughDropCategories),
  ],
  places: GAS_STATION_MARKET_PLACES,
  expectations: [
    ...reasonable(
      'milk',
      ['gas-whole-foods', 'gas-seven-eleven', 'gas-ampm', 'gas-shell'],
      'Milk is ordinary stock at groceries, dedicated convenience stores, and fuel markets that Google types as convenience stores.',
    ),
    ...reasonable(
      'milk',
      ['gas-chevron'],
      'Chevron ExtraMile is a market that stocks milk, but its primary type is gas_station.',
      'primary-type-filter',
    ),
    ...reasonable(
      'cough-drops',
      ['gas-cvs', 'gas-whole-foods', 'gas-seven-eleven'],
      'A cold-care basket is ordinary stock at a retail pharmacy, grocery, and dedicated convenience store.',
    ),
    ...falsePositive(
      'cough-drops',
      ['gas-ampm', 'gas-shell'],
      'category-broadcast',
      'Fuel-first markets match convenience_store, so they inherit the cold-care basket.',
    ),
  ],
};

const embeddedPharmacyScenario: MatchingScenario = {
  id: 'embedded-pharmacies',
  title: 'Embedded pharmacies and a collapsed in-store listing',
  notes:
    'Ralphs is a supermarket whose secondary types include pharmacy, and a separate Ralphs Pharmacy listing sits 18 meters east. Target has a pharmacy only as a secondary type and no separate pharmacy place. CVS is a standalone pharmacy.',
  anchor: MATCHING_FIXTURE_ANCHOR,
  items: [
    item('milk', 'Milk', ['grocery-store', 'convenience-store']),
    item('prescription', 'Allergy prescription refill', ['pharmacy']),
    item('birthday-card', 'Birthday card', ['pharmacy', 'department-store']),
    item('cortisone', 'Cortisone cream', cortisoneCategories),
  ],
  places: EMBEDDED_PHARMACY_PLACES,
  expectations: [
    ...reasonable(
      'milk',
      ['embedded-ralphs'],
      'Ralphs is the supermarket that stocks milk. The separate pharmacy listing collapses into it.',
    ),
    ...reasonable(
      'cortisone',
      ['embedded-ralphs', 'embedded-cvs', 'embedded-target'],
      'Cortisone is ordinary stock at the supermarket, the standalone pharmacy, and the department store.',
    ),
    ...reasonable(
      'prescription',
      ['embedded-ralphs', 'embedded-cvs'],
      'The separate Ralphs Pharmacy listing collapses into Ralphs, and CVS is a standalone pharmacy.',
    ),
    ...reasonable(
      'prescription',
      ['embedded-target'],
      'Target contains a pharmacy, but pharmacy is only a secondary type and there is no separate pharmacy place.',
      'embedded-pharmacy-secondary-type',
    ),
    ...reasonable(
      'birthday-card',
      ['embedded-cvs', 'embedded-target'],
      'Greeting cards are ordinary stock at CVS and Target.',
    ),
    ...falsePositive(
      'birthday-card',
      ['embedded-ralphs'],
      'category-broadcast',
      'The in-store pharmacy listing inherits greeting cards, then collapse moves that association onto Ralphs.',
    ),
  ],
};

const duplicateBusinessScenario: MatchingScenario = {
  id: 'duplicate-businesses',
  title: 'Duplicate listings inside and beyond 30 meters',
  notes:
    'Walgreens and Walgreens Pharmacy are 18 meters apart, inside the duplicate-collapse window. CVS and CVS Pharmacy are 60 meters apart, outside that window. Every listing is a pharmacy primary type.',
  anchor: MATCHING_FIXTURE_ANCHOR,
  items: [
    item('batteries', 'AA batteries', ['pharmacy']),
    item('prescription', 'Allergy prescription refill', ['pharmacy']),
  ],
  places: DUPLICATE_BUSINESS_PLACES,
  expectations: [
    ...reasonable(
      'batteries',
      ['duplicate-walgreens', 'duplicate-cvs'],
      'Batteries belong at the surviving Walgreens listing and at CVS.',
    ),
    ...reasonable(
      'prescription',
      ['duplicate-walgreens', 'duplicate-cvs'],
      'A prescription refill belongs at the surviving Walgreens listing and at CVS.',
    ),
    ...falsePositive(
      'batteries',
      ['duplicate-cvs-pharmacy'],
      'duplicate-beyond-30m',
      'The second CVS listing is the same business 60 meters away, beyond the 30 meter collapse window.',
    ),
    ...falsePositive(
      'prescription',
      ['duplicate-cvs-pharmacy'],
      'duplicate-beyond-30m',
      'The second CVS listing schedules another prescription reminder for the same business.',
    ),
  ],
};

const monitoredDenseGroceryIds = DENSE_GROCERY_PLACES.slice(0, 5).map(
  (store) => store.id,
);
const cappedDenseGroceryId = DENSE_GROCERY_PLACES[5]?.id;
const denseConvenienceIds = DENSE_CONVENIENCE_PLACES.map((store) => store.id);
const monitoredDensePharmacyIds = DENSE_PHARMACY_PLACES.slice(0, 3).map(
  (store) => store.id,
);
const excludedDensePharmacyIds = DENSE_PHARMACY_PLACES.slice(3).map(
  (store) => store.id,
);

if (cappedDenseGroceryId === undefined) {
  throw new Error('Dense grocery fixtures must include a sixth store.');
}

const denseIntersectionScenario: MatchingScenario = {
  id: 'dense-intersection',
  title: 'Item-aware selection preserves distinct item coverage',
  notes:
    'Six groceries, five convenience stores, five pharmacies, one department store, one auto-parts store, and one pet store sit on the same road. The monitored window reserves slots for the only auto-parts and pet-store candidates, then fills remaining slots by distance.',
  anchor: MATCHING_FIXTURE_ANCHOR,
  items: [
    item('milk', 'Milk', ['grocery-store', 'convenience-store']),
    item('batteries', 'AA batteries', batteryCategories),
    item('wiper-blades', 'Wiper blades', ['auto-parts-store']),
    item('dog-food', 'Dog food', ['pet-store']),
  ],
  places: DENSE_INTERSECTION_PLACES,
  expectations: [
    ...reasonable(
      'milk',
      [...monitoredDenseGroceryIds, ...denseConvenienceIds],
      'The five nearest groceries and the convenience stores are ordinary milk stops and stay inside the monitored window.',
    ),
    ...reasonable(
      'milk',
      [cappedDenseGroceryId],
      'The sixth grocery stocks milk and is closer than the pharmacies, but each category search returns only five places.',
      'per-category-candidate-cap',
    ),
    ...reasonable(
      'batteries',
      [
        ...monitoredDenseGroceryIds,
        ...denseConvenienceIds,
        ...monitoredDensePharmacyIds,
      ],
      'Batteries are ordinary stock at the groceries, convenience stores, and pharmacies that remain selected.',
    ),
    ...reasonable(
      'batteries',
      excludedDensePharmacyIds,
      'Two farther pharmacies lose their slots when item-aware selection reserves stores for otherwise uncovered items.',
      'monitored-15-cap',
    ),
    ...reasonable(
      'batteries',
      [DENSE_DEPARTMENT_PLACE.id],
      'The department store adds no uncovered item and remains outside the monitored slots.',
      'monitored-15-cap',
    ),
    ...reasonable(
      'wiper-blades',
      [DENSE_AUTO_PARTS_PLACE.id],
      'Harbor Auto Parts is selected because it is the only discovered store for wiper blades.',
    ),
    ...reasonable(
      'dog-food',
      [DENSE_PET_PLACE.id],
      'Paws Pet Supply is selected because it is the only discovered store for dog food.',
    ),
  ],
};

export const MATCHING_EVALUATION_SCENARIOS = [
  pharmacyBroadcastScenario,
  gasStationScenario,
  embeddedPharmacyScenario,
  duplicateBusinessScenario,
  denseIntersectionScenario,
] as const satisfies readonly MatchingScenario[];
