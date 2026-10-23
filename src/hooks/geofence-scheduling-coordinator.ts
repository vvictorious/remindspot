import type {
  NativeGeofenceState,
  NativeSyncResult,
} from '../../modules/there-you-go-location-notification/src/ThereYouGoLocationNotificationModule';
import type { Item } from '../models/Item';
import { toNativeCandidateSnapshot } from '../native/geofence-native-contract';
import {
  buildCandidateSnapshotV1,
  sanitizeCandidateSnapshotV1,
  type CandidateSnapshotV1,
} from './geofence-candidate-snapshot';
import type { CommittedPlaceDiscovery } from './place-discovery-coordinator';

type NativeSchedulingClient = {
  getStateAsync: () => Promise<NativeGeofenceState>;
  getScheduledAsync: (
    identifier: string,
  ) => Promise<{ radius: number } | null>;
  syncAsync: (
    snapshot: ReturnType<typeof toNativeCandidateSnapshot>,
  ) => Promise<NativeSyncResult>;
};

export type GeofenceSchedulingInput = {
  items: readonly Item[];
  isHydrated: boolean;
  committedDiscovery: CommittedPlaceDiscovery | null;
};

export type GeofenceSchedulingStatus =
  | { status: 'idle' | 'initializing' }
  | {
      status: 'ready';
      selectedPlaceCount: number;
      pendingRequestCount: number;
      isDegraded: boolean;
      observationEligible: boolean;
      missingObservationRequirements: string[];
    }
  | { status: 'error'; error: Error };

export type GeofenceSchedulingCoordinatorDependencies = {
  nativeClient: NativeSchedulingClient;
  onStatusChange?: (status: GeofenceSchedulingStatus) => void;
  now?: () => Date;
  log?: (
    level: 'info' | 'warn',
    message: string,
    details: Record<string, unknown>,
  ) => void;
};

const INITIAL_INPUT: GeofenceSchedulingInput = {
  items: [],
  isHydrated: false,
  committedDiscovery: null,
};

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Native geofence scheduling failed.');
}

function developmentLog(
  level: 'info' | 'warn',
  message: string,
  details: Record<string, unknown>,
): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) {
    return;
  }

  if (level === 'warn') {
    console.warn(`[geofence] ${message}`, details);
  } else {
    console.info(`[geofence] ${message}`, details);
  }
}

function itemsSignature(items: readonly Item[]): string {
  return JSON.stringify(items);
}

function snapshotContentSignature(snapshot: CandidateSnapshotV1): string {
  return JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    discoveryAnchor: snapshot.discoveryAnchor,
    items: snapshot.items,
    stores: snapshot.stores,
  });
}

function asCandidateSnapshot(
  snapshot: NativeGeofenceState['snapshot'],
): CandidateSnapshotV1 | null {
  if (snapshot === null) {
    return null;
  }

  // Native state has already passed the same versioned snapshot validator.
  return snapshot as CandidateSnapshotV1;
}

function pendingStoreLogDetails(
  state: NativeGeofenceState,
): Record<string, unknown> {
  const itemsById = new Map(
    state.snapshot?.items.map((item) => [item.id, item.text]) ?? [],
  );

  return {
    isDegraded: state.isDegraded,
    observationEligible: state.observationEligible,
    missingObservationRequirements: state.missingObservationRequirements,
    stores: state.requests
      .filter((request) => request.status === 'pending' && request.isPending)
      .map((request) => {
        const store = state.snapshot?.stores.find(
          (candidate) => candidate.placeId === request.placeId,
        );

        return {
          name: store?.name ?? null,
          latitude: store?.location.latitude ?? null,
          longitude: store?.location.longitude ?? null,
          selected: state.selectedPlaceIds.includes(request.placeId),
          items: request.items
            .map((item) => itemsById.get(item.id) ?? item.id)
            .join(', '),
        };
      }),
  };
}

