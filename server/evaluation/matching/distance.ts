export type MatchingCoordinates = {
  latitude: number;
  longitude: number;
};

const EARTH_RADIUS_METERS = 6_371_000;

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Haversine used by the portable native geofence contract. */
export function distanceInMeters(
  left: MatchingCoordinates,
  right: MatchingCoordinates,
): number {
  const degreesToRadians = Math.PI / 180;
  const latitudeDelta = (right.latitude - left.latitude) * degreesToRadians;
  const longitudeDelta = (right.longitude - left.longitude) * degreesToRadians;
  const leftLatitude = left.latitude * degreesToRadians;
  const rightLatitude = right.latitude * degreesToRadians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    2 *
    EARTH_RADIUS_METERS *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

export function offsetMeters(
  origin: MatchingCoordinates,
  northMeters: number,
  eastMeters = 0,
): MatchingCoordinates {
  const degreesPerRadian = 180 / Math.PI;
  const latitude =
    origin.latitude + (northMeters / EARTH_RADIUS_METERS) * degreesPerRadian;
  const latitudeRadians = (latitude * Math.PI) / 180;
  const longitude =
    origin.longitude +
    (eastMeters / (EARTH_RADIUS_METERS * Math.cos(latitudeRadians))) *
      degreesPerRadian;

  return { latitude, longitude };
}
