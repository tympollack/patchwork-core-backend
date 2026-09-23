'use strict';

const { DynamoDBClient, BatchWriteItemCommand } = require('@aws-sdk/client-dynamodb');
const { latLngToCell } = require('h3-js');

const dynamo = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME;

/** DynamoDB hard limit: 25 put/delete operations per BatchWriteItem call. */
const DYNAMO_BATCH_LIMIT = 25;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates a single node from the WatermelonDB sync payload.
 * Returns an error string if invalid, or null if the node is valid.
 *
 * @param {unknown} node
 * @param {number}  index  Position in the incoming array (for error messages).
 * @returns {string|null}
 */
function validateNode(node, index) {
  if (!node || typeof node !== 'object') {
    return `Node[${index}]: must be a non-null object`;
  }

  const { id, lat, lng, timestamp } = node;

  if (!id || typeof id !== 'string' || id.trim() === '') {
    return `Node[${index}]: 'id' is required and must be a non-empty string`;
  }
  if (lat === undefined || lat === null || typeof lat !== 'number' || !Number.isFinite(lat)) {
    return `Node[${index}] (id=${id}): 'lat' is required and must be a finite number`;
  }
  if (lng === undefined || lng === null || typeof lng !== 'number' || !Number.isFinite(lng)) {
    return `Node[${index}] (id=${id}): 'lng' is required and must be a finite number`;
  }
  if (lat < -90 || lat > 90) {
    return `Node[${index}] (id=${id}): 'lat' must be in [-90, 90], received ${lat}`;
  }
  if (lng < -180 || lng > 180) {
    return `Node[${index}] (id=${id}): 'lng' must be in [-180, 180], received ${lng}`;
  }
  if (
    timestamp === undefined ||
    timestamp === null ||
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0
  ) {
    return `Node[${index}] (id=${id}): 'timestamp' is required and must be a positive finite epoch number`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Splits an array into sub-arrays of at most `size` elements.
 *
 * @template T
 * @param {T[]}    arr
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Returns a standard API Gateway proxy response object.
 *
 * @param {number} statusCode
 * @param {object} body
 * @returns {object}
 */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /api/sync
 *
 * Expected body:
 * {
 *   "nodes": [
 *     { "id": "<uuid>", "lat": <number>, "lng": <number>, "timestamp": <epoch_ms>,
 *       "description": "<optional string>", "status": "<optional string>" },
 *     ...
 *   ]
 * }
 *
 * Processes each node through the H3 spatial index (Resolution 10) and
 * persists them to DynamoDB via BatchWriteItem.
 */
exports.handler = async (event) => {
  console.log('[INFO] SyncNodesFunction invoked');
  console.log('[DEBUG] Raw event:', JSON.stringify(event));

  // --- Parse body -------------------------------------------------------
  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (parseErr) {
    console.error('[ERROR] Failed to parse request body:', parseErr.message);
    return respond(400, { error: 'Invalid JSON body' });
  }

  // --- Top-level shape check --------------------------------------------
  if (!body || !Array.isArray(body.nodes)) {
    return respond(400, {
      error: "Request body must be a JSON object with a 'nodes' array",
      example: { nodes: [{ id: '<uuid>', lat: 37.7749, lng: -122.4194, timestamp: 1700000000000 }] },
    });
  }

  const { nodes } = body;
  console.log(`[INFO] Received ${nodes.length} node(s) in sync payload`);

  if (nodes.length === 0) {
    return respond(200, { message: 'No nodes to process', received: 0, written: 0 });
  }

  // --- Validate all nodes (fail fast before any writes) -----------------
  const validationErrors = [];
  for (let i = 0; i < nodes.length; i++) {
    const err = validateNode(nodes[i], i);
    if (err) validationErrors.push(err);
  }

  if (validationErrors.length > 0) {
    console.error(
      `[ERROR] Payload rejected — ${validationErrors.length} validation error(s):`,
      validationErrors
    );
    return respond(400, {
      error: 'Validation failed',
      count: validationErrors.length,
      details: validationErrors,
    });
  }

  // --- Compute H3 indexes and build DynamoDB PutRequests ----------------
  /** @type {Record<string, number>} h3_index -> node count (for trace logging) */
  const h3Stats = {};

  const putRequests = nodes.map((node) => {
    const { id, lat, lng, timestamp, description, status } = node;

    const h3Index = latLngToCell(lat, lng, 10);
    h3Stats[h3Index] = (h3Stats[h3Index] || 0) + 1;

    const item = {
      h3_index:         { S: h3Index },
      node_id:          { S: id },
      latitude:         { N: String(lat) },
      longitude:        { N: String(lng) },
      status:           { S: (status && typeof status === 'string') ? status : 'awaiting_verification' },
      timestamp:        { N: String(timestamp) },
      bounty_triggered: { BOOL: false },
    };

    if (description && typeof description === 'string' && description.trim() !== '') {
      item.description = { S: description };
    }

    return { PutRequest: { Item: item } };
  });

  // Trace log per H3 cell
  for (const [h3Index, count] of Object.entries(h3Stats)) {
    console.log(`[INFO] Processed ${count} node(s) into H3 Index ${h3Index}`);
  }

  // --- BatchWriteItem (chunked to respect the 25-item DynamoDB limit) ---
  const batches = chunk(putRequests, DYNAMO_BATCH_LIMIT);
  console.log(
    `[INFO] Writing ${putRequests.length} node(s) across ${batches.length} DynamoDB batch(es) ` +
    `to table '${TABLE_NAME}'`
  );

  let totalWritten = 0;
  const allUnprocessed = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    console.log(`[INFO] Sending batch ${batchIdx + 1}/${batches.length} (${batch.length} item(s))`);

    const command = new BatchWriteItemCommand({
      RequestItems: { [TABLE_NAME]: batch },
    });

    let response;
    try {
      response = await dynamo.send(command);
    } catch (dynamoErr) {
      console.error(
        `[ERROR] DynamoDB BatchWriteItem failed on batch ${batchIdx + 1}/${batches.length}:`,
        dynamoErr
      );
      return respond(502, {
        error: 'DynamoDB write error',
        message: dynamoErr.message,
        failedBatchIndex: batchIdx,
        writtenBeforeFailure: totalWritten,
      });
    }

    const unprocessed = response.UnprocessedItems?.[TABLE_NAME] ?? [];
    if (unprocessed.length > 0) {
      console.warn(
        `[WARN] Batch ${batchIdx + 1} — ${unprocessed.length} item(s) were not processed by DynamoDB (throughput exceeded)`
      );
      allUnprocessed.push(...unprocessed);
    } else {
      console.log(`[INFO] Batch ${batchIdx + 1} committed successfully`);
    }

    totalWritten += batch.length - unprocessed.length;
  }

  // --- Build response ---------------------------------------------------
  const result = {
    message: 'Sync complete',
    received: nodes.length,
    written: totalWritten,
    unprocessedCount: allUnprocessed.length,
    uniqueH3Cells: Object.keys(h3Stats).length,
    h3Summary: h3Stats,
  };

  if (allUnprocessed.length > 0) {
    result.warning =
      `${allUnprocessed.length} item(s) were not written due to DynamoDB throughput limits. ` +
      'The client should retry the unprocessed nodes.';
    console.warn(`[WARN] Sync completed with ${allUnprocessed.length} unprocessed item(s)`);
    return respond(207, result);
  }

  console.log(
    `[INFO] Sync complete — written: ${totalWritten}, unique H3 cells: ${Object.keys(h3Stats).length}`
  );
  return respond(200, result);
};
