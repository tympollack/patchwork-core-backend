'use strict';

const { DynamoDBClient, QueryCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const dynamo = new DynamoDBClient({});

const TABLE_NAME  = process.env.TABLE_NAME;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://api.patchwork.local/webhook/critter-bounty';
const STATUS_INDEX = 'status-index';

const MS_PER_DAY          = 24 * 60 * 60 * 1000;
const BOUNTY_THRESHOLD_MS = 7  * MS_PER_DAY;   // 7-day bounty trigger window
const ARCHIVE_THRESHOLD_MS = 28 * MS_PER_DAY;  // 28-day soft archive window

const WEBHOOK_MAX_RETRIES   = 3;
const WEBHOOK_BASE_DELAY_MS = 1_000;            // 1s base — doubles each retry + jitter

// ---------------------------------------------------------------------------
// Webhook — exponential backoff with full jitter
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fires the critter-bounty webhook for a single node.
 * Retries up to WEBHOOK_MAX_RETRIES times using exponential backoff + full jitter.
 * Returns true on success, false after all retries are exhausted.
 *
 * @param {object} node  Raw DynamoDB item (typed attribute format)
 * @param {number} attempt  Current attempt index (0-based, called recursively)
 * @returns {Promise<boolean>}
 */
async function fireWebhookWithRetry(node, attempt = 0) {
  const nodeId    = node.node_id.S;
  const h3Index   = node.h3_index.S;
  const latitude  = parseFloat(node.latitude.N);
  const longitude = parseFloat(node.longitude.N);

  const payload = { h3_index: h3Index, latitude, longitude, node_id: nodeId };

  try {
    console.log(
      `[INFO] Firing bounty webhook for node ${nodeId} ` +
      `(attempt ${attempt + 1}/${WEBHOOK_MAX_RETRIES + 1}) → ${WEBHOOK_URL}`
    );

    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),    // Hard 10s per attempt
    });

    if (!response.ok) {
      throw new Error(`Webhook responded with HTTP ${response.status} ${response.statusText}`);
    }

    console.log(`[INFO] Webhook confirmed for node ${nodeId} (HTTP ${response.status})`);
    return true;

  } catch (err) {
    if (attempt >= WEBHOOK_MAX_RETRIES) {
      console.error(
        `[ERROR] Webhook permanently failed for node ${nodeId} ` +
        `after ${attempt + 1} attempt(s): ${err.message}`
      );
      return false;
    }

    // Full jitter: delay ∈ [0, base * 2^attempt]
    const cap   = WEBHOOK_BASE_DELAY_MS * Math.pow(2, attempt);
    const delay = Math.floor(Math.random() * cap);

    console.warn(
      `[WARN] Webhook attempt ${attempt + 1} failed for node ${nodeId}: ${err.message}. ` +
      `Retrying in ${delay}ms…`
    );

    await sleep(delay);
    return fireWebhookWithRetry(node, attempt + 1);
  }
}

// ---------------------------------------------------------------------------
// DynamoDB — paginated GSI query (no table scan)
// ---------------------------------------------------------------------------

/**
 * Queries the status-index GSI for all nodes with status = 'awaiting_verification'.
 * Handles DynamoDB pagination automatically via LastEvaluatedKey.
 *
 * @returns {Promise<object[]>}  Array of raw DynamoDB items
 */
async function queryAwaitingVerificationNodes() {
  const nodes = [];
  let lastEvaluatedKey;
  let page = 0;

  do {
    page++;
    const command = new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: STATUS_INDEX,
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames:  { '#s': 'status' },
      ExpressionAttributeValues: { ':s': { S: 'awaiting_verification' } },
      ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
    });

    const response = await dynamo.send(command);
    const items = response.Items ?? [];
    nodes.push(...items);
    lastEvaluatedKey = response.LastEvaluatedKey;

    console.log(
      `[INFO] GSI page ${page}: retrieved ${items.length} node(s) ` +
      `(running total: ${nodes.length})`
    );
  } while (lastEvaluatedKey);

  return nodes;
}

/**
 * Atomically sets bounty_triggered = true.
 * ConditionExpression prevents a double-fire if two workers race.
 *
 * @param {object} node  Raw DynamoDB item
 */
async function setBountyTriggered(node) {
  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: {
      h3_index: node.h3_index,
      node_id:  node.node_id,
    },
    UpdateExpression: 'SET bounty_triggered = :bt',
    ConditionExpression: 'bounty_triggered = :bfalse',
    ExpressionAttributeValues: {
      ':bt':     { BOOL: true  },
      ':bfalse': { BOOL: false },
    },
  }));

  console.log(`[INFO] DynamoDB — bounty_triggered=true written for node ${node.node_id.S}`);
}

/**
 * Atomically sets status = 'archived'.
 * ConditionExpression prevents overwriting a status that has already moved on.
 *
 * @param {object} node  Raw DynamoDB item
 */
