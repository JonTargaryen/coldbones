"""
batch_processor — TOMBSTONE

This Lambda is no longer deployed.  Offline-mode jobs are now consumed by the
desktop worker process (worker/worker.py) which long-polls SQS directly from
the RTX 5090 machine running LM Studio via Tailscale Funnel.

If this function is accidentally triggered (e.g. a lingering event-source
mapping), it logs a warning and returns without processing — messages will
become visible again and the desktop worker will pick them up.
"""
import json
import logging

logger = logging.getLogger(__name__)


def handler(event: dict, context) -> dict:
    logger.warning(
        'batch_processor invoked but is a tombstone — %d record(s) dropped back '
        'to queue for the desktop worker.',
        len(event.get('Records', [])),
    )
    # Return {} so Lambda does NOT delete messages from SQS.
    # Raising would also work, but this avoids DLQ noise.
    return {}
