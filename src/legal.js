'use strict';

const C = require('./config');

// Plain-language terms shown in the app. Every acceptance is stored with the
// version, time and IP (table `consents`) and written to the audit log.
// NOTE: drafts — have a lawyer review before launch.
const VERSION = '2026-11-12';

module.exports = {
  VERSION,
  docs: {
    about: {
      title: 'What Olub is',
      body: [
        'Olub only connects a customer with a driver who is already in front of them.',
        'Olub helps both sides track the ride, shows the fare openly to everyone, and charges drivers the smallest possible amount so they can ride with pride.',
        'Olub does not own vehicles, employ drivers, or provide the transport service. The ride is an arrangement directly between the customer and the driver.',
      ],
    },
    rider_terms: {
      title: 'Customer terms',
      body: [
        'Olub is a connecting and tracking service only. The driver alone provides the ride.',
        'The fare shown in the app is paid directly to the driver. Olub keeps a small platform fee per trip, which is shown separately.',
        'In case of an accident, injury, loss or damage during a ride, claims are handled by the driver and the driver\'s vehicle insurance. Olub is not liable and will not pay compensation.',
        'You must add one trusted contact. Your live ride location is shared with that person, and they are alerted if your ride runs late.',
        'Follow the cab rules the driver has chosen (for example no smoking, no alcohol). Tell the driver before booking if you are travelling with a pet.',
        'When you book for someone else (a guest), you are responsible for them and for the payment.',
        'Be honest and respectful when rating. Ratings and comments are shown to the other person without your name.',
      ],
    },
    driver_terms: {
      title: 'Driver terms & liability',
      body: [
        'You are an independent driver. Olub only connects you with customers, helps track the ride, and shows the fare openly. Olub charges a small platform fee per trip; everything else is yours.',
        'You must hold a valid driving licence, registration certificate, permits and motor insurance for your vehicle at all times, and keep them up to date in the app.',
        'If any accident happens, only your vehicle\'s insurance company covers the expenses. Under no condition will Olub be asked for compensation, and Olub is not liable for any loss, injury, death or damage.',
        'If a customer needs medical help because of an incident during your ride, you must make sure they get it — through your insurance company or by other means, including paying yourself or arranging treatment.',
        'You must enter the customer\'s OTP to start a ride, and you must confirm before every ride that you are healthy and fit to drive.',
        'Tolls, pet charges and cab rules you set must be honest. False toll reports or documents lead to removal.',
      ],
    },
    driver_conduct: {
      title: 'Driver safety pledge',
      body: [
        'I will not smoke, drink alcohol, chew tobacco or take drugs while driving or before a ride.',
        'I will not drive when I am unwell, sleepy or unfit.',
        'I will treat every customer with respect, and I will not ask for more than the fare shown in the app.',
      ],
    },
    privacy: {
      title: 'Privacy notice',
      body: [
        'We collect: your name, mobile number, email, date of birth, sex, trusted contact; for drivers also vehicle, licence, RC and KYC documents; trip details, live location during a trip, in-app messages, ratings, and a security log of actions in your account.',
        'We use it only to: verify identity, connect customer and driver, calculate fares, share your live ride with your trusted contact, keep everyone safe, and meet legal duties.',
        'The other person in a ride never sees your mobile number or email. KYC ID documents are seen only by Olub. Documents are stored encrypted.',
        'Ratings and comments are shown to the other person without your name. Olub administrators can see who wrote them, to handle complaints.',
        'Your rights (India DPDP Act 2023 and EU GDPR): get a copy of your data, correct it, delete it, withdraw consent, and complain. Use Profile → Privacy & my data. Requests are accepted only from accounts with a confirmed mobile number and email.',
        `We answer every privacy request within ${C.DSR_PUBLIC_SLA_DAYS - 2}–${C.DSR_PUBLIC_SLA_DAYS} days.`,
        'After deletion we keep only what the law requires (trip and payment records, security logs) with your identity removed.',
        'Grievance officer: privacy@olub.example (replace with the real contact before launch).',
      ],
    },
  },
  // Which documents each role must accept at sign-up.
  required: {
    rider: ['rider_terms', 'privacy'],
    driver: ['driver_terms', 'driver_conduct', 'privacy'],
    admin: ['privacy'],
  },
};
