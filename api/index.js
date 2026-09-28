/* Vercel serverless entry point.
   Reuses the single request handler from server.js so there is no duplicated code. */

'use strict';
const { server } = require('../server.js');

module.exports = (req, res) => {
  server.emit('request', req, res);
};
