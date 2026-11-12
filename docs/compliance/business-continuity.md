# Business continuity plan (ISO 22301)

Last updated: 12 Nov 2026 · Owner: to be named · Test: restore drill every quarter

## What must keep working

| Service | Why it matters | Target to restore | Most data we can lose |
|---|---|---|---|
| Live tracking, SOS and late-ride alerts | Safety of people in a ride | 15 minutes | None for rides in progress |
| Starting and ending rides (OTP, bill) | Rides in progress must finish | 30 minutes | 5 minutes |
| New bookings | Drivers' income | 1 hour | 5 minutes |
| Wallet, invoices, insights | Money records | 4 hours | 5 minutes |
| Privacy and authority requests | Legal deadlines (days) | 1 day | 1 hour |

## What is built

- **Health check:** `GET /healthz` answers when the app and database are working. Point an uptime monitor at it.
- **Backup:** `npm run backup` writes a consistent copy of the database while the app is running.
- **Restore:** stop the app, put the backup file at the `OLUB_DB` path, start the app.
- **Simple recovery:** the app server keeps no state of its own. A new server with the same database file and settings is a full replacement.
- **If a ride is running when the server fails:** the driver's phone keeps trying to send GPS; the customer's tracking link works again as soon as the server is back; the fare is worked out from start and end times, so nothing is lost.

## What the company must set up

1. Hosting in India with automatic restart and a second zone or region.
2. A backup schedule (every 5 minutes for the money tables, or a managed database), with copies kept off the server and encrypted.
3. A second SMS provider for OTP codes and safety alerts.
4. A named recovery team with phone numbers, and who decides to switch to the backup site.
5. A restore drill each quarter: restore last night's backup on a fresh server and run `npm test`.

## If things go wrong

| Situation | First 15 minutes | Then |
|---|---|---|
| App server down | Uptime monitor alerts the on-call person; restart or start the standby | Check rides that were in progress; call customers whose ride shows no GPS for 10 minutes |
| Database damaged | Stop the app; restore the latest backup | Run the audit-log integrity check; compare wallet totals |
| SMS provider down | Switch to the second provider | Tell drivers and customers in the app |
| Data breach suspected | Rotate `OLUB_DATA_KEY` and admin sessions; preserve the audit log | Follow the breach notification procedure (DPDP: Data Protection Board and affected people) |
| Maps provider down | Nothing to do: the app falls back to its own estimate | Fares are slightly less precise until it returns |
