# Olub — status of every point

Last updated: **12 Nov 2026, 08:33 IST**

This is the single list of everything asked for Olub, and where each point stands. It is updated with every change to the app.

| Mark | Meaning |
|---|---|
| ✅ Complete | Built, covered by automated tests or a browser run |
| 🟡 In progress | Built, but one named part is still open |
| 📅 Planned | Not built yet |
| 🧑‍💼 Needs you | Cannot be done in code: needs a company, licence, provider account or professional |

**Totals:** 68 complete · 10 in progress · 6 planned · 10 need you

---

## 1. The idea

| # | Point | Status | Updated (IST) | Notes |
|---|---|---|---|---|
| 1.1 | Book the cab standing in front of you | ✅ Complete | 12 Nov 2026, 02:20 | Scan the driver's QR, or type the number plate, mobile number or Olub ID |
| 1.2 | No surge pricing; fare shown openly to both sides | ✅ Complete | 12 Nov 2026, 02:20 | Rider and driver see the same line-by-line fare |
| 1.3 | Olub only connects customer and driver, helps track, shows fares | ✅ Complete | 12 Nov 2026, 08:33 | Stated in the app, terms and every invoice |
| 1.4 | Give drivers the power to ride with pride at a minimal charge | ✅ Complete | 12 Nov 2026, 08:33 | ₹5 a trip; the app shows Olub's share of fares (about 1%) |

## 2. Booking flow

| # | Point | Status | Updated (IST) | Notes |
|---|---|---|---|---|
| 2.1 | Customer chooses the destination first | ✅ Complete | 12 Nov 2026, 08:33 | |
| 2.2 | Pickup picked automatically from GPS | ✅ Complete | 12 Nov 2026, 08:33 | Shown with its DIGIPIN; can be changed |
| 2.3 | DIGIPIN for exact location | ✅ Complete | 12 Nov 2026, 08:33 | India Post grid; shown for pickup, drop, live cab position, invoices; can be typed as an address |
| 2.4 | Fare informed before choosing a cab | ✅ Complete | 12 Nov 2026, 08:33 | Estimate for bike, auto, hatchback, sedan, SUV |
| 2.5 | Scan the driver's QR; fare updates for that vehicle and driver | ✅ Complete | 12 Nov 2026, 08:33 | Driver has a printable QR. Camera scan tested in code only — try it on a phone |
| 2.6 | Book by driver mobile number or vehicle number | ✅ Complete | 11 Nov 2026, 21:10 | |
| 2.7 | Driver accepts the request | ✅ Complete | 11 Nov 2026, 21:10 | |
| 2.8 | Customer gets an OTP in the app and tells the driver; driver enters it; trip starts | ✅ Complete | 11 Nov 2026, 21:10 | Five wrong tries locks the trip |
| 2.9 | Booking for someone else (guest) with their pickup point | ✅ Complete | 12 Nov 2026, 08:33 | Guest gets their own ID; saved for next time |
| 2.10 | Pay at the start or at the end | ✅ Complete | 12 Nov 2026, 08:33 | Any difference (waiting, tolls) is settled at the end |
| 2.11 | Search any address | 🟡 In progress | 12 Nov 2026, 08:33 | Works with a Google Maps key. Without one: 9 sample places, map pin, GPS or DIGIPIN |

## 3. Fare

