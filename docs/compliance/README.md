# Olub compliance pack

Last updated: 12 Nov 2026

This folder describes how Olub meets the standards and laws below, and what is still open.

**Important:** software alone cannot make a company "compliant" or "certified". The app provides the technical controls and the records. The remaining work is organisational: named owners, written approvals, training, supplier contracts, and for the ISO standards an audit by an accredited body. Each document marks what is built and what the company still has to do.

| Document | Covers |
|---|---|
| [controls.md](controls.md) | Control-by-control map: ISO/IEC 27001, NIST CSF 2.0, DPDP Act 2023, GDPR |
| [risk-register.md](risk-register.md) | Risk management in the ISO 31000 format |
| [business-continuity.md](business-continuity.md) | Continuity and recovery plan in the ISO 22301 format |
| [regulatory.md](regulatory.md) | Indian transport rules (Motor Vehicle Aggregator Guidelines), GST, and requests from police / RTO |

## Where each standard stands

| Standard / law | Built into the app | Still needed from the company |
|---|---|---|
| ISO/IEC 27001 (information security) | Access control, encryption of documents, hashed sessions, rate limiting, tamper-evident audit log, security headers | Scope statement, policies signed by management, risk owner sign-off, internal audit, certification audit |
| ISO 22301 (business continuity) | Health check, online backup command, restore steps, stateless app server | Named recovery team, tested restore drills, hosting with a second region |
| ISO 31000 (risk management) | Risk register with treatments tied to app features | Quarterly review by a named owner |
| NIST CSF 2.0 | Controls mapped across Govern, Identify, Protect, Detect, Respond, Recover | Monitoring and alerting service, incident drills |
| DPDP Act 2023 (India) | Consent records, notice, rights requests with automatic answers, erasure, grievance contact, breach log fields | Appoint grievance officer, register as required, breach notification procedure to the Data Protection Board |
| GDPR (EU) | Same rights workflow, data export, erasure, minimisation, audit trail | Only applies if EU residents are served: representative, records of processing, DPIA sign-off |

## How privacy requests work

1. Only an account with a **confirmed mobile number and confirmed email** can send a request (Profile → Privacy & my data).
2. The person gets a reference (`DSR-…`) and an email saying we answer in **10–12 days**. This is the public promise.
3. After a **5-day** cooling-off period the system answers by itself:
   - copy of data → a downloadable file;
   - deletion → personal data wiped, trip and tax records kept without identity;
   - withdraw consent → consent marked withdrawn; the person must accept the terms again to ride.
4. The internal target is **7 days**. If a request passes 7 days it is marked late in the admin console and written to the audit log.
5. Corrections and complaints need a person to answer in the admin console.
6. Every step is in the audit log.

Settings: `DSR_AUTO_PROCESS_AFTER_DAYS`, `DSR_INTERNAL_SLA_DAYS`, `DSR_PUBLIC_SLA_DAYS` in `src/config.js`.

## The audit log

- Every change made through the app is recorded: who, what, when, from which IP address, and the result.
- Every time an admin reads personal data is recorded too.
- Photos, documents, OTPs and tokens are never copied into the log.
- Each entry carries a fingerprint of the entry before it. Changing or deleting any entry breaks the chain, and Admin → People & audit → **Check log integrity** shows where.
