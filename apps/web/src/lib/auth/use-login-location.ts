'use client';

import { useEffect, useRef, useState } from 'react';

export interface LoginLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

export type LocationState = 'pending' | 'granted' | 'denied' | 'unavailable';

/**
 * Ask the browser for the device location when the sign-in page opens, so the permission prompt
 * shows while the user is typing. Sign-in never waits for it: whatever is known at submit time is
 * attached to the login event (docs/SECURITY.md §1.6); denial is fine and simply means no location.
 */
export function useLoginLocation() {
  const [state, setState] = useState<LocationState>('pending');
  const ref = useRef<LoginLocation | undefined>(undefined);
  useEffect(() => {
    // No geolocation support: stay 'pending' (shown the same as unavailable) — nothing to ask.
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        ref.current = { latitude: Number(p.coords.latitude.toFixed(6)), longitude: Number(p.coords.longitude.toFixed(6)), accuracy: Math.round(p.coords.accuracy) };
        setState('granted');
      },
      (err) => setState(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 5 * 60_000 },
    );
  }, []);
  return { state, current: () => ref.current };
}
