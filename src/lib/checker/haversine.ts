/**
 * haversine.ts — great-circle distance for the EXIF GPS criterion (CC-083).
 *
 * The earth radius is pinned (6371000 m, the mean radius) rather than borrowed from a
 * dependency, because it is a threshold input: it changes borderline distances, it is
 * covered by `checkerHash`, and a dependency updating its constant would silently move
 * every boundary case. Same reason this file has no imports.
 */

const EARTH_RADIUS_M = 6371000;

export function haversineDistanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}
