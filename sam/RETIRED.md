# SAM Stack — Retired

The AWS SAM stack defined in `template.yaml` and Lambda functions in `functions/`
have been replaced as part of the AWS → Cloudflare R2 migration.

## What was replaced

| AWS Resource | Replacement |
|---|---|
| S3 buckets (`patchwork-macro-ports`, `patchwork-staging-ports`) | Cloudflare R2 (`patchwork-ports`, `patchwork-ports-stag`) |
| `SyncNodesFunction` Lambda | Cloudflare Worker (`workers/patchwork-upload-processor`) |
| `LifecycleWorkerFunction` Lambda | cron-job.org → `POST /api/cron/bounty-trigger` + `/archive-nodes` |
| DynamoDB `PatchworkNodes` table | Supabase `patchwork.nodes` (see `sunshade-db-platform`) |
| API Gateway | Express on Render (`src/index.ts`) |

## Tear-down

To remove the AWS resources:
```sh
sam delete --stack-name patchwork-core-backend --region us-east-1
```

Files retained here for historical reference only. Do not redeploy.
