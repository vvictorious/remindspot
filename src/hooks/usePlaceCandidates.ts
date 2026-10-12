import NetInfo from '@react-native-community/netinfo';
import * as Location from 'expo-location';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import type { Item } from '../models/Item';
import {
  INITIAL_PLACE_DISCOVERY_STATE,
  PlaceDiscoveryCoordinator,
  type PlaceDiscoveryState,
} from './place-discovery-coordinator';
import {
  createPlaceRequestItemsSignature,
  parsePlaceRequestItemsSignature,
} from './place-item-projection';

type UsePlaceCandidatesOptions = {
  isLoadingItems: boolean;
  items: readonly Item[];
};

export type UsePlaceCandidatesResult = PlaceDiscoveryState & {
  retry: () => void;
};

export function usePlaceCandidates({
  isLoadingItems,
  items,
}: UsePlaceCandidatesOptions): UsePlaceCandidatesResult {
  const requestItemsSignature = createPlaceRequestItemsSignature(items);
  const requestItems = useMemo(
    () => parsePlaceRequestItemsSignature(requestItemsSignature),
    [requestItemsSignature],
  );
  const [discoveryState, setDiscoveryState] = useState(
    INITIAL_PLACE_DISCOVERY_STATE,
  );
  const [coordinator] = useState(
    () =>
      new PlaceDiscoveryCoordinator({
        getLocation: async () => {
          const permission =
            await Location.requestForegroundPermissionsAsync();
          if (permission.status !== Location.PermissionStatus.GRANTED) {
            return null;
          }

          const currentLocation = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          return {
            latitude: currentLocation.coords.latitude,
            longitude: currentLocation.coords.longitude,
          };
        },
        onStateChange: setDiscoveryState,
      }),
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
    coordinator.setStateListener(setDiscoveryState);
    coordinator.start();
    return () => coordinator.stop();
  }, [coordinator]);

  useEffect(() => {
    coordinator.update({
      items: requestItems,
      isHydrated: !isLoadingItems,
      isForeground,
      isDefinitelyOffline,
    });
  }, [
    coordinator,
    isDefinitelyOffline,
    isForeground,
    isLoadingItems,
    requestItems,
  ]);

  const retry = useCallback(() => coordinator.retry(), [coordinator]);

  return {
    ...discoveryState,
    retry,
  };
}
