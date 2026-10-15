import {
  GOOGLE_PLACES_FIELD_MASK,
  NEARBY_CANDIDATE_LIMIT,
  NEARBY_SEARCH_RADIUS_METERS,
} from '../../src/places/google-places.provider';
import { GOOGLE_PLACE_TYPES } from '../../src/places/google-place-types';
import type { DestinationCategory } from '../../src/places/destination-category';
import type { SyntheticGooglePlace } from './fixtures';
import {
  DUPLICATE_STORE_DISTANCE_METERS,
  GEOFENCE_RADIUS_METERS,
  MONITORED_STORE_LIMIT,
  normalizedBusinessIdentity,
} from './monitored-selection';
import {
  MATCHING_LIMITATIONS,
  type ExpectedAssociation,
  type MatchingEvaluationItem,
  type MatchingLimitation,
  type MatchingScenario,
} from './scenarios';
import {
  nearbyCategoryRank,
  simulateMatchingScenario,
  type MatchingSimulation,
} from './simulate';

export type AssociationOutcome =
  | 'true-positive'
  | 'false-positive'
  | 'false-negative'
  | 'suppressed-false-positive'
  | 'unexpected';

export type AssociationResult = {
  itemId: string;
  itemText: string;
  placeId: string;
  placeName: string;
  judgment: ExpectedAssociation['judgment'] | null;
  outcome: AssociationOutcome;
  limitation: MatchingLimitation | null;
  cause: MatchingLimitation | null;
  reason: string;
};

export type MatchingScenarioReport = {
  id: string;
  title: string;
  notes: string;
  searchCount: number;
  discoveredStoreCount: number;
  monitoredStoreCount: number;
  collapsed: MatchingSimulation['collapsed'];
  excludedPlaceIds: string[];
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  suppressedFalsePositives: number;
  precision: number;
  recall: number;
  associations: AssociationResult[];
  unexpectedAssociations: AssociationResult[];
};

export type MatchingEvaluationReport = {
  schemaVersion: 1;
  baseline: '7A';
  pipeline: {
    nearbyCandidateLimit: number;
    nearbyRadiusMeters: number;
    fieldMask: string;
    maxMonitoredStores: number;
    duplicateDistanceMeters: number;
    geofenceRadiusMeters: number;
    geofenceFiltersMatches: false;
  };
  totals: {
    scenarios: number;
    reasonableMatches: number;
    labeledFalsePositives: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    suppressedFalsePositives: number;
    unexpectedAssociations: number;
    precision: number;
    recall: number;
  };
  priorities: {
    id: MatchingLimitation;
    order: number;
    summary: string;
  }[];
  scenarios: MatchingScenarioReport[];
};

const PHARMACY_PRIMARY_TYPES = new Set(['pharmacy', 'drugstore']);

export const MATCHING_LIMITATION_PRIORITIES: readonly {
  id: MatchingLimitation;
  summary: string;
}[] = [
  {
    id: 'monitored-15-cap',
    summary:
      'The 15-store cap can still exclude reasonable associations after item coverage is preserved.',
  },
  {
    id: 'embedded-pharmacy-secondary-type',
    summary:
      'Treat pharmacy and drugstore secondary types as pharmacy candidates when the primary type is a store that commonly contains a pharmacy.',
  },
  {
    id: 'primary-type-filter',
    summary:
      'Include gas-station markets whose primary type is gas_station when convenience_store is present as a secondary type.',
  },
  {
    id: 'per-category-candidate-cap',
    summary:
      'Rebalance the five-result Nearby Search cap so a farther store of a needed category can still be discovered after closer results fill that category.',
  },
  {
    id: 'category-broadcast',
    summary:
      'Stop assigning every item in a category to every returned store, including dispensing-only pharmacies and fuel-first markets.',
  },
  {
    id: 'duplicate-beyond-30m',
    summary:
      'Collapse same-business listings that remain separate just beyond 30 meters before they consume two monitored slots.',
  },
];

