// Compatibility Shim for Supabase modules (Phase 1 Refactoring)
// Client and domain modules are isolated into individual, focused files.
// Server-only SSR adapter `createAstroServerClient` is located in `src/server/db/astro-client.ts`.

export * from './supabase-client';
export * from './supabase-session';
export * from './accounts';
export * from './boards';
export * from './pins';
export * from './logs';
export * from './dashboard';
export * from './schedules';
export * from './webhooks';
