import type { Account, Pin } from './types';

// Client Session State Tracking for Accounts Schedule & Settings
export const editedAccountScheduleSession = new Map<string, Partial<Account>>();

// Session state tracking maps for persistent client mutations
export const deletedPinIdsSession = new Set<string>();
export const editedPinsSession = new Map<string, Partial<Pin>>();