| # | Point | Status | Updated (IST) | Notes |
|---|---|---|---|---|
| 3.1 | Per-km rate set by vehicle type, at market level | ✅ Complete | 12 Nov 2026, 02:20 | Admin can change every rate in the app |
| 3.2 | Vehicle condition changes the fare | ✅ Complete | 11 Nov 2026, 21:10 | |
| 3.3 | Driver's experience with Olub changes the fare | ✅ Complete | 11 Nov 2026, 21:10 | |
| 3.4 | Road condition removed from the fare | ✅ Complete | 12 Nov 2026, 02:20 | |
| 3.5 | Traffic / waiting from Google Maps live traffic | 🟡 In progress | 12 Nov 2026, 02:20 | Code is ready and tested with a simulated Google reply. Needs your Google Maps key to go live; until then it estimates by time of day |
| 3.6 | Waiting time measured, not typed in | ✅ Complete | 12 Nov 2026, 02:20 | Actual ride time minus free-flow time |
| 3.7 | Tolls: ₹70 default, different by state | ✅ Complete | 11 Nov 2026, 21:10 | State values are placeholders to replace |
| 3.8 | Toll first crossing: driver uploads photo and amount | ✅ Complete | 11 Nov 2026, 21:10 | |
| 3.9 | Toll amount verified by 5 more drivers, then used in fares | ✅ Complete | 11 Nov 2026, 21:10 | |
| 3.10 | Olub charges ₹5 a trip | ✅ Complete | 11 Nov 2026, 21:10 | |
| 3.11 | ₹2.5 in rain or natural calamity | ✅ Complete | 11 Nov 2026, 21:10 | Admin switches it on per state |
| 3.12 | ₹100 monthly fee, to be introduced later | ✅ Complete | 11 Nov 2026, 21:10 | Built and switched off |
| 3.13 | Pet charge set by the driver | ✅ Complete | 12 Nov 2026, 02:20 | Goes fully to the driver |

## 4. Money, GST and invoices

| # | Point | Status | Updated (IST) | Notes |
|---|---|---|---|---|
| 4.1 | Driver wallet; ₹5 deducted when the trip ends | ✅ Complete | 12 Nov 2026, 08:33 | |
| 4.2 | Driver must keep ₹100 in the wallet to get customers | ✅ Complete | 12 Nov 2026, 08:33 | Below ₹100 the driver is taken offline |
| 4.3 | Wallet top-up | 🟡 In progress | 12 Nov 2026, 08:33 | Works in test mode. Real money needs a payment provider (see 12.4) |
| 4.4 | GST charged | 🟡 In progress | 12 Nov 2026, 08:33 | 5% on the ride, 18% inside the ₹5 fee. A CA must confirm the treatment before launch |
| 4.5 | Invoices for customer and driver | ✅ Complete | 12 Nov 2026, 08:33 | Numbered by financial year, CGST/SGST split, shareable |
| 4.6 | Drivers analyse trips: money earned vs GST | ✅ Complete | 12 Nov 2026, 08:33 | Weekly, monthly, by hour, per km, wallet history |
| 4.7 | Customers analyse their trips | ✅ Complete | 12 Nov 2026, 08:33 | Spend, GST paid, top destinations |
| 4.8 | ₹10 off for the customer who verifies a new driver | ✅ Complete | 12 Nov 2026, 08:33 | Olub pays it into the driver's wallet |

## 5. Drivers

| # | Point | Status | Updated (IST) | Notes |
|---|---|---|---|---|
| 5.1 | Vehicle details, KYC, RC, driving licence | ✅ Complete | 11 Nov 2026, 21:10 | Documents stored encrypted |
| 5.2 | Permit number and insurance expiry | ✅ Complete | 12 Nov 2026, 08:33 | Expired insurance blocks going online |
| 5.3 | Customer verifies the driver in person | ✅ Complete | 11 Nov 2026, 21:10 | Admin can verify too |
| 5.4 | Driver chooses cab rules: no smoking, no alcohol, etc. | ✅ Complete | 12 Nov 2026, 02:20 | Shown to the customer before booking |
| 5.5 | Driver pledge: no smoking, alcohol or drugs while driving | ✅ Complete | 12 Nov 2026, 02:20 | Accepted at sign-up, recorded |
| 5.6 | Mandatory "I am healthy and fit" tick with the OTP; no tick, no ride | ✅ Complete | 12 Nov 2026, 02:20 | Enforced by the server, logged for every ride |
| 5.7 | Driver says whether pets are OK, and any extra charge | ✅ Complete | 12 Nov 2026, 02:20 | Customer selects "with a pet" when booking |
| 5.8 | Age, sex and licence-based driving experience shown | ✅ Complete | 12 Nov 2026, 02:20 | |
| 5.9 | 12 hours driving a day, then 10 hours rest | ✅ Complete | 12 Nov 2026, 08:33 | Warnings at 2 h, 1 h, 30 min; forced offline; hours on other apps are declared by the driver |
| 5.10 | Accident and medical liability told to the driver | ✅ Complete | 12 Nov 2026, 02:20 | Accepted at sign-up. See 12.2: a lawyer must review this |

