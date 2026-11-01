/**
 * ⚙️ Discovery schedule — change the number, then push (or `npm run deploy`).
 *
 * كل قد إيه Bello يدوّر على موديلات مجانية جديدة، بالأيام.
 * 1 = كل يوم · 2 = كل يومين · 3 = كل 3 أيام · 0.5 = كل 12 ساعة
 *
 * How it works: Cloudflare wakes the app once an hour (cheap, does nothing most hours).
 * When this many days have passed since the last round, a new round starts and scans one
 * provider per hour until all are done — so a round takes a few hours, not one big run.
 */
export const SCAN_EVERY_DAYS = 2;
