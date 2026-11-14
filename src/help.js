'use strict';
// Olub Cha — the in-app help assistant.
// It answers from Olub's published policies and from the signed-in person's OWN records only.
// It never looks up or reveals anything about another person. It is a rule-based helper, not a human.

const rs = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/** Every topic: who it is for, the words that point to it, and the answer. `me` holds only the asker's own data. */
function topics(C) {
  const cap = C.CANCEL_CUSTOMER_CAP;
  return [
    { id: 'fare', title: 'The fare was higher than I expected', roles: ['rider'], keys: ['fare', 'overcharg', 'charged more', 'extra money', 'expensive', 'price', 'bill', 'kiraya', 'zyada'],
      answer: (me) => `The fare is fixed by the app, not the driver. It is: base fare + per-km rate for the trip and for the cab coming to you, plus traffic/waiting time, tolls and any pet charge, then 5% GST and the Olub fee (${rs(C.PLATFORM_FEE)} up to ${C.PLATFORM_FEE_LONG_KM} km, ${rs(C.PLATFORM_FEE_LONG)} beyond).\n\nThe driver must not ask for more than the app shows. If they did, raise an issue below and we will check the trip record.${me.lastTrip ? `\n\nYour last ride: ${me.lastTrip.line}. Open it in Activity to see every line of the bill.` : ''}` },
    { id: 'extra_cash', title: 'The driver asked for extra cash', roles: ['rider'], keys: ['extra cash', 'asked for more', 'demand', 'tip', 'bakshish', 'refused meter'],
      answer: () => 'Pay only the amount shown under "You pay". Tolls and waiting are already in the bill. If a driver asks for more or refuses the ride unless you pay extra, raise an issue below — it goes on the driver\'s record and an Olub officer reviews it.' },
    { id: 'cancel', title: 'Cancellation fee', roles: ['rider', 'driver'], keys: ['cancel', 'cancellation', 'cancelled'],
      answer: (me) => `Cancelling is free for the first ${C.CANCEL_FREE_WINDOW_MIN} minutes. After that the app decides from GPS who caused it, and only one side pays:\n• If the cab was not moving towards the pickup, the driver pays.\n• Otherwise the customer pays.\nThe fee is ${rs(C.PLATFORM_FEE)} for trips up to ${C.PLATFORM_FEE_LONG_KM} km and ${rs(C.PLATFORM_FEE_LONG)} beyond; a customer never pays more than ${cap.percent * 100}% of the fare (at most ${rs(cap.max)}).${me.role === 'rider' ? `\n\nYou currently owe ${rs(me.cancelDues)} in cancellation fees${me.cancelDues ? '; it is added to your next ride' : ''}.` : ''}` },
    { id: 'behaviour', title: 'The driver was rude or drove unsafely', roles: ['rider'], keys: ['rude', 'misbehav', 'abus', 'rash', 'unsafe', 'speeding', 'drunk', 'harass', 'badtameez', 'fight'],
      answer: () => 'We are sorry. If you are in danger right now, press SOS on the ride screen — it alerts your trusted contact and Olub, and shows the emergency number 112.\n\nAfter the ride: rate the driver (your name is not shown to them) and raise an issue below. Drivers pledge not to smoke, drink or misbehave; repeated complaints put the account on hold.' },
    { id: 'customer', title: 'The customer was rude, late or did not show up', roles: ['driver'], keys: ['customer rude', 'no show', 'not come', 'late customer', 'damage', 'vomit', 'dirty', 'misbehav', 'abus', 'refus'],
      answer: () => 'You are paid for waiting time inside a ride. If the customer does not turn up, cancel from the ride screen — when your GPS shows you reached the pickup, the fee goes to the customer, not you.\n\nFor rude behaviour or damage to the cab, rate the customer and raise an issue below with what happened. Olub can warn or block the customer; damage itself is settled between you, the customer and your insurer.' },
    { id: 'lost', title: 'I left something in the cab', roles: ['rider'], keys: ['lost', 'left my', 'forgot', 'bag', 'phone in cab', 'wallet in', 'item', 'saman'],
      answer: (me) => `Open the ride in Activity and use the in-app call or chat — it stays open for a short while after the ride and never shows your number.${me.lastTrip ? ` Your last ride: ${me.lastTrip.line}.` : ''}\n\nIf you cannot reach the driver, raise an issue below and we will pass your message on. Olub connects you with the driver but cannot guarantee the item is found.` },
    { id: 'route', title: 'The driver took a wrong or longer route', roles: ['rider'], keys: ['route', 'wrong way', 'longer', 'detour', 'different road', 'off route'],
      answer: () => 'The fare is fixed for the planned route when you book, so a longer road does not raise the distance charge. The app watches the route: if the cab goes well off it you get an alarm and it is recorded in the ride\'s safety score. If you felt unsafe, press SOS during the ride or raise an issue afterwards.' },
    { id: 'otp', title: 'Problem with the ride code (OTP)', roles: ['rider', 'driver'], keys: ['otp', 'code', 'pin not', 'wrong code'],
      answer: (me) => (me.role === 'driver' ? 'Ask the customer for the 4-digit code on their ride screen and tick "I am healthy and fit to drive". The ride cannot start without both. If the code is refused, check you are on the right request.' : 'Your 4-digit ride code appears once a driver accepts. Share it only after you are inside the cab — it is what starts the ride. Never share it on a call before you see the cab and its number plate.') },
    { id: 'payment', title: 'Payment problem', roles: ['rider', 'driver'], keys: ['payment', 'paid', 'upi', 'cash', 'not received', 'unpaid', 'double'],
      answer: () => 'You pay the driver directly — cash or UPI — at the start or the end, as chosen when booking. The customer taps "Paid" on the ride screen. Olub does not hold ride money, so it cannot move or refund it; if the two sides disagree, raise an issue and we will share the trip record with both.' },
    { id: 'refund', title: 'I want a refund', roles: ['rider'], keys: ['refund', 'money back', 'return my money', 'wapas'],
      answer: () => 'Ride money goes straight to the driver, so a refund of the fare has to come from the driver. What Olub can do: remove a wrongly applied cancellation fee, and review the trip if the bill does not match the booking. Raise an issue below and say which ride.' },
    { id: 'safety', title: 'I do not feel safe', roles: ['rider', 'driver'], keys: ['safe', 'danger', 'sos', 'emergency', 'help me', 'accident now', 'police', 'follow'],
      answer: () => 'If this is an emergency, call 112 now.\n\nOn a live ride, press the red SOS button: it tells your trusted contact and Olub where the cab is. Your trusted contact can also follow the ride on a live map, and gets an alert if the ride runs 5–10 minutes late.' },
    { id: 'mismatch', title: 'Different car or driver than the app shows', roles: ['rider'], keys: ['different car', 'different driver', 'not the same', 'number plate', 'wrong car', 'someone else driving'],
      answer: () => 'Do not get in. The number plate, vehicle and driver photo must match the app. Cancel the ride — say why — and raise an issue below. This is treated as a serious safety matter.' },
    { id: 'pets', title: 'Travelling with a pet', roles: ['rider', 'driver'], keys: ['pet', 'dog', 'cat', 'bird', 'animal'],
      answer: (me) => (me.role === 'driver' ? `You choose whether to take pets and set a charge for each kind (up to ${rs(C.MAX_PET_CHARGE)}). The charge is locked for a ride once you accept it; changes apply from your next ride.` : `Turn on "Travelling with a pet" under Preferences and choose the kind of pet. Only cabs whose driver takes pets are shown, and that driver's charge for your kind of pet is added to the fare before you book. Please carry a sheet or carrier.`) },
    { id: 'rules', title: 'Smoking, alcohol and cab rules', roles: ['rider', 'driver'], keys: ['smok', 'alcohol', 'drink', 'tobacco', 'gutka', 'food', 'rule'],
      answer: () => 'Each driver sets cab rules (no smoking, no alcohol, no tobacco, no food) and you see them before booking. Drivers themselves pledge never to drive after drinking and tick "healthy and fit to drive" before every ride. Breaking a cab rule can be reported from the rating screen.' },
    { id: 'toll', title: 'Toll charges', roles: ['rider', 'driver'], keys: ['toll', 'plaza', 'fastag'],
      answer: () => 'Tolls on the route are added to the bill. A toll amount is trusted once the driver who reported it and five other drivers confirm it; until then the state default is used. Drivers can report a new toll with a photo from the ride screen.' },
    { id: 'wait', title: 'Waiting and traffic charges', roles: ['rider', 'driver'], keys: ['wait', 'traffic', 'jam', 'delay'],
      answer: () => 'Time lost to traffic or waiting during the ride is paid per minute at the rate for that vehicle type. The estimate is shown before booking and the final figure on the bill.' },
    { id: 'nocab', title: 'I cannot find a cab', roles: ['rider'], keys: ['no cab', 'not finding', 'no driver', 'unavailable', 'nobody accept'],
      answer: () => 'Olub asks the nearest free cab first and moves to the next one every 45 seconds. If none is near, you can still book any Olub cab standing in front of you: scan the driver\'s QR or type the number plate under "Cab right in front of you?".' },
    { id: 'wallet', title: 'My wallet and deductions', roles: ['driver'], keys: ['wallet', 'balance', 'deduct', 'top up', 'topup', 'recharge'],
      answer: (me) => `Keep at least ${rs(C.WALLET_MIN_BALANCE)} in the wallet to receive customers. After each ride the Olub fee (${rs(C.PLATFORM_FEE)} up to ${C.PLATFORM_FEE_LONG_KM} km, ${rs(C.PLATFORM_FEE_LONG)} beyond; half in declared rain or calamity) plus GST is taken from it.${me.wallet ? `\n\nYour balance now: ${rs(me.wallet.balance)}${me.wallet.ok ? '' : ' — below the minimum, please top up'}.` : ''} Every entry is under Earnings → Wallet activity.` },
    { id: 'monthly', title: 'Monthly charge', roles: ['driver'], keys: ['monthly', '937', 'subscription', '20%', 'commission'],
      answer: () => `On the 1st, Olub takes ${rs(C.MONTHLY_FEE_MAX)} or ${C.MONTHLY_FEE_SHARE * 100}% of what you earned last month, whichever is less. Olub's total (trip fees + this) never goes above 20% of your earnings. See Earnings → Monthly charge for this month so far.` },
    { id: 'hours', title: 'Driving hours and forced rest', roles: ['driver'], keys: ['hours', 'duty', 'rest', 'offline', 'locked', '12'],
      answer: (me) => `By law you may be on duty ${C.DUTY_MAX_HOURS} hours a day across all apps, then must rest ${C.DUTY_REST_HOURS} hours. The app counts all time you are online and takes you offline at the limit.${me.duty ? `\n\nToday you have used ${Math.floor(me.duty.workedMin / 60)}h ${me.duty.workedMin % 60}m${me.duty.locked ? ' and are resting now' : `, with ${Math.floor(me.duty.remainingMin / 60)}h ${me.duty.remainingMin % 60}m left`}.` : ''}` },
    { id: 'kyc', title: 'Documents and verification', roles: ['driver'], keys: ['kyc', 'document', 'verif', 'licence', 'license', 'rc', 'insurance', 'permit', 'reject'],
      answer: (me) => `You need a driving licence, RC, permit, insurance, an ID and photos. An Olub admin checks them; until then your first customer can verify you in person.${me.driverStatus ? `\n\nYour status now: ${me.driverStatus}.` : ''} Upload or replace documents under Profile → Vehicle, documents & cab rules.` },
    { id: 'accident', title: 'Accident, damage and insurance', roles: ['rider', 'driver'], keys: ['accident', 'insurance', 'injur', 'crash', 'liab', 'claim', 'hit'],
      answer: () => 'If anyone is hurt, call 112 first.\n\nOlub connects customers and drivers; it does not provide the ride. The vehicle\'s insurance, held by the driver, covers accidents and third-party claims. Olub will give the trip record to both sides and, on a proper request, to the police or insurer. Raise an issue below so it is on record.' },
    { id: 'privacy', title: 'My data and privacy', roles: ['rider', 'driver'], keys: ['privacy', 'my data', 'delete', 'erase', 'download my', 'correct my', 'dpdp', 'gdpr', 'consent'],
      answer: () => 'Under Profile → Privacy & my data you can download your data, correct it, withdraw consent or ask for deletion. Requests are answered in 10–12 days. Your phone number is never shown to the other side — calls and chat go through the app.' },
    { id: 'account', title: 'Change my name, email or photo', roles: ['rider', 'driver'], keys: ['change name', 'email', 'photo', 'update profile', 'phone number', 'account'],
      answer: () => 'Go to Profile → Personal details for name, photo, date of birth and sex, and Profile → Email for your email. To change the mobile number you sign in with, raise an issue below — we confirm it is you first.' },
    { id: 'invoice', title: 'Invoice and GST', roles: ['rider', 'driver'], keys: ['invoice', 'gst', 'receipt', 'tax'],
      answer: () => 'Every completed ride has a GST invoice. Open the ride in Activity (or Trips) and tap Invoice — you can save it as JPG or Excel. GST is 5% on the ride and 18% on the Olub fee.' },
    { id: 'rating', title: 'Ratings', roles: ['rider', 'driver'], keys: ['rating', 'stars', 'review', 'feedback'],
      answer: (me) => `After each ride both sides rate each other on five points and can say what was good, bad or could improve. Comments are shown monthly without names.${me.rating && me.rating.count ? `\n\nYour rating: ${me.rating.average.toFixed(1)} from ${me.rating.count} rating${me.rating.count === 1 ? '' : 's'}.` : ''} See them under Profile → My ratings.` },
    { id: 'official', title: 'Police or government request', roles: ['rider', 'driver'], keys: ['official', 'government', 'rto', 'court', 'summon', 'fir'],
      answer: () => 'Government officers apply on the "Government officials" page (Profile, or the sign-in screen). They must confirm an official government email, attach a signed letter and declare the request is genuine. Every request is recorded. Olub shares only what the request covers.' },
    { id: 'human', title: 'I want to talk to a person', roles: ['rider', 'driver'], keys: ['human', 'person', 'agent', 'officer', 'call me', 'complain', 'grievance', 'escalate'],
      answer: () => `Tap "Raise an issue" below and write what happened. An Olub officer replies in the app. You can also write to the ${C.COMPANY.grievanceOfficer}.` },
  ];
}

