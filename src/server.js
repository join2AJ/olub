'use strict';

const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const app = createApp(process.env.OLUB_DB ? { dbFile: process.env.OLUB_DB } : undefined);

// Background jobs: late-ride alerts and automatic privacy-request handling.
setInterval(() => { try { app.locals.tick(); } catch (e) { console.error('[tick]', e); } }, 30 * 1000).unref();

app.listen(port, () => console.log(`Olub running on http://localhost:${port}`));
