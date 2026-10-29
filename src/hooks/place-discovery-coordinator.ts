import {
  findPlaceCandidates,
  type PlaceCandidatesRequest,
  type PlaceCandidatesResponse,
  type PlaceStore,
} from '../api/places';
import {
  backgroundDiscoveryPlaceItemsSignature,
} from '../native/background-discovery';
import type { DestinationCategory } from '../models/Classification';
import type { PlaceRequestItem } from './place-item-projection';

export const PLACE_DISCOVERY_DEBOUNCE_MS = 400;
export const PLACE_DISCOVERY_MOVEMENT_THRESHOLD_METERS = 200;

type Location = PlaceCandidatesRequest['location'];
type TimerHandle = ReturnType<typeof setTimeout>;

export type CommittedPlaceDiscovery = {
  anchor: Location;
  requestItems: readonly PlaceRequestItem[];
  response: PlaceCandidatesResponse;
};

export type PlaceDiscoveryState = {
  status:
    | 'idle'
    | 'loading'
    | 'complete'
    | 'partial'
    | 'failed'
    | 'transport-error';
  stores: PlaceStore[];
  categoryFailures: {
    category: DestinationCategory;
    code: 'provider-error';
  }[];
  error: Error | null;
  canRetry: boolean;
  committedDiscovery: CommittedPlaceDiscovery | null;
};

export type PlaceDiscoveryCoordinatorInput = {
  items: readonly PlaceRequestItem[];
  isHydrated: boolean;
  isForeground: boolean;
  isDefinitelyOffline: boolean;
};

type Discover = typeof findPlaceCandidates;

export type PersistedDiscoveryAnchor = {
  latitude: number;
  longitude: number;
  placeItemsSignature: string;
};

