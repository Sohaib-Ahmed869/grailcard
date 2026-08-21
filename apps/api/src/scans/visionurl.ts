/** Render's blueprint `fromService` injects a bare host ("x.onrender.com")
 *  with no scheme, and a schemeless URL makes fetch() throw. Accept both.
 *
 *  Lives in its own module because both scans.service.ts and tcgdex.ts need it
 *  at module-init time, and those two already import each other — putting it in
 *  either would make the cycle resolve to `undefined` at load.  */
export function normaliseVisionUrl(raw?: string): string {
  if (!raw) return "http://localhost:8100";
  const trimmed = raw.replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
