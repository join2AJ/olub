# Indian transport and tax rules

Last updated: 12 Nov 2026

This is a working checklist, not legal advice. The main rule set is the **Motor Vehicle Aggregator Guidelines** issued by the Ministry of Road Transport and Highways under section 93 of the Motor Vehicles Act, 1988, as adopted by each state's transport department. Have a transport lawyer confirm each line for your launch state.

## What the app already does

| Rule | How Olub handles it | Where to see it |
|---|---|---|
| Driver works at most 12 hours a day, then 10 hours rest | Online and on-trip time is counted. Warnings at 2 h, 1 h and 30 min. At 12 hours the driver is taken offline (after finishing the current ride) and cannot go online for 10 hours | Driver home → Driving hours; Admin → Compliance |
| Hours on all apps count together | Driver declares hours driven on other apps when going online. Olub cannot check this | "Before you go online" sheet |
| Driver keeps at least 80% of the fare | Olub takes ₹5 per trip up to 10 km and ₹15 beyond, plus a monthly charge (₹937 or 20% of earnings, lower). The monthly charge is reduced by trip fees already paid, so the total never passes 20%. The exact share is shown live | Admin → Compliance; Driver → Earnings |
| Cancellation fee at most 10% of fare or ₹100 | ₹5 / ₹15 to the side at fault; a customer never pays more than 10% of the fare; free for 2 minutes after booking | Cancel sheet; terms |
| Fares are transparent | Line-by-line fare shown to both sides before the ride; rate card set by admin | Fare screens; Admin → Rates |
| Driver identity and documents | Licence, RC, permit, insurance, KYC ID, photo; verified by a customer in person or an admin | Driver → Vehicle & documents; Admin → Driver KYC |
| Valid insurance | Expiry date stored; an expired policy blocks going online; list of policies expiring in 30 days | Admin → Compliance |
| Driver fit to drive | Mandatory declaration before every ride, logged | Trip audit trail |
| Live location and trip sharing | Live GPS, shareable tracking link, trusted contact | Trip screen |
| Emergency button | SOS alerts the trusted contact and offers a call to 112 | Trip screen |
| Grievance officer shown | Contact shown in Profile and at `/legal` (placeholder until appointed) | Profile |
| Records kept and shareable with the authority | Trip register with driver, vehicle, DIGIPINs, fare, GST, fit declaration; download as CSV | Admin → Compliance |
| Data requests from police / RTO / courts | Form at `/authority`: government email, emailed code, signed letter; officer declares the request is genuine; closed automatically after 48 hours (officers are told 3–5 days); full log | Admin → Police / RTO |
| Authority can flag a vehicle | Verified officer flags a vehicle; admin is alerted and can put the driver on hold | Admin → Police / RTO |

## What is still open

| Rule | What is needed | Type |
|---|---|---|
| Aggregator licence in each state | Apply with the state transport department; fee and security deposit apply | Company |
| Registered company, GSTIN | Incorporate; register for GST | Company |
| Insurance for drivers and passengers | The guidelines expect the platform to arrange health and term cover for drivers and cover for passengers. Olub's terms currently place accident costs on the driver's insurer. **These two positions conflict — get legal advice before launch** | Company + lawyer |
| Commercial vehicles only | Decide and enforce: yellow-plate registration, contract-carriage permit, fitness certificate, PUC. The app stores a permit number but does not check it with Vahan / Sarathi | Company + app (planned) |
| Vehicle tracking device and panic button (AIS-140) | Required in commercial passenger vehicles in most states. Olub uses the phone's GPS and an in-app SOS | Company decision |
| 24×7 control room | Staffed helpline that can see live rides | Company |
| Driver training | Induction and yearly refresher | Company |
| State-notified fares | Where a state fixes minimum and maximum per-km fares, set the rate card inside that band | Admin setting |
| Data stored in India | Host the server and backups in India | Company |
| Police verification of drivers | Background check before approval | Company process |

## GST

| Item | Treatment in the app | To confirm with a CA |
|---|---|---|
| Olub's ₹5 platform fee | Includes 18% GST (₹4.24 + ₹0.76), SAC 998599 | Rate and SAC |
| The ride | 5% GST on ride, waiting and pet charge, collected from the customer and remitted by Olub (section 9(5), CGST Act), SAC 996412. Tolls are passed on at cost | Whether section 9(5) applies to Olub's flat-fee model. Rulings differ between platforms. `OLUB_RIDE_GST=0` switches it off |
| How it is collected | The customer pays the driver. Olub deducts the fee and the ride GST from the driver's wallet when the trip ends | Whether this collection route is acceptable |
| Invoices | Numbered `OLB/<financial year>/<trip>`; ride invoice to the customer, platform-fee invoice to the driver; CGST/SGST shown as halves | Inter-state rides (IGST) are not split yet |

## Requests from police, RTO and courts

1. The officer fills the form at `/authority` and attaches a signed letter.
2. Only email addresses ending in `.gov.in` or `.nic.in` are accepted. A code sent to that address must be entered.
3. A **vehicle flag** takes effect at once: admins see it and can put the driver on hold.
4. A **data request** waits 48 hours for review. An admin can open the letter, release early, or refuse with a reason.
5. If nobody refuses it, the system releases the matching records after 48 hours. The public promise is 3–5 days.
6. The officer opens the records with the reference and a one-time access key.
7. Every step — submitted, wrong code, verified, released, viewed, refused — is in the audit log.

**Caution:** automatic release means a request is answered even if no person at Olub has read the letter. An email code proves control of a mailbox, not legal authority. Make it a daily task for an admin to open every letter during the 3-day window. To stop automatic release altogether, set `OLUB_LEA_AUTO_DAYS` to a very large number.
