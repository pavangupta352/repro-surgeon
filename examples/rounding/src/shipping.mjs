export const shippingZones = { local: 0, domestic: 500, international: 1800 };

export function shippingCents(zone, subtotal) {
  if (subtotal >= 10000) return 0;
  if (!(zone in shippingZones)) throw new Error(`Unknown shipping zone: ${zone}`);
  return shippingZones[zone];
}
