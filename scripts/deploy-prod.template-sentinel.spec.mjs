import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptsDir);
const script = readFileSync(join(scriptsDir, 'deploy-prod.sh'), 'utf8');
const cutoverRunbook = readFileSync(
  join(root, 'docs', 'INBOUND_PRODUCTION_CUTOVER.md'),
  'utf8',
);
const preflight = readFileSync(join(scriptsDir, 'preflight.sh'), 'utf8');
const productionEnvTemplate = readFileSync(join(root, '.env.prod.example'), 'utf8');
const apiDockerfile = readFileSync(join(root, 'apps', 'api', 'Dockerfile'), 'utf8');
const developmentCompose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
const productionCompose = readFileSync(join(root, 'docker-compose.prod.yml'), 'utf8');

const guards = [
  `NULLIF(regexp_replace("subject", '[[:space:]]+', '', 'g'), '') IS NOT NULL`,
  `NULLIF(regexp_replace("htmlBody", '[[:space:]]+', '', 'g'), '') IS NOT NULL`,
  `NULLIF(regexp_replace("textBody", '[[:space:]]+', '', 'g'), '') IS NOT NULL`,
];

test('deploy template sentinel rejects every whitespace-only required field', () => {
  for (const source of [script, cutoverRunbook]) {
    for (const guard of guards) assert.ok(source.includes(guard), guard);
    assert.ok(!source.includes('NULLIF(BTRIM("subject"), \'\') IS NOT NULL'));
  }

  // This mirrors PostgreSQL [[:space:]]+ for the inputs that BTRIM misses.
  const isPresent = (value) => value.replace(/\s+/gu, '').length > 0;
  for (const whitespace of ['', ' ', '\t', '\n', ' \t\n ']) {
    assert.equal(isPresent(whitespace), false, JSON.stringify(whitespace));
  }
  assert.equal(isPresent(' A \n'), true);
});

test('preflight closes inbound delivery and IMAP before deploy-prod can start release work', () => {
  assert.match(productionEnvTemplate, /^TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=false$/m);
  assert.match(productionEnvTemplate, /^TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID=$/m);
  assert.match(productionEnvTemplate, /^TELECOM_HD_OUTBOUND_CANARY_RECIPIENT=$/m);
  assert.match(productionEnvTemplate, /^TELECOM_HD_INBOUND_DELIVERY_ENABLED=false$/m);
  assert.match(productionEnvTemplate, /^TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=$/m);
  assert.match(productionEnvTemplate, /^TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID=$/m);
  assert.match(productionEnvTemplate, /^TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED=false$/m);
  assert.match(productionEnvTemplate, /^TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES=1$/m);
  assert.match(productionEnvTemplate, /^TELECOM_HD_IMAP_ENABLED=false$/m);
  assert.ok(preflight.includes('TELECOM_HD_OUTBOUND_DELIVERY_ENABLED'));
  assert.ok(preflight.includes('TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID'));
  assert.ok(preflight.includes('TELECOM_HD_OUTBOUND_CANARY_RECIPIENT'));
  assert.ok(preflight.includes('TELECOM_HD_INBOUND_DELIVERY_ENABLED'));
  assert.ok(preflight.includes('TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID'));
  assert.ok(preflight.includes('TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID'));
  assert.ok(preflight.includes('TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED'));
  assert.ok(preflight.includes('TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES'));
  assert.ok(preflight.includes('TELECOM_HD_IMAP_ENABLED'));
  assert.ok(preflight.includes('if is_true "$OUTBOUND_DELIVERY_ENABLED"; then'));
  assert.ok(preflight.includes('if is_true "$INBOUND_DELIVERY_ENABLED"; then'));
  assert.ok(preflight.includes('if is_true "$CAPTURE_ONLY_ENABLED"; then'));
  assert.ok(preflight.includes('if is_true "$IMAP_ENABLED"; then'));

  const preflightInvocation = script.indexOf('bash scripts/preflight.sh "$ENV_FILE"');
  const forwardBoundary = script.indexOf("crossing the verified forward-only boundary");
  assert.ok(preflightInvocation >= 0, 'deploy-prod must invoke preflight');
  assert.ok(forwardBoundary > preflightInvocation, 'preflight must run before migration/service work');
});