async function archiveNode(node) {
  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: {
      h3_index: node.h3_index,
      node_id:  node.node_id,
    },
    UpdateExpression: 'SET #s = :archived',
    ConditionExpression: '#s = :awaiting',
    ExpressionAttributeNames:  { '#s': 'status' },
    ExpressionAttributeValues: {
      ':archived': { S: 'archived'              },
      ':awaiting': { S: 'awaiting_verification' },
    },
  }));

  console.log(`[INFO] DynamoDB — status=archived written for node ${node.node_id.S}`);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * EventBridge-triggered daily lifecycle worker.
 * Enforces two data lifecycle rules against the PatchworkNodes DynamoDB table:
 *
 *   Rule 1 — 7-day bounty trigger:
 *     If a node is older than 7 days and bounty_triggered = false:
 *       → POST to the critter-bounty webhook
 *       → Set bounty_triggered = true in DynamoDB
 *
 *   Rule 2 — 28-day soft archive:
 *     If a node is older than 28 days and status = 'awaiting_verification':
 *       → Set status = 'archived' in DynamoDB
 *       → Node is automatically excluded from mobile client active-map queries
 */
exports.handler = async () => {
  const now = Date.now();
  console.log(`[INFO] LifecycleWorkerFunction invoked at ${new Date(now).toISOString()}`);
  console.log(
    `[INFO] Config — Table: ${TABLE_NAME} | ` +
    `Bounty threshold: 7 days | Archive threshold: 28 days | ` +
    `Webhook: ${WEBHOOK_URL}`
  );

  // --- Step 1: Fetch all awaiting_verification nodes via GSI ---------------
  // Uses the status-index GSI — avoids a full table scan entirely.
  let nodes;
  try {
    nodes = await queryAwaitingVerificationNodes();
  } catch (err) {
    console.error('[ERROR] Failed to query status-index GSI:', err);
    throw err;   // Re-throw — EventBridge will surface this as a failed invocation
  }

  console.log(`[INFO] Total awaiting_verification nodes: ${nodes.length}`);

  if (nodes.length === 0) {
    console.log('[INFO] Nothing to process. Exiting cleanly.');
    return { processed: 0, bountyTriggered: 0, archived: 0, webhookFailed: 0 };
  }

  // --- Step 2: Classify nodes by age ---------------------------------------
  const toTriggerBounty = [];
  const toArchive       = [];

  for (const node of nodes) {
    const timestamp = parseInt(node.timestamp?.N ?? '0', 10);
    const ageMs     = now - timestamp;
    const bountyTriggered = node.bounty_triggered?.BOOL === true;

    if (ageMs > BOUNTY_THRESHOLD_MS && !bountyTriggered) {
      toTriggerBounty.push(node);
    }
    if (ageMs > ARCHIVE_THRESHOLD_MS) {
      toArchive.push(node);
    }
  }

  console.log(
    `[INFO] Classification — ` +
    `bounty candidates: ${toTriggerBounty.length}, ` +
    `archive candidates: ${toArchive.length}`
  );

  // --- Step 3: Rule 1 — 7-day Bounty Trigger --------------------------------
  // Webhook must succeed before we mark the node in DynamoDB.
  // Failures are logged but do not abort the worker run.
  let bountyTriggeredCount = 0;
  let webhookFailedCount   = 0;

  for (const node of toTriggerBounty) {
    const webhookOk = await fireWebhookWithRetry(node);

    if (!webhookOk) {
      webhookFailedCount++;
      console.error(
        `[ERROR] Skipping DynamoDB update for node ${node.node_id.S} — ` +
        `webhook could not be confirmed after ${WEBHOOK_MAX_RETRIES + 1} attempt(s)`
      );
      continue;
    }

    try {
      await setBountyTriggered(node);
      bountyTriggeredCount++;
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        // Another concurrent invocation already set bounty_triggered — safe to ignore.
        console.warn(
          `[WARN] bounty_triggered already true for node ${node.node_id.S} — skipping (idempotent)`
        );
      } else {
        console.error(
          `[ERROR] Failed to write bounty_triggered for node ${node.node_id.S}:`,
          err.message
        );
      }
    }
  }

  // --- Step 4: Rule 2 — 28-day Soft Archive ---------------------------------
  let archivedCount = 0;

  for (const node of toArchive) {
    try {
      await archiveNode(node);
      archivedCount++;
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        // Status was already changed by another process — idempotent, safe to ignore.
        console.warn(
          `[WARN] Node ${node.node_id.S} is no longer awaiting_verification — skipping archive (idempotent)`
        );
      } else {
        console.error(
          `[ERROR] Failed to archive node ${node.node_id.S}:`,
          err.message
        );
      }
    }
  }

  // --- Step 5: Summary ------------------------------------------------------
  const summary = {
    processed:       nodes.length,
    bountyTriggered: bountyTriggeredCount,
    archived:        archivedCount,
    webhookFailed:   webhookFailedCount,
  };

  console.log('[INFO] LifecycleWorkerFunction complete —', JSON.stringify(summary));
  return summary;
};