## 6. People and identity

| # | Point | Status | Updated (IST) | Notes |
|---|---|---|---|---|
| 6.1 | Unique ID for every driver, customer and guest | ✅ Complete | 12 Nov 2026, 02:20 | OLB-D-…, OLB-C-…, OLB-G-… |
| 6.2 | Phone confirmed | 🟡 In progress | 12 Nov 2026, 02:20 | OTP logic complete. Sending real SMS needs a provider (12.4) |
| 6.3 | Email confirmed | 🟡 In progress | 12 Nov 2026, 02:20 | Code logic complete. Sending real email needs a provider (12.4) |
| 6.4 | Customers and drivers never see each other's numbers | ✅ Complete | 11 Nov 2026, 21:10 | |
| 6.5 | In-app chat | ✅ Complete | 11 Nov 2026, 21:10 | |
| 6.6 | In-app voice call | 🟡 In progress | 11 Nov 2026, 21:10 | Built. Not yet tried on two real phones; needs a relay server for all networks |

## 7. Safety and tracking

| # | Point | Status | Updated (IST) | Notes |
|---|---|---|---|---|
| 7.1 | Mandatory trusted contact | ✅ Complete | 12 Nov 2026, 02:20 | No booking without one |
| 7.2 | Loved ones track the ride live, from–to | ✅ Complete | 12 Nov 2026, 08:33 | Link opens in any browser; shows DIGIPIN |
| 7.3 | Alert if the ride is 5–10 minutes late | ✅ Complete | 12 Nov 2026, 02:20 | +5 min: told; +10 min: asked to check on you. "I'm safe" button |
| 7.4 | SOS button | ✅ Complete | 12 Nov 2026, 08:33 | Alerts the contact with location; one tap to call 112 |
| 7.5 | Off-route alarm | ✅ Complete | 12 Nov 2026, 08:33 | From the Drive app. Uses a straight-line corridor until maps are connected |
| 7.6 | Driving safety score per ride | ✅ Complete | 12 Nov 2026, 08:33 | From the Drive app: overspeed and harsh braking |
| 7.7 | Alerts actually reach the contact's phone | 🟡 In progress | 12 Nov 2026, 08:33 | Messages are written and queued; delivery needs an SMS provider (12.4). The customer can share the link by WhatsApp today |

## 8. Ratings

| # | Point | Status | Updated (IST) | Notes |
|---|---|---|---|---|
| 8.1 | Both sides rate each other on 5 points | ✅ Complete | 12 Nov 2026, 02:20 | |
| 8.2 | Good, bad and improvement comments | ✅ Complete | 12 Nov 2026, 02:20 | |
| 8.3 | Seen monthly, without knowing who wrote them | ✅ Complete | 12 Nov 2026, 02:20 | Shown only in groups of 3 or more, shuffled |
| 8.4 | Admin can see who wrote what | ✅ Complete | 12 Nov 2026, 02:20 | |

## 9. Admin and compliance

| # | Point | Status | Updated (IST) | Notes |
|---|---|---|---|---|
| 9.1 | Complete audit trail of every customer and driver | ✅ Complete | 12 Nov 2026, 02:20 | Tamper-evident: any edit to the log is detected |
| 9.2 | Compliance tab for admin | ✅ Complete | 12 Nov 2026, 08:33 | Duty hours, fee share, GST, insurance expiry, safety events |
| 9.3 | Data ready to share with government | ✅ Complete | 12 Nov 2026, 08:33 | Trip register download (CSV) |
| 9.4 | Police / RTO request form with proof and government email check | ✅ Complete | 12 Nov 2026, 08:33 | Only .gov.in / .nic.in mailboxes |
| 9.5 | Requests auto-answered in 3 days, promised in 10 | ✅ Complete | 12 Nov 2026, 08:33 | Admin can refuse during the 3 days. See the caution in the README |
| 9.6 | Police / RTO can flag a vehicle | ✅ Complete | 12 Nov 2026, 08:33 | Admin is alerted and can put the driver on hold |
| 9.7 | Privacy requests (DPDP, GDPR) from verified IDs | ✅ Complete | 12 Nov 2026, 02:20 | Copy, correct, delete, withdraw consent, complain |
| 9.8 | Privacy requests answered automatically in 5–7 days; website says 10–12 | ✅ Complete | 12 Nov 2026, 02:20 | Corrections and complaints need a person |
| 9.9 | Audit log of privacy and authority requests | ✅ Complete | 12 Nov 2026, 08:33 | |
| 9.10 | Controls for ISO 27001, 22301, 31000, NIST CSF, DPDP, GDPR | 🟡 In progress | 12 Nov 2026, 08:33 | Technical controls and documents are in `docs/compliance/`. Certification itself is 12.5 |
| 9.11 | Rules followed by Ola, Uber, Rapido (aggregator guidelines) | 🟡 In progress | 12 Nov 2026, 08:33 | Built: duty hours, fee cap, fit check, grievance contact, trip records. Open items are in section 12 |

