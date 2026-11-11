# Olub

**Book the cab in front of you.** You can see an empty cab or auto waiting right there, but the big apps send it to someone else and add surge pricing. With Olub you type that vehicle's number (or the driver's mobile number), see a fair fare up front, and go.

- Olub keeps **₹5 per trip** (₹2.5 during rain or a natural calamity). **Everything else goes to the driver**, tolls included.
- An optional **₹100/month** driver subscription is built in but **off** for launch.
- Calls and chat happen **inside the app**. The rider and the driver never see each other's mobile numbers.

## How a trip works

1. **Rider** enters pickup, drop, and the cab's **vehicle number or driver's mobile number**.
2. Olub shows the **fare breakdown** and the driver's verification status.
3. **Driver** gets the request with the fare and accepts it.
4. The rider gets in and tells the driver the **4-digit trip OTP**. The driver enters it and the trip starts.
5. During the trip the driver adds any **tolls** crossed. At the end the driver enters the waiting time.
6. The rider pays the driver directly (cash or UPI) and confirms in the app.

## Fare engine (`src/fare.js`, numbers in `src/config.js`)

| Factor | How it is used |
|---|---|
| Vehicle type | Base fare, per-km rate, wait rate and minimum fare for bike, auto, hatchback, sedan and SUV |
| Vehicle condition | excellent ×1.10 · good ×1.00 · average ×0.92 · poor ×0.85 |
| Driver experience on Olub | New (<10 trips) ×0.95 · Regular ×1.00 · Experienced (50+) ×1.03 · Veteran (200+) ×1.05 |
| Road condition | good ×1.00 · average ×1.05 · poor ×1.12 |
| Traffic / waiting | The quote estimates wait time from traffic. The final bill uses the actual wait. The first 3 minutes are free. |
| Tolls | Added at cost and passed 100% to the driver. Bikes and autos are exempt. |
| Olub fee | ₹5, or ₹2.5 while calamity mode is on for that state |

Distance is the straight-line distance × 1.3. A maps API is not wired in yet.

## Crowd-sourced tolls

- Any toll within about 1.5 km of the route is added to the quote automatically.
- A driver who crosses a toll **for the first time** gets asked to upload a **photo of the receipt or FASTag SMS** and the amount paid.
- A toll amount becomes **verified** once the first reporter **plus 5 more drivers** report the same amount.
- Until then, the toll is charged at the **state default**: **₹70** by default, with different values per state in `STATE_DEFAULT_TOLL`, e.g. MH ₹80, KA ₹75. These values are placeholders.

## Driver onboarding and the ₹10 verification reward

- Drivers submit their vehicle number, type, model and condition, driving licence, RC, KYC ID, a selfie and a photo of the vehicle with its number plate.
- Their status then becomes **submitted**, and they can go online.
- The **first rider** checks in person that the face, number plate and vehicle match. That rider gets **₹10 off**, so they pay fare + ₹5 − ₹10. Olub pays for this reward, so the driver's earnings stay the same.
- An admin can also approve or reject drivers.
- Riders only see the selfie, the vehicle photo, the RC number and a masked licence number. The KYC ID stays with Olub.

## Run it

Requires Node.js 22.13 or later. It uses the built-in `node:sqlite`, so there is no database to install.

```bash
npm install
npm start            # http://localhost:3000
npm test             # fare engine + full booking-flow API tests
```

- **Dev login:** enter any 10-digit mobile number. The OTP appears on screen in dev mode. Set `OLUB_DEV_OTP=0` to turn that off.
- **Admin:** log in as `9999999999`, or set `OLUB_ADMIN_PHONES`. The admin can review drivers, turn calamity mode on or off per state, and see the list of tolls.
- **Subscription:** `OLUB_SUBSCRIPTION=1` turns on the ₹100/month driver subscription.
- Data is stored in `data/olub.db`. Set `OLUB_DB` to use a different path.

To try it yourself, open two browser windows. Sign up as a driver in one, then upload documents and go online. Sign up as a rider in the other and book the driver by their vehicle number.

## Code layout

```
src/config.js   all business numbers (fees, rates, toll defaults)
src/fare.js     pure fare calculation
src/tolls.js    route toll detection + 1+5 crowd verification
src/app.js      REST API, SSE live updates, chat, WebRTC call signalling
public/         mobile-first web app (rider / driver / admin)
test/           node:test unit + integration tests
```

## Before a real launch

- **SMS OTP:** replace the dev OTP with a real SMS gateway (MSG91, Twilio, etc.).
- **Calls:** add a **TURN server**, because peer-to-peer calls fail on some mobile networks. Alternatively, use a number-masking provider (Exotel, Knowlarity) for calls over the regular phone network.
- **Maps:** use a maps/routing API for road distance, live ETAs, and checking which tolls are on the route.
- **Payments:** pay the driver by UPI intent, and settle the ₹5 fees from a driver wallet.
- **Documents:** check DigiLocker or Vahan/Sarathi for DL and RC. Store documents encrypted in object storage, not in the database.
- **Native apps:** build Android and iOS apps (React Native or Flutter) using this API.
- **Legal:** check state aggregator rules and get passenger insurance.