export type PlaceDiscoveryCoordinatorDependencies = {
  getLocation: () => Promise<Location | null>;
  onStateChange: (state: PlaceDiscoveryState) => void;
  discover?: Discover;
  readPersistedDiscoveryAnchor?: () => Promise<PersistedDiscoveryAnchor | null>;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

type RequestSnapshot = {
  generation: number;
  itemsSignature: string;
  locationIdentity: string;
  anchor: Location;
  requestItems: readonly PlaceRequestItem[];
};

type PreviousRequest = {
  itemsSignature: string;
  location: Location;
  locationIdentity: string;
};

type InFlightAttempt = {
  controller: AbortController;
  locationIdentity: string;
};

export const INITIAL_PLACE_DISCOVERY_STATE: PlaceDiscoveryState = {
  status: 'idle',
  stores: [],
  categoryFailures: [],
  error: null,
  canRetry: false,
  committedDiscovery: null,
};

function itemsSignature(items: readonly PlaceRequestItem[]): string {
  return JSON.stringify(items);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Place discovery failed.');
}

function distanceInMeters(left: Location, right: Location): number {
  const earthRadiusMeters = 6_371_000;
  const degreesToRadians = Math.PI / 180;
  const latitudeDelta =
    (right.latitude - left.latitude) * degreesToRadians;
  const longitudeDelta =
    (right.longitude - left.longitude) * degreesToRadians;
  const leftLatitude = left.latitude * degreesToRadians;
  const rightLatitude = right.latitude * degreesToRadians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    2 *
    earthRadiusMeters *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

function locationIdentity(location: Location): string {
  return `${location.latitude},${location.longitude}`;
}

function copyRequestItems(
  items: readonly PlaceRequestItem[],
): readonly PlaceRequestItem[] {
  return Object.freeze(
    items.map((item) =>
      Object.freeze({
        id: item.id,
        revision: item.revision,
        taxonomyVersion: item.taxonomyVersion,
        categories: Object.freeze([
          ...item.categories,
        ]) as PlaceRequestItem['categories'],
      }),
    ),
  );
}

function freezeDiscovery(discovery: CommittedPlaceDiscovery): void {
  Object.freeze(discovery.anchor);
  for (const item of discovery.requestItems) {
    Object.freeze(item.categories);
    Object.freeze(item);
  }
  Object.freeze(discovery.requestItems);
  for (const failure of discovery.response.categoryFailures) {
    Object.freeze(failure);
  }
  Object.freeze(discovery.response.categoryFailures);
  for (const store of discovery.response.stores) {
    Object.freeze(store.location);
    Object.freeze(store.itemIds);
    Object.freeze(store);
  }
  Object.freeze(discovery.response.stores);
  Object.freeze(discovery.response);
  Object.freeze(discovery);
}

function commitDiscoveryEnvelope(
  snapshot: RequestSnapshot,
  response: PlaceCandidatesResponse,
): CommittedPlaceDiscovery {
  const discovery: CommittedPlaceDiscovery = {
    anchor: snapshot.anchor,
    requestItems: snapshot.requestItems,
    response: {
      status: response.status,
      stores: response.stores.map((store) => ({
        placeId: store.placeId,
        name: store.name,
        location: {
          latitude: store.location.latitude,
          longitude: store.location.longitude,
        },
        itemIds: [...store.itemIds],
      })),
      categoryFailures: response.categoryFailures.map((failure) => ({
        category: failure.category,
        code: failure.code,
      })),
    },
  };
  freezeDiscovery(discovery);
  return discovery;
}

export class PlaceDiscoveryCoordinator {
  private readonly getLocation: () => Promise<Location | null>;
  private readonly discover: Discover;
  private readonly readPersistedDiscoveryAnchor:
    | (() => Promise<PersistedDiscoveryAnchor | null>)
    | undefined;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private onStateChange: (state: PlaceDiscoveryState) => void;

  private input: PlaceDiscoveryCoordinatorInput = {
    items: [],
    isHydrated: false,
    isForeground: true,
    isDefinitelyOffline: false,
  };
  private state = INITIAL_PLACE_DISCOVERY_STATE;
  private isStarted = false;
  private generation = 0;
  private timer: TimerHandle | null = null;
  private inFlight: AbortController | null = null;
  private inFlightAttempt: InFlightAttempt | null = null;
  private previousRequest: PreviousRequest | null = null;

  constructor(dependencies: PlaceDiscoveryCoordinatorDependencies) {
    this.getLocation = dependencies.getLocation;
    this.discover = dependencies.discover ?? findPlaceCandidates;
    this.readPersistedDiscoveryAnchor =
      dependencies.readPersistedDiscoveryAnchor;
    this.setTimer =
      dependencies.setTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = dependencies.clearTimer ?? clearTimeout;
    this.onStateChange = dependencies.onStateChange;
  }

  setStateListener(listener: (state: PlaceDiscoveryState) => void): void {
    this.onStateChange = listener;
    listener(this.state);
  }

  start(): void {
    this.isStarted = true;
    this.scheduleIfEligible(PLACE_DISCOVERY_DEBOUNCE_MS);
  }

  stop(): void {
    this.isStarted = false;
    this.invalidatePending();
  }

  update(input: PlaceDiscoveryCoordinatorInput): void {
    const previousSignature = itemsSignature(this.input.items);
    const nextSignature = itemsSignature(input.items);
    const inputsChanged = previousSignature !== nextSignature;
    const wasRunnable = this.canRun();

    this.input = input;

    if (inputsChanged) {
      this.invalidatePending();
      this.previousRequest = null;
      this.setState(
        nextSignature === '[]'
          ? INITIAL_PLACE_DISCOVERY_STATE
          : {
              status: 'loading',
              stores: [],
              categoryFailures: [],
              error: null,
              canRetry: false,
              committedDiscovery: null,
            },
      );
    }

    if (!this.canRun()) {
      if (wasRunnable || inputsChanged) {
        this.invalidatePending();
        if (this.state.status === 'loading') {
          this.setState(INITIAL_PLACE_DISCOVERY_STATE);
        }
      }
      return;
    }

    if (inputsChanged) {
      this.scheduleIfEligible(PLACE_DISCOVERY_DEBOUNCE_MS);
    } else if (!wasRunnable) {
      this.scheduleIfEligible(PLACE_DISCOVERY_DEBOUNCE_MS);
    }
  }

  retry(): void {
    if (!this.canRun() || !this.state.canRetry) {
      return;
    }

    this.invalidatePending();
    this.setState({
      ...this.state,
      status: 'loading',
      error: null,
      canRetry: false,
    });
    this.scheduleIfEligible(0, true);
  }

  private canRun(): boolean {
    return (
      this.isStarted &&
      this.input.isHydrated &&
      this.input.isForeground &&
      !this.input.isDefinitelyOffline &&
      this.input.items.length > 0
    );
  }

  private scheduleIfEligible(delayMs: number, force = false): void {
    if (!this.canRun()) {
      return;
    }

    this.clearScheduled();
    const generation = this.generation;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run(generation, force);
    }, delayMs);
  }

  private async run(generation: number, force: boolean): Promise<void> {
    const requestItems = copyRequestItems(this.input.items);
    const requestItemsSignature = itemsSignature(requestItems);
    let requestController: AbortController | null = null;
    let attemptRequest: PreviousRequest | null = null;

    try {
      const location = await this.getLocation();
      if (!this.isCurrent(generation, requestItemsSignature)) {
        return;
      }
      if (location === null) {
        this.setTransportError(
          new Error('Location permission is required for place discovery.'),
        );
        return;
      }

      const anchor = Object.freeze({
        latitude: location.latitude,
        longitude: location.longitude,
      });
      if (!force) {
        const persistedAnchor = await this.readPersistedAnchor();
        if (!this.isCurrent(generation, requestItemsSignature)) {
          return;
        }
        if (
          persistedAnchor !== null &&
          persistedAnchor.placeItemsSignature ===
            backgroundDiscoveryPlaceItemsSignature(requestItems) &&
          distanceInMeters(persistedAnchor, anchor) <
            PLACE_DISCOVERY_MOVEMENT_THRESHOLD_METERS
        ) {
          this.previousRequest = {
            itemsSignature: requestItemsSignature,
            location: {
              latitude: persistedAnchor.latitude,
              longitude: persistedAnchor.longitude,
            },
            locationIdentity: locationIdentity(persistedAnchor),
          };
          return;
        }
      }
      const previous = this.previousRequest;
      const reusesLocationIdentity =
        previous !== null &&
        previous.itemsSignature === requestItemsSignature &&
        distanceInMeters(previous.location, anchor) <
          PLACE_DISCOVERY_MOVEMENT_THRESHOLD_METERS;
      const currentLocationIdentity = reusesLocationIdentity
        ? previous.locationIdentity
        : locationIdentity(anchor);

      if (reusesLocationIdentity && !force) {
        return;
      }

      const snapshot: RequestSnapshot = {
        generation,
        itemsSignature: requestItemsSignature,
        locationIdentity: currentLocationIdentity,
        anchor,
        requestItems,
      };
      requestController = new AbortController();
      attemptRequest = {
        itemsSignature: requestItemsSignature,
        location: anchor,
        locationIdentity: currentLocationIdentity,
      };
      this.inFlight = requestController;
      this.inFlightAttempt = {
        controller: requestController,
        locationIdentity: currentLocationIdentity,
      };
      this.setState({
        ...this.state,
        status: 'loading',
        error: null,
        canRetry: false,
      });

      const response = await this.discover(
        { items: [...requestItems], location: anchor },
        { signal: requestController.signal },
      );
      if (!this.isFresh(snapshot, requestController)) {
        return;
      }

      this.previousRequest = attemptRequest;
      this.applyResponse(snapshot, response);
    } catch (error) {
      if (
        this.generation !== generation ||
        requestController?.signal.aborted
      ) {
        return;
      }
      if (
        requestController !== null &&
        this.inFlightAttempt?.controller !== requestController
      ) {
        return;
      }
      if (attemptRequest !== null) {
        this.previousRequest = attemptRequest;
      }
      this.setTransportError(toError(error));
    } finally {
      if (this.inFlight === requestController) {
        this.inFlight = null;
      }
      if (this.inFlightAttempt?.controller === requestController) {
        this.inFlightAttempt = null;
      }
    }
  }

  private async readPersistedAnchor(): Promise<PersistedDiscoveryAnchor | null> {
    if (this.readPersistedDiscoveryAnchor === undefined) {
      return null;
    }

    try {
      return await this.readPersistedDiscoveryAnchor();
    } catch {
      return null;
    }
  }

  private isCurrent(generation: number, signature: string): boolean {
    return (
      this.generation === generation &&
      this.canRun() &&
      itemsSignature(this.input.items) === signature
    );
  }

  private isFresh(
    snapshot: RequestSnapshot,
    controller: AbortController,
  ): boolean {
    return (
      !controller.signal.aborted &&
      this.isCurrent(snapshot.generation, snapshot.itemsSignature) &&
      this.inFlightAttempt?.controller === controller &&
      this.inFlightAttempt.locationIdentity === snapshot.locationIdentity
    );
  }

  private applyResponse(
    snapshot: RequestSnapshot,
    response: PlaceCandidatesResponse,
  ): void {
    this.setState({
      status: response.status,
      stores: response.stores,
      categoryFailures: response.categoryFailures,
      error: null,
      canRetry: response.status !== 'complete',
      committedDiscovery: commitDiscoveryEnvelope(snapshot, response),
    });
  }

  private setTransportError(error: Error): void {
    this.setState({
      ...this.state,
      status: 'transport-error',
      error,
      canRetry: true,
    });
  }

  private invalidatePending(): void {
    this.generation += 1;
    this.clearScheduled();
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private clearScheduled(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private setState(state: PlaceDiscoveryState): void {
    this.state = state;
    this.onStateChange(state);
  }
}