function divide(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function associationKey(itemId: string, placeId: string) {
  return `${itemId}\0${placeId}`;
}

function placeById(scenario: MatchingScenario, placeId: string) {
  return scenario.places.find((place) => place.id === placeId);
}

function itemById(scenario: MatchingScenario, itemId: string) {
  return scenario.items.find((item) => item.id === itemId);
}

function monitoredKeys(simulation: MatchingSimulation) {
  return new Set(
    simulation.monitored.flatMap((store) =>
      store.itemIds.map((itemId) => associationKey(itemId, store.placeId)),
    ),
  );
}

function neededPrimaryTypes(item: MatchingEvaluationItem): Set<string> {
  return new Set(
    item.categories.flatMap((category) => [...GOOGLE_PLACE_TYPES[category]]),
  );
}

function typeMissCause(
  place: SyntheticGooglePlace,
  item: MatchingEvaluationItem,
): MatchingLimitation | null {
  const needed = neededPrimaryTypes(item);
  if (needed.has(place.primaryType)) {
    return null;
  }

  const secondaryHit = place.types.some(
    (type) => type !== place.primaryType && needed.has(type),
  );
  if (!secondaryHit) {
    return null;
  }

  const secondaryPharmacy = place.types.some(
    (type) => type !== place.primaryType && PHARMACY_PRIMARY_TYPES.has(type),
  );
  if (
    item.categories.includes('pharmacy') &&
    secondaryPharmacy &&
    !PHARMACY_PRIMARY_TYPES.has(place.primaryType)
  ) {
    return 'embedded-pharmacy-secondary-type';
  }

  return 'primary-type-filter';
}

export function explainMiss(
  scenario: MatchingScenario,
  simulation: MatchingSimulation,
  item: MatchingEvaluationItem,
  place: SyntheticGooglePlace,
): MatchingLimitation {
  const collapsed = simulation.collapsed.find(
    (record) => record.droppedPlaceId === place.id,
  );
  if (collapsed) {
    throw new Error(
      `${scenario.id} dropped ${place.id} into ${collapsed.representativePlaceId}; label the surviving place.`,
    );
  }

  const discovered = simulation.discovered.find(
    (store) => store.placeId === place.id,
  );
  const monitored = simulation.monitored.find(
    (store) => store.placeId === place.id,
  );
  if (discovered?.itemIds.includes(item.id) && monitored === undefined) {
    return 'monitored-15-cap';
  }

  const typeCause = typeMissCause(place, item);
  if (typeCause) {
    return typeCause;
  }

  const ranks = item.categories.map((category: DestinationCategory) =>
    nearbyCategoryRank(scenario.places, scenario.anchor, category, place.id),
  );
  const matchingRanks = ranks.filter((rank): rank is number => rank !== null);
  if (
    matchingRanks.length > 0 &&
    matchingRanks.every((rank) => rank > NEARBY_CANDIDATE_LIMIT)
  ) {
    return 'per-category-candidate-cap';
  }

  throw new Error(
    `${scenario.id} could not explain a miss for ${item.id} at ${place.id}.`,
  );
}

function explainFalsePositive(
  scenario: MatchingScenario,
  simulation: MatchingSimulation,
  place: SyntheticGooglePlace,
): MatchingLimitation {
  const identity = normalizedBusinessIdentity(place.name);
  const duplicate = simulation.monitored.some((store) => {
    if (store.placeId === place.id || identity.length === 0) {
      return false;
    }
    return normalizedBusinessIdentity(store.name) === identity;
  });
  if (duplicate) {
    return 'duplicate-beyond-30m';
  }

  const discovered = simulation.discovered.some(
    (store) => store.placeId === place.id,
  );
  if (discovered) {
    return 'category-broadcast';
  }

  throw new Error(
    `${scenario.id} could not explain a false positive at ${place.id}.`,
  );
}

function outcomeFor(
  judgment: ExpectedAssociation['judgment'],
  present: boolean,
): AssociationOutcome {
  if (judgment === 'reasonable') {
    return present ? 'true-positive' : 'false-negative';
  }
  return present ? 'false-positive' : 'suppressed-false-positive';
}

function scoreScenario(
  scenario: MatchingScenario,
  simulation: MatchingSimulation,
): MatchingScenarioReport {
  const present = monitoredKeys(simulation);
  const associations: AssociationResult[] = scenario.expectations.map(
    (expected) => {
      const item = itemById(scenario, expected.itemId);
      const place = placeById(scenario, expected.placeId);
      if (item === undefined || place === undefined) {
        throw new Error(
          `${scenario.id} labels ${expected.itemId} at ${expected.placeId}, which is not in the scenario.`,
        );
      }

      const outcome = outcomeFor(
        expected.judgment,
        present.has(associationKey(expected.itemId, expected.placeId)),
      );
      const cause =
        outcome === 'false-negative'
          ? explainMiss(scenario, simulation, item, place)
          : outcome === 'false-positive'
            ? explainFalsePositive(scenario, simulation, place)
            : null;

      return {
        itemId: item.id,
        itemText: item.text,
        placeId: place.id,
        placeName: place.name,
        judgment: expected.judgment,
        outcome,
        limitation: expected.limitation,
        cause,
        reason: expected.reason,
      };
    },
  );

  const labeled = new Set(
    scenario.expectations.map((expected) =>
      associationKey(expected.itemId, expected.placeId),
    ),
  );
  const unexpectedAssociations = simulation.monitored.flatMap((store) =>
    store.itemIds
      .filter((itemId) => !labeled.has(associationKey(itemId, store.placeId)))
      .map((itemId) => ({
        itemId,
        itemText: itemById(scenario, itemId)?.text ?? itemId,
        placeId: store.placeId,
        placeName: store.name,
        judgment: null,
        outcome: 'unexpected' as const,
        limitation: null,
        cause: null,
        reason: 'Monitored association has no evaluation label.',
      })),
  );

  const count = (outcome: AssociationOutcome) =>
    associations.filter((association) => association.outcome === outcome)
      .length;
  const truePositives = count('true-positive');
  const falsePositives = count('false-positive');
  const falseNegatives = count('false-negative');

  return {
    id: scenario.id,
    title: scenario.title,
    notes: scenario.notes,
    searchCount: simulation.searchCount,
    discoveredStoreCount: simulation.discovered.length,
    monitoredStoreCount: simulation.monitored.length,
    collapsed: simulation.collapsed,
    excludedPlaceIds: simulation.excludedByMonitoredLimit.map(
      (store) => store.placeId,
    ),
    truePositives,
    falsePositives,
    falseNegatives,
    suppressedFalsePositives: count('suppressed-false-positive'),
    precision: divide(truePositives, truePositives + falsePositives),
    recall: divide(truePositives, truePositives + falseNegatives),
    associations,
    unexpectedAssociations,
  };
}

export async function evaluateMatchingScenarios(
  scenarios: readonly MatchingScenario[],
): Promise<MatchingEvaluationReport> {
  const scenarioReports: MatchingScenarioReport[] = [];
  for (const scenario of scenarios) {
    scenarioReports.push(
      scoreScenario(scenario, await simulateMatchingScenario(scenario)),
    );
  }

  const totals = scenarioReports.reduce(
    (aggregate, scenario) => ({
      scenarios: aggregate.scenarios + 1,
      reasonableMatches:
        aggregate.reasonableMatches +
        scenario.associations.filter(
          (association) => association.judgment === 'reasonable',
        ).length,
      labeledFalsePositives:
        aggregate.labeledFalsePositives +
        scenario.associations.filter(
          (association) => association.judgment === 'false-positive',
        ).length,
      truePositives: aggregate.truePositives + scenario.truePositives,
      falsePositives: aggregate.falsePositives + scenario.falsePositives,
      falseNegatives: aggregate.falseNegatives + scenario.falseNegatives,
      suppressedFalsePositives:
        aggregate.suppressedFalsePositives + scenario.suppressedFalsePositives,
      unexpectedAssociations:
        aggregate.unexpectedAssociations +
        scenario.unexpectedAssociations.length,
    }),
    {
      scenarios: 0,
      reasonableMatches: 0,
      labeledFalsePositives: 0,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      suppressedFalsePositives: 0,
      unexpectedAssociations: 0,
    },
  );
  const observedCauses = new Set(
    scenarioReports.flatMap((scenario) =>
      scenario.associations.flatMap((association) =>
        association.cause === null ? [] : [association.cause],
      ),
    ),
  );

  return {
    schemaVersion: 1,
    baseline: '7A',
    pipeline: {
      nearbyCandidateLimit: NEARBY_CANDIDATE_LIMIT,
      nearbyRadiusMeters: NEARBY_SEARCH_RADIUS_METERS,
      fieldMask: GOOGLE_PLACES_FIELD_MASK,
      maxMonitoredStores: MONITORED_STORE_LIMIT,
      duplicateDistanceMeters: DUPLICATE_STORE_DISTANCE_METERS,
      geofenceRadiusMeters: GEOFENCE_RADIUS_METERS,
      geofenceFiltersMatches: false,
    },
    totals: {
      ...totals,
      precision: divide(
        totals.truePositives,
        totals.truePositives + totals.falsePositives,
      ),
      recall: divide(
        totals.truePositives,
        totals.truePositives + totals.falseNegatives,
      ),
    },
    priorities: MATCHING_LIMITATION_PRIORITIES.flatMap((priority, index) =>
      observedCauses.has(priority.id)
        ? [{ ...priority, order: index + 1 }]
        : [],
    ),
    scenarios: scenarioReports,
  };
}

export function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatAssociation(association: AssociationResult) {
  return `  ${association.itemText} @ ${association.placeName} (${association.placeId}): ${association.reason}`;
}

export function formatMatchingReport(report: MatchingEvaluationReport): string {
  const lines = [
    'Store-to-item matching evaluation (7A fixture set)',
    `Nearby Search keeps ${report.pipeline.nearbyCandidateLimit} places per category within ${report.pipeline.nearbyRadiusMeters} m, ranked by distance.`,
    `Field mask: ${report.pipeline.fieldMask}.`,
    `Monitoring greedily covers distinct items, then fills the nearest ${report.pipeline.maxMonitoredStores} slots after collapsing duplicate businesses within ${report.pipeline.duplicateDistanceMeters} m.`,
    `Each monitored store receives a ${report.pipeline.geofenceRadiusMeters} m geofence. Matching uses the nearby radius and the item-aware monitored-store cap.`,
    '',
    `Scenarios: ${report.totals.scenarios}`,
    `Correct matches: ${report.totals.truePositives}`,
    `False positives: ${report.totals.falsePositives}`,
    `False negatives: ${report.totals.falseNegatives}`,
    `Suppressed false positives: ${report.totals.suppressedFalsePositives}`,
    `Precision: ${formatPercent(report.totals.precision)}`,
    `Recall: ${formatPercent(report.totals.recall)}`,
  ];

  if (report.totals.unexpectedAssociations > 0) {
    lines.push(
      `Unlabeled monitored associations: ${report.totals.unexpectedAssociations}`,
    );
  }

  for (const scenario of report.scenarios) {
    lines.push(
      '',
      `${scenario.title} [${scenario.id}]`,
      scenario.notes,
      `Searches: ${scenario.searchCount}. Discovered: ${scenario.discoveredStoreCount}. Monitored: ${scenario.monitoredStoreCount}.`,
      `Correct ${scenario.truePositives}, false positives ${scenario.falsePositives}, false negatives ${scenario.falseNegatives}.`,
    );

    const correct = scenario.associations.filter(
      (association) => association.outcome === 'true-positive',
    );
    if (correct.length > 0) {
      lines.push('Correct matches:');
      lines.push(...correct.map(formatAssociation));
    }

    const falsePositives = scenario.associations.filter(
      (association) => association.outcome === 'false-positive',
    );
    if (falsePositives.length > 0) {
      lines.push('False positives:');
      lines.push(...falsePositives.map(formatAssociation));
    }

    const falseNegatives = scenario.associations.filter(
      (association) => association.outcome === 'false-negative',
    );
    if (falseNegatives.length > 0) {
      lines.push('False negatives:');
      lines.push(...falseNegatives.map(formatAssociation));
    }

    if (scenario.collapsed.length > 0) {
      lines.push('Collapsed duplicate listings:');
      for (const record of scenario.collapsed) {
        lines.push(
          `  ${record.droppedPlaceId} collapsed into ${record.representativePlaceId}`,
        );
      }
    }

    if (scenario.excludedPlaceIds.length > 0) {
      lines.push(
        `Excluded by the item-aware ${report.pipeline.maxMonitoredStores}-store limit: ${scenario.excludedPlaceIds.join(', ')}`,
      );
    }
  }

  lines.push('', 'Milestone 7B priorities:');
  if (report.priorities.length === 0) {
    lines.push('  None of the recorded limitations appeared.');
  }
  for (const priority of report.priorities) {
    lines.push(`  ${priority.order}. ${priority.id}: ${priority.summary}`);
  }

  const unseen = MATCHING_LIMITATIONS.filter(
    (limitation) =>
      !report.priorities.some((priority) => priority.id === limitation),
  );
  if (unseen.length > 0) {
    lines.push(`Limitations not observed: ${unseen.join(', ')}`);
  }

  return lines.join('\n');
}