export class GeofenceSchedulingCoordinator {
  private readonly nativeClient: NativeSchedulingClient;
  private readonly onStatusChange: (
    status: GeofenceSchedulingStatus,
  ) => void;
  private readonly now: () => Date;
  private readonly log: GeofenceSchedulingCoordinatorDependencies['log'];

  private input = INITIAL_INPUT;
  private inputSignature = itemsSignature(INITIAL_INPUT.items);
  private nativeState: NativeGeofenceState | null = null;
  private lastAppliedDiscovery: CommittedPlaceDiscovery | null = null;
  private isStarted = false;
  private isInitialized = false;
  private operationQueue = Promise.resolve();
  private reconcileQueued = false;

  constructor(dependencies: GeofenceSchedulingCoordinatorDependencies) {
    this.nativeClient = dependencies.nativeClient;
    this.onStatusChange = dependencies.onStatusChange ?? (() => undefined);
    this.now = dependencies.now ?? (() => new Date());
    this.log = dependencies.log ?? developmentLog;
  }

  start(): void {
    if (this.isStarted) {
      return;
    }

    this.isStarted = true;
    this.onStatusChange({ status: 'initializing' });
    this.enqueue(async () => {
      await this.refreshNativeState('initialized');
      await this.logInstalledRadii();
      this.isInitialized = true;
      this.requestReconcile();
    });
  }

  stop(): void {
    this.isStarted = false;
  }

  update(input: GeofenceSchedulingInput): void {
    const nextItemsSignature = itemsSignature(input.items);
    const itemsChanged = nextItemsSignature !== this.inputSignature;
    const becameHydrated = input.isHydrated && !this.input.isHydrated;
    const hasNewCompleteDiscovery =
      input.committedDiscovery !== null &&
      input.committedDiscovery !== this.input.committedDiscovery &&
      input.committedDiscovery.response.status === 'complete';

    this.input = input;
    this.inputSignature = nextItemsSignature;

    if (itemsChanged || becameHydrated || hasNewCompleteDiscovery) {
      this.requestReconcile();
    }
  }

  resume(): void {
    if (!this.isStarted) {
      return;
    }

    this.enqueue(async () => {
      await this.refreshNativeState('resumed');
      this.isInitialized = true;
      this.requestReconcile();
    });
  }

  private requestReconcile(): void {
    if (
      !this.isStarted ||
      !this.isInitialized ||
      !this.input.isHydrated ||
      this.reconcileQueued
    ) {
      return;
    }

    this.reconcileQueued = true;
    this.enqueue(async () => {
      this.reconcileQueued = false;
      await this.reconcileLatest();
    });
  }

  private enqueue(operation: () => Promise<void>): void {
    this.operationQueue = this.operationQueue
      .catch(() => undefined)
      .then(async () => {
        if (!this.isStarted) {
          return;
        }

        try {
          await operation();
        } catch (error) {
          const schedulingError = toError(error);
          this.onStatusChange({ status: 'error', error: schedulingError });
          this.log?.('warn', 'operation failed', {
            error: schedulingError.message,
          });
        }
      });
  }

  private async refreshNativeState(reason: 'initialized' | 'resumed') {
    const state = await this.nativeClient.getStateAsync();
    if (!this.isStarted) {
      return;
    }

    this.nativeState = state;
    this.publishReadyState(state);
    this.log?.('info', reason, {
      selectedPlaceCount: state.selectedPlaceIds.length,
      pendingRequestCount: state.pendingManagedRequestIds.length,
      isDegraded: state.isDegraded,
      observationEligible: state.observationEligible,
      missingObservationRequirements: state.missingObservationRequirements,
      discoveryAnchor: state.snapshot?.discoveryAnchor ?? null,
      generatedAt: state.snapshot?.generatedAt ?? null,
    });
  }

