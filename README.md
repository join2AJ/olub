# Olub

**Book the cab in front of you.** You can see an empty cab or auto waiting right there, but the big apps send it to someone else and add surge pricing. With Olub you scan that cab's QR (or type its number), see a fair fare, and go.

- Olub keeps **₹5 a trip up to 10 km and ₹15 beyond** (half in rain or a natural calamity), plus a monthly charge of ₹937 or 20% of the driver's earnings, whichever is less. The fare is the driver's.
- Olub only **connects** the customer and the driver, tracks the ride and shows the fare openly. It does not provide the ride.
- Calls and chat stay inside the app. Nobody sees anyone's mobile number.

**Where every requested point stands:** [status/STATUS.md](status/STATUS.md)

## Install the Android app

1. Download [`release/Olub-test.apk`](release/Olub-test.apk) on an Android phone (Android 7 or newer) and open it. Allow "install from this source" when asked.
2. On first launch the app asks for your **Olub server address**. The app needs a running server (next section).

This is a test build signed with a test key. It has been compiled and its screens tested in a browser, but **it has not yet been run on a real phone**. A Play Store build needs your own signing key.

To build it yourself: install Android Studio or the Android SDK, then

```bash
cd android
gradle assembleDebug -PolubServer=https://your-server.example.com   # address is optional
```

GitHub also builds the APK on every push (Actions → "Test and build Android app" → Artifacts).

## Run the server

Needs Node.js 22.13 or newer. No database to install.

```bash
npm install
npm start        # http://localhost:3000
npm test         # 18 automated tests
npm run backup   # consistent copy of the database
```

Open `http://localhost:3000` in a browser to use the same app without installing anything.

| Setting | What it does |
|---|---|
| `OLUB_ADMIN_PHONES` | Mobile numbers that are admins (default `9999999999`) |
| `GOOGLE_MAPS_API_KEY` | Live traffic and Google address search. Without it the app uses free OpenStreetMap road routes and search, and estimates traffic by time of day |
| `OLUB_OSRM_URL`, `OLUB_PHOTON_URL` | Your own OpenStreetMap routing / search servers (default: the free public ones, which have no uptime promise). `OLUB_OSM=0` turns them off |
| `OLUB_DATA_KEY` | 64 hex characters; encrypts KYC documents. Required in production |
| `OLUB_PUBLIC_URL` | Public address, used in tracking links sent to trusted contacts |
| `OLUB_DEV_OTP=0` | Stop showing login codes on screen (once SMS is connected) |
| `OLUB_RIDE_GST=0` | Turn off the 5% GST on rides |
| `OLUB_LEGAL_NAME`, `OLUB_GSTIN`, `OLUB_ADDRESS`, `OLUB_GRIEVANCE` | Company details printed on invoices |
| `OLUB_MONTHLY_FEE=0` | Turn off the monthly driver charge |
| `OLUB_MONTHLY_STRICT_CAP=0` | Charge the full ₹937 / 20% even if trip fees + monthly charge would exceed 20% of earnings |
| `OLUB_LEA_AUTO_DAYS`, `OLUB_DSR_AUTO_DAYS` | Days before authority / privacy requests are answered automatically (3 and 5) |

To try it: open two browser windows (or two phones). Sign up as a driver in one, as a customer in the other. Login codes appear on screen in test mode. Log in as `9999999999` for the admin console.

## How a ride works

1. **Customer** opens the app. Pickup is taken from GPS and shown with its **DIGIPIN**. They choose the destination. If booking for someone else, they add that person and where they are.
2. The app shows the fare for each vehicle type.
3. The customer **scans the driver's Olub QR** (or types the number plate, mobile number or Olub ID). The fare updates for that vehicle and driver. They choose to pay at the start or the end.
4. The **driver** sees the request with what they will keep, and accepts.
5. The customer tells the driver the 4-digit code. The driver enters it and ticks **"I am healthy, fit and fine to drive"**. Without the tick the ride cannot start.
6. During the ride the trusted contact can follow it live. The app raises an alarm if the ride is 5–10 minutes late, leaves the route, or someone presses **SOS**.
7. At the end the app works out the bill (waiting time is measured, tolls added). The customer pays the driver directly. **₹5 and the ride GST are deducted from the driver's wallet.**
8. Both rate each other and can get an invoice.

## What's in the app

**Customers**
- QR / number-plate booking, fare before booking, pay at start or end
- GPS and DIGIPIN locations, map pin, address search; the map shows the road path
- Book for a guest; travel with a pet if the driver allows it
- Mandatory trusted contact, live tracking link, SOS, late and off-route alarms
- GST invoice, trip history, spending and GST summary

**Drivers**
- Vehicle, licence, RC, permit, insurance and KYC with photos; printable QR
- Cab rules (no smoking, no alcohol, no tobacco, no food), pets and pet charge
- Wallet: top up, ₹100 minimum to get customers, every deduction listed
- Earnings vs GST, by day, month and hour; safety score per ride
- 12-hour driving limit with 10-hour rest, with warnings
- Crowd-checked tolls: photo and amount, confirmed by 5 more drivers