test('the production capture canary uses its dedicated read-only preflight, not the local test helper', () => {
  assert.ok(
    cutoverRunbook.includes('bash scripts/preflight-production-capture-only.sh .env.prod'),
    'cutover must invoke the production capture preflight',
  );
  assert.ok(!cutoverRunbook.includes('bash scripts/preflight-capture-only.sh .env.prod'));
});

test('the promotion-only normal canary documents its dedicated production preflight and selectors', () => {
  assert.ok(
    cutoverRunbook.includes('bash scripts/preflight-production-normal-canary.sh .env.prod'),
    'cutover must invoke the production normal-canary preflight',
  );
  for (const key of [
    'TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID',
    'TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID',
    'TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID',
    'TELECOM_HD_OUTBOUND_CANARY_RECIPIENT',
  ]) {
    assert.ok(cutoverRunbook.includes(key), key);
  }
});

test('both upgrade and first-install paths prove pgcrypto capability before Prisma migrations', () => {
  const capability = 'assert_pgcrypto_migration_capability';
  const migration = 'npx prisma migrate deploy';
  const firstInstall = script.indexOf('Starting private dependencies for first-install migration gate.');
  assert.ok(firstInstall >= 0, 'expected a distinct first-install gate');
  const firstInstallCapability = script.indexOf(capability, firstInstall);
  const firstInstallMigration = script.indexOf(migration, firstInstall);
  assert.ok(firstInstallCapability > firstInstall, 'first install must check pgcrypto after PostgreSQL starts');
  assert.ok(firstInstallMigration > firstInstallCapability, 'first install must check pgcrypto before migration');

  const existingCapability = script.indexOf(capability, script.indexOf('if [[ "$EXISTING_RELEASE" == true ]]; then'));
  const existingMigration = script.indexOf(migration, script.indexOf('if [[ "$EXISTING_RELEASE" == true ]]; then'));
  assert.ok(existingCapability >= 0 && existingCapability < existingMigration, 'upgrade must check pgcrypto before migration');
});

test('disposable PostgreSQL gate proves the mailbox constraint semantics, not only its name', () => {
  for (const sentinel of [
    "EmailQueue_mailbox_valid accepts leading whitespace",
    "EmailQueue_mailbox_valid accepts leading tab whitespace",
    "EmailQueue_mailbox_valid accepts trailing whitespace",
    "EmailQueue_mailbox_valid accepts a line break",
    "EmailQueue_mailbox_valid accepts an empty folder",
    "EmailQueue_mailbox_valid accepts more than 255 code points",
    "InboundDeliveryState has an unexpected CAPTURED enum order",
  ]) {
    assert.ok(cutoverRunbook.includes(sentinel), sentinel);
  }
  assert.ok(cutoverRunbook.includes('EXCEPTION WHEN check_violation THEN'));
});

test('API runtime image resolves workspace-local production dependencies', () => {
  assert.match(
    apiDockerfile,
    /^ENV NODE_PATH=\/app\/apps\/api\/node_modules:\/app\/node_modules$/m,
    'Nest dynamically loads @nestjs/platform-express from the API workspace',
  );
});

test('API starts only after the upload volume is safely prepared for its non-root user', () => {
  for (const compose of [developmentCompose, productionCompose]) {
    assert.match(compose, /\n  uploads-init:\n/);
    assert.match(compose, /user: "0:0"/);
    assert.match(compose, /restart: "no"/);
    assert.match(compose, /chown -Rh 1000:1000 \/app\/uploads/);
    assert.match(compose, /uploads-init:\n        condition: service_completed_successfully/);
  }
});

test('deploy inventory accepts the completed one-shot upload-volume initializer', () => {
  assert.match(
    script,
    /postgres\|redis\|clamav\|api\|web\|caddy\|proxy\|uploads-init/,
    'a completed Compose uploads-init container is part of the known release inventory',
  );
});