  private async logInstalledRadii(): Promise<void> {
    if (
      typeof __DEV__ === 'undefined' ||
      !__DEV__ ||
      !this.isStarted ||
      this.nativeState === null
    ) {
      return;
    }

    const state = this.nativeState;
    try {
      const stores = await Promise.all(
        state.requests
          .filter(
            (request) => request.status === 'pending' && request.isPending,
          )
          .map(async (request) => {
            const scheduled = await this.nativeClient.getScheduledAsync(
              request.installationId,
            );
            const store = state.snapshot?.stores.find(
              (candidate) => candidate.placeId === request.placeId,
            );

            return {
              name: store?.name ?? null,
              radiusMeters: scheduled?.radius ?? null,
            };
          }),
      );
      if (!this.isStarted) {
        return;
      }

      this.log?.('info', 'installed radii', { stores });
    } catch (error) {
      this.log?.('warn', 'installed radii unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async reconcileLatest(): Promise<void> {
    if (this.nativeState === null || !this.input.isHydrated) {
      return;
    }

    const previousSnapshot = asCandidateSnapshot(this.nativeState.snapshot);
    const discovery = this.input.committedDiscovery;
    const canApplyDiscovery =
      discovery !== null &&
      discovery !== this.lastAppliedDiscovery &&
      discovery.response.status === 'complete';
    const generatedAt = this.nextGeneratedAt(previousSnapshot);
    let nextSnapshot: CandidateSnapshotV1;

    if (canApplyDiscovery) {
      nextSnapshot = buildCandidateSnapshotV1({
        generatedAt,
        items: this.input.items,
        discovery,
        previousSnapshot,
      });
    } else if (previousSnapshot !== null) {
      nextSnapshot = sanitizeCandidateSnapshotV1({
        generatedAt,
        items: this.input.items,
        snapshot: previousSnapshot,
      });
    } else {
      return;
    }

    if (
      previousSnapshot !== null &&
      !this.nativeState.isDegraded &&
      snapshotContentSignature(previousSnapshot) ===
        snapshotContentSignature(nextSnapshot)
    ) {
      if (canApplyDiscovery) {
        this.lastAppliedDiscovery = discovery;
      }
      this.publishReadyState(this.nativeState);
      return;
    }

    const result = await this.nativeClient.syncAsync(
      toNativeCandidateSnapshot(nextSnapshot),
    );
    if (!this.isStarted) {
      return;
    }

    this.nativeState = result.state;
    if (canApplyDiscovery) {
      this.lastAppliedDiscovery = discovery;
    }
    this.publishReadyState(result.state);
    this.log?.(result.failures.length > 0 ? 'warn' : 'info', 'sync complete', {
      scheduledPlaceIds: result.scheduledPlaceIds,
      unchangedPlaceIds: result.unchangedPlaceIds,
      canceledPlaceIds: result.canceledPlaceIds,
      consumedPlaceIds: result.consumedPlaceIds,
      retainedFallbackPlaceIds: result.retainedFallbackPlaceIds,
      failures: result.failures,
      isDegraded: result.state.isDegraded,
      observationEligible: result.state.observationEligible,
      missingObservationRequirements:
        result.state.missingObservationRequirements,
    });
  }

  private nextGeneratedAt(
    previousSnapshot: CandidateSnapshotV1 | null,
  ): string {
    const now = this.now().getTime();
    const previousTimestamp =
      previousSnapshot === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(previousSnapshot.generatedAt);
    return new Date(Math.max(now, previousTimestamp + 1)).toISOString();
  }

  private publishReadyState(state: NativeGeofenceState): void {
    this.onStatusChange({
      status: 'ready',
      selectedPlaceCount: state.selectedPlaceIds.length,
      pendingRequestCount: state.pendingManagedRequestIds.length,
      isDegraded: state.isDegraded,
      observationEligible: state.observationEligible,
      missingObservationRequirements: state.missingObservationRequirements,
    });
    this.log?.('info', 'pending stores', pendingStoreLogDetails(state));
  }
}