const ASKS_ABOUT_OTHERS = /(driver'?s?|customer'?s?|passenger'?s?|his|her|their|someone'?s?|other)\s+(mobile|phone|number|address|home|aadhaar|licen[cs]e number|email|data|details|location)|\b[6-9]\d{9}\b/i;

function answer(C, text, me) {
  const q = String(text || '').toLowerCase().slice(0, 500);
  if (ASKS_ABOUT_OTHERS.test(q)) {
    return { topic: 'others', title: 'Other people\'s details', text: 'I can only share your own records and Olub\'s public policies. I cannot give out another person\'s phone number, address, documents or location. To reach your driver or customer, use the in-app call or chat on the ride. Police and government officers can apply through the Government officials page.' };
  }
  let best = null; let score = 0;
  for (const t of topics(C)) {
    if (!t.roles.includes(me.role)) continue;
    const s = t.keys.reduce((n, k) => n + (q.includes(k) ? k.length : 0), 0);
    if (s > score) { best = t; score = s; }
  }
  if (!best) return { topic: null, title: 'I did not catch that', text: 'I could not match that to a topic I know. Pick one of the topics below, or tap "Raise an issue" and an Olub officer will reply.' };
  return { topic: best.id, title: best.title, text: best.answer(me) };
}

const list = (C, role) => topics(C).filter((t) => t.roles.includes(role)).map((t) => ({ id: t.id, title: t.title }));
const byId = (C, id, me) => { const t = topics(C).find((x) => x.id === id && x.roles.includes(me.role)); return t ? { topic: t.id, title: t.title, text: t.answer(me) } : null; };

module.exports = { answer, list, byId };
