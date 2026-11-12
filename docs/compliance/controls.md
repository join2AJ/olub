# Control map

Last updated: 12 Nov 2026

Status: **Built** = in the app and tested · **Partly** = built, with a named gap · **Company** = needs an organisational action, not code.

## Security controls (ISO/IEC 27001:2022 Annex A · NIST CSF 2.0)

| Control | ISO 27001 | NIST CSF | Status | How Olub does it |
|---|---|---|---|---|
| Information security policy | A.5.1 | GV.PO | Company | Draft policies to be approved by management |
| Roles and responsibilities | A.5.2 | GV.RR | Company | Name a security owner, privacy (grievance) officer, admin approvers |
| Asset inventory | A.5.9 | ID.AM | Partly | Data inventory is in the privacy notice and `src/db.js`; hosting inventory comes with hosting |
| Acceptable use / admin access | A.5.15, A.8.2 | PR.AA | Partly | Three roles (customer, driver, admin). Admin is set by phone number in server settings. Gap: no two-step login for admins yet |
| Identity verification | A.5.16 | PR.AA | Built | Mobile OTP, email code, driver KYC with in-person or admin verification |
| Authentication secrets | A.5.17 | PR.AA | Built | No passwords. Session tokens are random, stored only as a hash, expire in 30 days |
| Access rights | A.5.18, A.8.3 | PR.AA | Built | Each API checks role and that the trip belongs to the caller |
| Supplier security | A.5.19–A.5.22 | GV.SC | Company | Contracts with SMS, email, payment, maps and hosting providers |
| Incident management | A.5.24–A.5.28 | RS.MA, RS.AN | Partly | Audit log and safety events give the evidence. Gap: written incident procedure and on-call contact |
| Business continuity | A.5.29, A.5.30 | RC.RP | Partly | See business-continuity.md |
| Legal and regulatory requirements | A.5.31 | GV.OC | Partly | See regulatory.md |
| Privacy and personal data | A.5.34 | GV.OC | Built | See the privacy table below |
| Compliance reporting | A.5.35, A.5.36 | GV.OV | Built | Admin → Compliance tab; trip register export |
| Screening and training | A.6.1–A.6.3 | PR.AT | Company | Staff background checks and security training |
| Secure coding | A.8.25–A.8.28 | PR.PS | Built | Input checks on every API, parameterised database queries, HTML escaping in screens, automated tests |
| Encryption | A.8.24 | PR.DS | Partly | KYC documents, data exports and authority letters use AES-256-GCM. Gap: set `OLUB_DATA_KEY` and turn on disk encryption at the host |
| Data in transit | A.8.20, A.8.21 | PR.DS | Partly | HSTS header; the release Android build refuses non-HTTPS. Gap: the host must provide the TLS certificate |
| Data masking | A.8.11 | PR.DS | Built | Phone numbers never shown to the other party; licence number masked; KYC ID never shown to customers |
| Data deletion | A.8.10 | PR.DS | Built | Erasure on request; sessions expire; tracking links expire 2 hours after a ride |
| Logging | A.8.15 | DE.CM | Built | Tamper-evident audit log of all changes and admin reads |
| Monitoring | A.8.16 | DE.CM, DE.AE | Partly | `/healthz` endpoint; late-ride, SOS and off-route detection. Gap: uptime and error alerting service |
| Protection against abuse | A.8.6, A.8.23 | PR.IR | Partly | Rate limits on login, codes and public forms; OTP attempt limits. Gap: a web firewall at the host |
| Backup | A.8.13 | RC.RP | Partly | `npm run backup` makes a consistent copy. Gap: schedule it and keep copies off the server |
| Change management | A.8.32 | PR.PS | Built | Git history, tests run on every change (`.github/workflows`) |
| Vulnerability management | A.8.8 | ID.RA | Partly | One runtime dependency (Express), `npm audit` clean on 12 Nov 2026. Gap: scheduled scans |
| Physical security | A.7 | PR.AA | Company | Comes from the hosting provider's certification |

## Privacy (DPDP Act 2023 · GDPR)

| Requirement | DPDP | GDPR | Status | How Olub does it |
|---|---|---|---|---|
| Clear notice | s.5 | Art. 12–14 | Built | Plain-language privacy notice in the app and at `/legal` |
| Consent, recorded | s.6 | Art. 6, 7 | Built | Accepted at sign-up; version, time and IP stored; new version asks again |
| Withdraw consent | s.6(4) | Art. 7(3) | Built | Privacy request type; takes effect automatically |
| Only necessary data | s.4, s.8 | Art. 5(1)(c) | Built | The other party sees first name, rating and ID only; KYC ID is admin-only |
| Accuracy / correction | s.12 | Art. 16 | Built | Self-service in Profile; correction request for the rest |
| Access / copy of data | s.11 | Art. 15, 20 | Built | Automatic export file |
| Erasure | s.12 | Art. 17 | Built | Automatic; legal records kept without identity |
| Grievance redressal | s.13 | Art. 77 | Partly | Complaint request type and contact shown. Gap: appoint the officer |
| Verified requester | s.11–14 | Art. 12(6) | Built | Confirmed mobile and email required |
| Response time | Rules | Art. 12(3) (1 month) | Built | Automatic at 5 days, internal target 7, public promise 10–12 |
| Security safeguards | s.8(5) | Art. 32 | Partly | See the security table |
| Breach notification | s.8(6) | Art. 33, 34 | Company | Procedure to notify the Board and affected people |
| Children | s.9 | Art. 8 | Built | Accounts are 18+ only; date of birth checked |
| Disclosure to the State | s.17 | Art. 6(1)(c) | Built | Authority requests: government email, signed letter, review window, full log |
| Data location | Sectoral | Ch. V | Company | Host the server and backups in India |
| Records of processing | — | Art. 30 | Partly | Data inventory in the notice. Gap: formal record if GDPR applies |
