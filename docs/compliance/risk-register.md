# Risk register (ISO 31000)

Last updated: 12 Nov 2026 · Review: every quarter, and after any incident · Owner: to be named

Scale: likelihood and impact are each Low / Medium / High. "After" is the level once the treatment is in place.

| # | Risk | Likelihood | Impact | Treatment | Status of treatment | After |
|---|---|---|---|---|---|---|
| R1 | Operating without an aggregator licence leads to fines or a shutdown | High | High | Get the state licence before taking real bookings; or start as software for a licensed union | Company action | Low |
| R2 | An accident happens and the liability disclaimer does not hold in court | Medium | High | Lawyer review; passenger and driver insurance tie-up; insurance expiry check in the app | App check built; insurance is a company action | Medium |
| R3 | A tired, unwell or intoxicated driver takes a ride | Medium | High | Fit-to-drive tick before every ride; 12-hour limit with 10-hour rest; safety pledge; ratings | Built | Low |
| R4 | A fake or unverified driver takes customers | Medium | High | KYC documents, in-person customer check or admin approval; police / RTO flags; admin hold | Built. Gap: automatic licence and RC lookup | Medium |
| R5 | A customer is in danger during a ride | Low | High | Trusted contact, live tracking, late-ride alert, off-route alarm, SOS, call 112 | Built. Gap: SMS delivery needs a provider | Low |
| R6 | Personal data or KYC documents leak | Medium | High | Encryption, masking, role checks, audit log, minimal data shown | Built. Gap: production key and host hardening | Low |
| R7 | Someone poses as police to get personal data | Medium | High | Government email only, emailed code, signed letter, 3-day review window, admin can refuse, everything logged | Built. Recommended: an admin opens the letter for every request | Medium |
| R8 | Drivers report false tolls | Medium | Low | Photo required; amount accepted only when 6 drivers agree; state default until then | Built | Low |
| R9 | Fake ratings or revenge ratings | Medium | Medium | Only after a completed trip; one per side per trip; admin sees the author | Built | Low |
| R10 | Wrong GST treatment | Medium | Medium | CA confirmation; one setting changes the ride GST | Company action | Low |
| R11 | Server outage stops bookings and tracking | Medium | High | See business-continuity.md | Partly | Medium |
| R12 | SMS or maps provider fails | Medium | Medium | App works without maps (estimate); OTP codes need a second SMS provider | Partly | Medium |
| R13 | Audit log is altered to hide something | Low | High | Hash-chained log; integrity check in the admin console | Built | Low |
| R14 | Driver wallet abuse or disputes | Low | Medium | Every wallet movement is recorded with its trip; invoices for both sides | Built | Low |
| R15 | Driver exceeds hours by using other apps | High | Medium | Driver declares other-app hours when going online | Built. Cannot be verified without industry data sharing | Medium |
