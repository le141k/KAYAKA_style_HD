/**
 * Demo script: POST a fake Alaris monitoring event to the local API.
 *
 * Usage:
 *   TELECOM_HD_ALARIS_WEBHOOK_SECRET=alaris-dev-secret \
 *     npx ts-node -r tsconfig-paths/register src/seed/generate-fake-alaris-event.ts
 *
 * Env vars (all optional, defaults match the dev docker-compose):
 *   API_BASE_URL                   default: http://localhost:4000/api
 *   TELECOM_HD_ALARIS_WEBHOOK_SECRET  default: alaris-dev-secret
 */

import * as https from 'node:https';
import * as http from 'node:http';

const BASE_URL = process.env['API_BASE_URL'] ?? 'http://localhost:4000/api';
const SECRET = process.env['TELECOM_HD_ALARIS_WEBHOOK_SECRET'] ?? 'alaris-dev-secret';

const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

function randomSeverity(): string {
  return SEVERITIES[Math.floor(Math.random() * SEVERITIES.length)] as string;
}

const severity = randomSeverity();
const externalId = `alaris-demo-${Date.now()}`;

const payload = {
  externalId,
  severity,
  message: `Demo: ${severity} alert on node-${Math.floor(Math.random() * 100)}`,
  source: 'generate-fake-alaris-event.ts',
  timestamp: new Date().toISOString(),
  details: {
    cpu: Math.round(Math.random() * 100),
    memory: Math.round(Math.random() * 100),
    node: `node-${Math.floor(Math.random() * 100)}`,
  },
};

const body = JSON.stringify(payload);
const url = new URL(`${BASE_URL}/alaris/webhook`);

const options: http.RequestOptions = {
  hostname: url.hostname,
  port: url.port || (url.protocol === 'https:' ? 443 : 80),
  path: url.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'x-alaris-secret': SECRET,
  },
};

const transport = url.protocol === 'https:' ? https : http;

console.log(`Sending fake Alaris event to ${url.toString()}`);
console.log('Payload:', JSON.stringify(payload, null, 2));

const req = transport.request(options, (res) => {
  let data = '';
  res.on('data', (chunk: Buffer) => {
    data += chunk.toString();
  });
  res.on('end', () => {
    console.log(`\nHTTP ${res.statusCode}`);
    try {
      console.log('Response:', JSON.stringify(JSON.parse(data), null, 2));
    } catch {
      console.log('Response:', data);
    }
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      console.log('\nSuccess: fake Alaris event ingested.');
    } else {
      console.error('\nFailed: check API logs for details.');
      process.exitCode = 1;
    }
  });
});

req.on('error', (err: Error) => {
  console.error('Request error:', err.message);
  process.exitCode = 1;
});

req.write(body);
req.end();
