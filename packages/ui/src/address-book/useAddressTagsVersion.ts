/**
 * Subscribe a component to the core address tag registry.
 *
 * The registry is module state in core, written by effects: the address book
 * rebuild in AddressBookContext and the network swap in SafeRouteProvider. A
 * component that reads it during render (the address badge) or in an effect
 * (the security analysis) must run again after those writes, or it keeps
 * what it read before them. This hook returns the registry version and
 * re-renders the caller whenever it changes. Put the returned value in the
 * dependency list of any effect that reads the registry.
 */

import { useSyncExternalStore } from 'react';
import { getAddressTagsVersion, subscribeAddressTags } from '@shield3/sky-safe-core';

export function useAddressTagsVersion(): number {
  return useSyncExternalStore(subscribeAddressTags, getAddressTagsVersion);
}
