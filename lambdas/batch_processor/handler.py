"""
batch_processor — TOMBSTONE (intentionally kept as a safety net)

Original purpose:
  This Lambda was the first design for async processing — it would be triggered
  by an SQS event-source mapping and run inference inside Lambda.

Why it was replaced:
  Lambda has a 10 GB memory limit and cannot run a 35B parameter model.
  The model lives on a home RTX 5090 which has 32 GB VRAM.  Inference must
  happen on that machine, not inside AWS.

Current architecture:
  SQS queue ← analyze_router writes jobs here when desktop is offline
  desktop worker (worker/worker.py) ← long-polls SQS, runs LM Studio locally,
                                       writes results back to DynamoDB

Why keep this file at all?
  CDK still bundles it as a Lambda asset (the construct exists in the stack
  even though it has no event-source mapping).  Keeping the tombstone means
  if a stale CloudFormation event-source mapping or dead-letter queue somehow
  triggers it, the function logs the warning and returns {} — which tells the
  SQS trigger NOT to delete the messages, so the desktop worker can still pick
  them up.  Raising an exception would also leave messages visible, but would
  generate DLQ noise.
"""
import json
import logging

logger = logging.getLogger(__name__)


def handler(event: dict, context) -> dict:
    """Tombstone handler: log a warning and leave SQS messages for the desktop worker."""
    logger.warning(
        'batch_processor invoked but is a tombstone — %d record(s) dropped back '
        'to queue for the desktop worker.',
        len(event.get('Records', [])),
    )
    # Return {} so Lambda does NOT delete messages from SQS.
    # Raising would also work, but this avoids DLQ noise.
    return {}
