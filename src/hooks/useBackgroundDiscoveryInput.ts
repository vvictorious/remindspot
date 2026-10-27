import { useEffect, useMemo } from 'react';

import ThereYouGoLocationNotification from '../../modules/there-you-go-location-notification/src/ThereYouGoLocationNotificationModule';
import type { Item } from '../models/Item';
import {
  BACKGROUND_DISCOVERY_SCHEMA_VERSION,
  backgroundDiscoveryItemsFromItems,
} from '../native/background-discovery';

type UseBackgroundDiscoveryInputOptions = {
  isHydrated: boolean;
  items: readonly Item[];
};

function apiBaseUrl(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, '') ?? '';
}

export function createBackgroundDiscoveryInput(
  items: readonly Item[],
  updatedAt: string,
) {
  return {
    schemaVersion: BACKGROUND_DISCOVERY_SCHEMA_VERSION,
    apiBaseUrl: apiBaseUrl(),
    items: backgroundDiscoveryItemsFromItems(items),
    updatedAt,
  };
}

export function useBackgroundDiscoveryInput({
  isHydrated,
  items,
}: UseBackgroundDiscoveryInputOptions): void {
  const payload = useMemo(
    () => createBackgroundDiscoveryInput(items, new Date().toISOString()),
    [items],
  );
  const publicationKey = JSON.stringify({
    apiBaseUrl: payload.apiBaseUrl,
    items: payload.items,
  });

  useEffect(() => {
    if (!isHydrated || ThereYouGoLocationNotification === null) {
      return;
    }

    void ThereYouGoLocationNotification.setBackgroundDiscoveryInputAsync({
      ...payload,
      updatedAt: new Date().toISOString(),
    });
  }, [isHydrated, payload, publicationKey]);
}
