// Isolated request failures do not require operator action.
export function compatibilityDegraded(errors, attempted) {
  if (errors >= 5) return true;
  return errors >= 2 && attempted > 0 && errors / attempted >= 0.10;
}