**Both**
- Unique IDs (`OLB-C-…`, `OLB-D-…`, guests `OLB-G-…`), confirmed mobile and email, age and sex
- Ratings on five points with good / bad / improve notes, shown monthly without names
- In-app chat and voice calls
- Privacy requests: copy, correct, delete, withdraw consent, complain

**Admin**
- Compliance tab, trip register download, driving-hours report
- Driver KYC approval, driver hold
- Police / RTO requests and vehicle flags
- Privacy requests, ratings with names, full audit trail per person, log integrity check
- Rate card, rain / calamity mode, tolls, queued SMS and emails

## Fare

| Part | Rule |
|---|---|
| Ride | Base + per-km rate for the vehicle type (admin sets the rate card), × vehicle condition × driver's Olub experience; minimum fare applies |
| Traffic / waiting | From Google live traffic for the quote; measured for the bill. First 3 minutes free |
| Pet | The driver's own charge, if any |
| Tolls | At cost. Verified amount if 6 drivers agree, otherwise the state default (₹70 unless set) |
| GST | 5% on ride, waiting and pet charge |
| Olub fee | ₹5 up to 10 km, ₹15 beyond, including GST (half in calamity mode) |
| Earlier cancellation fee | Any unpaid cancellation fee from a previous booking |

Default rate card (change it in Admin → Rates):

| Vehicle | Base | Per km | Per waiting min | Minimum |
|---|---|---|---|---|
| Bike | ₹25 | ₹8 | ₹1 | ₹30 |
| Auto | ₹30 | ₹15 | ₹1.5 | ₹40 |
| Hatchback | ₹50 | ₹13 | ₹1.5 | ₹80 |
| Sedan | ₹60 | ₹16 | ₹2 | ₹100 |
| SUV | ₹80 | ₹20 | ₹2.5 | ₹150 |

## Cancellations and the monthly charge

| Situation | Who pays | How much |
|---|---|---|
| Cancelled before the driver accepts | Nobody | — |
| Customer cancels within 2 minutes of booking | Nobody | — |
| Driver cancels after accepting | Driver (from wallet) | ₹5 up to 10 km, ₹15 beyond |
| Customer cancels saying "driver is not coming", and GPS shows the driver made no progress towards the pickup for 2+ minutes | Driver (from wallet) | ₹5 / ₹15 |
| Customer cancels for any other reason, or GPS shows the driver was coming or had arrived | Customer (added to their next ride) | ₹5 / ₹15, never more than 10% of the fare |

Only one side is ever charged, and the app's decision is final.

**Monthly charge.** On the 1st of each month every driver is charged ₹937 or 20% of what they earned the month before, whichever is less, from the wallet. Tolls are not counted as earnings. Trip fees already paid are subtracted first, so Olub's total take never passes 20% of earnings (the legal cap). Example: earned ₹10,000 with ₹300 of trip fees → ₹937. Earned ₹1,000 with ₹50 of trip fees → ₹150, making ₹200 in total.

## Things to know before real customers

These are the open items that matter most. The full list is in [status/STATUS.md](status/STATUS.md) section 12.

- **Licence.** Matching customers to drivers, pricing rides and charging per trip makes Olub an aggregator under Indian transport rules. A state aggregator licence is needed before taking real bookings.
- **Liability.** The terms say accident and medical costs are for the driver and the driver's insurer, as requested. The aggregator guidelines expect the platform to arrange insurance for drivers and passengers. A disclaimer in the app may not protect Olub. Get a lawyer's view.
- **GST.** The app charges 5% on rides and remits it from the driver's wallet. Whether that applies to a flat-fee platform is not settled. Ask a CA; one setting turns it off.
- **Authority requests are answered automatically on day 3** unless an admin refuses. An email code proves control of a mailbox, not legal authority. Have an admin read every letter. See [docs/compliance/regulatory.md](docs/compliance/regulatory.md).
- **Unverified drivers can take rides** once documents are uploaded, because that is how a customer verifies them in person.
- **Not connected yet:** SMS (login codes and safety alerts are queued, not sent), email, payments (wallet top-up is test mode), Google Maps live traffic (needs your key), a call relay server.
- **Maps run on free public OpenStreetMap servers** (routing and search). They are fine for testing but can be slow or refuse heavy use. Before launch, add a Google key or host your own.

## Compliance

[docs/compliance/](docs/compliance/) maps the app to ISO/IEC 27001, ISO 22301, ISO 31000, NIST CSF, the DPDP Act and GDPR, and lists what the company still has to do. Software provides controls and records; certification needs an accredited audit.

## Code layout

```
src/config.js        every business number: fees, rates, GST, limits, deadlines
src/fare.js          fare and GST calculation
src/maps.js          Google live traffic, with a built-in fallback
src/tolls.js         toll detection and driver confirmation
src/app.js           accounts, booking, ride, ratings, privacy requests, admin
src/extras.js        wallet, invoices, insights, SOS, authority requests, compliance report
src/audit.js         tamper-evident audit log
src/privacy.js       data export and erasure
src/legal.js         terms, liability and privacy text shown in the app
public/              the app screens (also bundled into the Android app)
public/js/digipin.js DIGIPIN encode / decode
android/             Android app (WebView shell: camera, mic, GPS, background ride tracking)
docs/compliance/     control map, risk register, continuity plan, transport and tax rules
status/STATUS.md     status of every requested point
test/                automated tests
```
