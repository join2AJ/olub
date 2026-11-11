'use strict';

const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const app = createApp(process.env.OLUB_DB ? { dbFile: process.env.OLUB_DB } : undefined);
app.listen(port, () => console.log(`Olub running on http://localhost:${port}`));
