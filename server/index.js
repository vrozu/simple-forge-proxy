const axios = require('axios');
const jose = require('jose')
const express = require('express');
const cors = require('cors')
const pg = require('pg');
const Connector = require('@google-cloud/cloud-sql-connector').Connector;

const { Pool } = pg;

(async () => {
  let connector;
  let clientOpts;
  let pool;

  try {
    connector = new Connector();
    clientOpts = await connector.getOptions({
      instanceConnectionName: process.env.CLOUD_SQL_SOCKET, // 'PROJECT:REGION:INSTANCE'
      authType: 'IAM',
      ipType: 'PRIVATE',
    });
    pool = new Pool({
      ...clientOpts,
      type: 'postgres',

      database: process.env.DB_NAME,      // 'postgres'
      // this can be any database name found on the instance

      user: process.env.DB_USER,          // 'service account e-mail`
      // NOTE: without the ".gserviceaccount.com" domain suffix!
      // NOTE: don't forget to GRANT necessary privileges for this user!

      idleTimeoutMillis: 600000, // 10 minutes
      createTimeoutMillis: 5000, //  5 seconds
      acquireTimeoutMillis: 5000, //  5 seconds
    });
  } catch (e) {
    console.error(e);
  }

  const app = express();
  app.use(cors())
  app.use(express.json());

  const port = 3000;

  app.get('/', (req, res) => {
    res.send('Hello World!');
  });

  app.get('/db-init', async (req, res) => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS dataset (
      id SERIAL NOT NULL,
      created_at timestamp NOT NULL,
      PRIMARY KEY (id)
    );`);
    } catch (e) {
      res.send(JSON.stringify(e));
      return;
    }

    res.send('DB initialized OK');
  });

  app.get('/db-test', async (req, res) => {
    let response;

    try {
      await pool.query('INSERT INTO dataset(created_at) VALUES(NOW())');
      response = await pool.query('SELECT created_at FROM dataset ORDER BY created_at DESC LIMIT 5');
    } catch (e) {
      res.send(JSON.stringify(e));
      return;
    }

    if (response && response.rows) {
      res.send(response.rows);
    } else {
      res.send('no data')
    }
  });

  // Periodically invoked by Forge.
  // Get the token from payload, and save to DB.
  // Also get the `apiBaseUrl` - can use it to call Atlassian APIs.
  app.get('/forge-token', async (req, res) => {
    console.log(`req.headers['x-forge-oauth-system'] = '${req.headers['x-forge-oauth-system']}'`);
    console.log(`req.headers['x-forge-oauth-user'] = '${req.headers['x-forge-oauth-user']}'`);

    let installationId = '';
    let apiBaseUrl = '';
    let appId = '';
    let environmentType = '';
    let environmentId = '';

    let appToken;
    try {
      const authorizationHeader = req.headers.authorization;

      if (authorizationHeader && authorizationHeader.startsWith('Bearer ')) {
        // The token is usually in the 'Authorization' header as a Bearer token.
        appToken = authorizationHeader.substring(7); // Remove "Bearer " preffix.
      }
    } catch (_err) {
      console.error(_err);
    }

    const systemToken = (typeof appToken === 'string' && appToken.length > 0) ? appToken : '';

    try {
      const decoded = jose.decodeJwt(systemToken);

      if (decoded && decoded.app && decoded.app.installationId) {
        installationId = decoded.app.installationId;
        console.log(`Extracted installationId (using jose): ${installationId}`);
      } else {
        console.error("Could not find installationId in the token (using jose).");
      }

      if (decoded && decoded.app && decoded.app.apiBaseUrl) {
        apiBaseUrl = decoded.app.apiBaseUrl;
        console.log(`Extracted apiBaseUrl (using jose): ${apiBaseUrl}`);
      } else {
        console.error("Could not find apiBaseUrl in the token (using jose).");
      }

      if (decoded && decoded.app && decoded.app.id) {
        appId = decoded.app.id;
        console.log(`Extracted appId (using jose): ${appId}`);
      } else {
        console.error("Could not find appId in the token (using jose).");
      }

      if (decoded && decoded.app && decoded.app.environment && decoded.app.environment.type) {
        environmentType = decoded.app.environment.type;
        console.log(`Extracted environmentType (using jose): ${environmentType}`);
      } else {
        console.error("Could not find environmentType in the token (using jose).");
      }

      if (decoded && decoded.app && decoded.app.environment && decoded.app.environment.id) {
        environmentId = decoded.app.environment.id;
        console.log(`Extracted environmentId (using jose): ${environmentId}`);
      } else {
        console.error("Could not find environmentId in the token (using jose).");
      }
    } catch (error) {
      console.error("Error decoding the JWT (using jose):", error);
    }

    const token = req.headers['x-forge-oauth-system'];

    try {
      await pool.query(`INSERT INTO tokens_next(token_value, installation_id, api_base_url, app_id, environment_type, environment_id) VALUES('${token}', '${installationId}', '${apiBaseUrl}', '${appId}', '${environmentType}', '${environmentId}')`);
    } catch (err_2) {
      console.error(err_2);
    }

    return res
      .setHeader('content-type', 'application/json')
      .status(200)
      .send(JSON.stringify({ ok: "Token valid" }));
  });

  app.post('/forge-insert', async (req, res) => {
    const payloadId = (typeof req.body.payloadId === 'string') ? req.body.payloadId : '';
    const payloadData = (typeof req.body.payloadData === 'string') ? req.body.payloadData : '';

    let response;

    try {
      response = await pool.query('SELECT * FROM tokens_next ORDER BY created_at DESC LIMIT 1;');
    } catch (_err) {
      console.error(_err);
    }

    let token = '';

    if (response && response.rows) {
      token = response.rows[0].token_value;
    } else {
      token = '';
    }

    let rawResponse;
    let error = {};
    // Get the URL from installed Forge app.
    const requestUrl = 'https://4174ace3-7376-4b47-a064-cd41702f640e.hello.atlassian-dev.net/x1/I4Szy7GAkYXl5ENYaxoJLWSc18M';

    try {
      rawResponse = await axios.post(
        requestUrl,
        {
          payloadId,
          payloadData,
        },
        {
          headers: {
            // Authorization: `Bearer ${token}`,
            'x-forge-oauth-system': token,
            Accept: "application/json",
          },
        }
      )
    } catch (_err) {
      if (_err.response) {
        error.data = _err.response.data;
        error.status = _err.response.status;
        error.headers = _err.response.headers;
      }

      if (_err.message) {
        error.message = _err.message;
      }
    }

    return res
      .setHeader('content-type', 'application/json')
      .status(200)
      .send(JSON.stringify({
        payloadId,
        payloadData,
        requestUrl,
        error,
        rawResponseData: (rawResponse && rawResponse.data) ?
          rawResponse.data : null
      }))
  });

  app.listen(port, '0.0.0.0', () => {
    console.log('app is listening on port 3000; allows requests from 0.0.0.0;');
  });

})();
