import * as Notifications from 'expo-notifications';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import ThereYouGoLocationNotification from '../../modules/there-you-go-location-notification/src/ThereYouGoLocationNotificationModule';
import type { Item } from '../models/Item';
import {
  GeofenceSchedulingCoordinator,
  type GeofenceSchedulingStatus,
} from './geofence-scheduling-coordinator';
import type { CommittedPlaceDiscovery } from './place-discovery-coordinator';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

type UseGeofenceSchedulingOptions = {
  items: readonly Item[];
  isLoadingItems: boolean;
  committedDiscovery: CommittedPlaceDiscovery | null;
};

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

export function useGeofenceScheduling({
  items,
  isLoadingItems,
  committedDiscovery,
}: UseGeofenceSchedulingOptions): GeofenceSchedulingStatus {
  const [status, setStatus] = useState<GeofenceSchedulingStatus>(
    ThereYouGoLocationNotification === null
      ? {
          status: 'error',
          error: new Error(
            'Native geofence scheduling is unavailable on this build.',
          ),
        }
      : { status: 'idle' },
  );
  const [coordinator] = useState(() =>
    ThereYouGoLocationNotification === null
      ? null
      : new GeofenceSchedulingCoordinator({
          nativeClient: ThereYouGoLocationNotification,
          onStatusChange: setStatus,
        }),
  );

  useEffect(() => {
    coordinator?.update({
      items,
      isHydrated: !isLoadingItems,
      committedDiscovery,
    });
  }, [committedDiscovery, coordinator, isLoadingItems, items]);

  useEffect(() => {
    if (coordinator === null) {
      developmentLog('warn', 'native module unavailable', {});
      return;
    }

    const schedulingCoordinator = coordinator;
    let isActive = true;

    async function prepareAndStart() {
      try {
        let permission = await Notifications.getPermissionsAsync();
        if (permission.status !== Notifications.PermissionStatus.GRANTED) {
          permission = await Notifications.requestPermissionsAsync();
        }

        developmentLog(
          permission.status === Notifications.PermissionStatus.GRANTED
            ? 'info'
            : 'warn',
          'notification permission resolved',
          { status: permission.status },
        );
      } catch (error) {
        developmentLog('warn', 'notification permission request failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (isActive) {
        schedulingCoordinator.start();
      }
    }

    void prepareAndStart();

    return () => {
      isActive = false;
      schedulingCoordinator.stop();
    };
  }, [coordinator]);

  useEffect(() => {
    if (coordinator === null) {
      return;
    }

    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (previousState !== 'active' && nextState === 'active') {
        coordinator.resume();
      }
      previousState = nextState;
    });

    return () => subscription.remove();
  }, [coordinator]);

  return status;
}
