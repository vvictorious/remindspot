import NetInfo from '@react-native-community/netinfo';
import * as Location from 'expo-location';
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import { findPlaceCandidates } from '../api/places';
import type { Item } from '../models/Item';
import {
  createPlaceRequestItemsSignature,
  parsePlaceRequestItemsSignature,
} from './place-item-projection';

type UsePlaceCandidatesOptions = {
  isLoadingItems: boolean;
  items: readonly Item[];
};

export function usePlaceCandidates({
  isLoadingItems,
  items,
}: UsePlaceCandidatesOptions) {
  const requestItemsSignature = createPlaceRequestItemsSignature(items);
  const requestItems = useMemo(
    () => parsePlaceRequestItemsSignature(requestItemsSignature),
    [requestItemsSignature],
  );
  const [isForeground, setIsForeground] = useState(
    AppState.currentState === 'active',
  );
  const [isDefinitelyOffline, setIsDefinitelyOffline] = useState(false);

  useEffect(() => {
    const appStateSubscription = AppState.addEventListener(
      'change',
      (nextState) => setIsForeground(nextState === 'active'),
    );
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      setIsDefinitelyOffline(
        state.isConnected === false || state.isInternetReachable === false,
      );
    });

    return () => {
      appStateSubscription.remove();
      unsubscribeNetInfo();
    };
  }, []);

  useEffect(() => {
    if (
      isLoadingItems ||
      !isForeground ||
      isDefinitelyOffline ||
      requestItems.length === 0
    ) {
      return;
    }

    const abortController = new AbortController();
    let isActive = true;

    async function loadCandidates() {
      console.info('[places] Discovering candidates for current items.');

      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!isActive) {
          return;
        }
        if (permission.status !== Location.PermissionStatus.GRANTED) {
          console.warn(
            '[places] Location permission was denied; candidate lookup was skipped.',
          );
          return;
        }

        const currentLocation = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!isActive) {
          return;
        }

        const location = {
          latitude: currentLocation.coords.latitude,
          longitude: currentLocation.coords.longitude,
        };
        console.info('[places] Current location obtained.', location);
        console.info('[places] Requesting candidates from the server.');

        const result = await findPlaceCandidates(
          {
            items: [...requestItems],
            location,
          },
          { signal: abortController.signal },
        );
        if (!isActive) {
          return;
        }

        for (const store of result.stores) {
          console.info(
            `[places] ${store.name} (${store.placeId}) applies to items: ${store.itemIds.join(', ')}`,
          );
        }

        for (const failure of result.categoryFailures) {
          console.warn(
            `[places] Candidate lookup failed for category: ${failure.category}`,
          );
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        console.warn(
          '[places] Candidate lookup failed; items remain available.',
          error,
        );
      }
    }

    void loadCandidates();

    return () => {
      isActive = false;
      abortController.abort();
    };
  }, [
    isDefinitelyOffline,
    isForeground,
    isLoadingItems,
    requestItems,
  ]);
}