## 10. App and design

| # | Point | Status | Updated (IST) | Notes |
|---|---|---|---|---|
| 10.1 | Android app | ✅ Complete | 12 Nov 2026, 08:33 | APK builds (`release/`). Not yet run on a real phone |
| 10.2 | Keep the logo | ✅ Complete | 12 Nov 2026, 02:20 | Also the app icon and splash |
| 10.3 | New UI: theme, animation, icons | ✅ Complete | 12 Nov 2026, 08:33 | Map-first, number-plate input, dark mode |
| 10.4 | This status table in the repo | ✅ Complete | 12 Nov 2026, 08:33 | |

## 11. Planned next

| # | Point | Status | Updated (IST) | Notes |
|---|---|---|---|---|
| 11.1 | Road-following routes and off-route check on real roads | 📅 Planned | 12 Nov 2026, 08:33 | Needs the maps key |
| 11.2 | Hindi and regional languages | 📅 Planned | 12 Nov 2026, 08:33 | |
| 11.3 | UPI payment straight to the driver from the app | 📅 Planned | 12 Nov 2026, 08:33 | |
| 11.4 | More from the Drive app: weekly report card, hotspots, incident case file | 📅 Planned | 12 Nov 2026, 08:33 | |
| 11.5 | iPhone app | 📅 Planned | 12 Nov 2026, 08:33 | |
| 11.6 | Play Store release build | 📅 Planned | 12 Nov 2026, 08:33 | Needs a signing key and a Play account |

## 12. Needs you (not code)

| # | Point | Status | Updated (IST) | Notes |
|---|---|---|---|---|
| 12.1 | Register a company and get GSTIN | 🧑‍💼 Needs you | 12 Nov 2026, 08:33 | Invoices show "pending" until then |
| 12.2 | Lawyer review of terms and the liability clause | 🧑‍💼 Needs you | 12 Nov 2026, 08:33 | Aggregator rules require the platform to insure drivers and passengers; a disclaimer may not hold |
| 12.3 | State aggregator licence | 🧑‍💼 Needs you | 12 Nov 2026, 08:33 | Needed before taking real bookings |
| 12.4 | Provider accounts: SMS, email, payments, Google Maps | 🧑‍💼 Needs you | 12 Nov 2026, 08:33 | The app has a slot for each |
| 12.5 | ISO 27001 / 22301 certification audits | 🧑‍💼 Needs you | 12 Nov 2026, 08:33 | Only an accredited auditor can certify |
| 12.6 | CA confirmation of GST on rides | 🧑‍💼 Needs you | 12 Nov 2026, 08:33 | One setting turns ride GST off if not applicable |
| 12.7 | Host the server in India | 🧑‍💼 Needs you | 12 Nov 2026, 08:33 | The app needs a server address to work |
| 12.8 | Driver and passenger insurance tie-up | 🧑‍💼 Needs you | 12 Nov 2026, 08:33 | |
| 12.9 | 24×7 control room and grievance officer | 🧑‍💼 Needs you | 12 Nov 2026, 08:33 | Contact shown in the app is a placeholder |
| 12.10 | Commercial vehicle checks: yellow plate, panic button, AIS-140 tracker | 🧑‍💼 Needs you | 12 Nov 2026, 08:33 | Policy decision for which vehicles may join |
