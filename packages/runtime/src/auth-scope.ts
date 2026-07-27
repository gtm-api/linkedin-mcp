import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthScope } from './types';

// Per-request auth scope carried via AsyncLocalStorage.
//
// One Worker isolate serves concurrent tenants; storing per-request credentials
// in module-level state lets request B overwrite request A's token while A is
// suspended at an `await` (cross-tenant credential bleed). AsyncLocalStorage
// gives every request its own store that propagates across awaits/timers and is
// invisible to other in-flight requests.
//
// FAIL-CLOSED: unlike a stdio server, this transport is HTTP-only, so there is
// no single-tenant fallback: a missing scope is a bug, never a default.

const storage = new AsyncLocalStorage<AuthScope>();

export function runWithAuthScope<T>(scope: AuthScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function getAuthScope(): AuthScope {
  const scope = storage.getStore();
  if (!scope) {
    throw new Error('AuthScope missing: tool handler invoked outside runWithAuthScope');
  }
  return scope;
}

export function tryGetAuthScope(): AuthScope | undefined {
  return storage.getStore();
}
