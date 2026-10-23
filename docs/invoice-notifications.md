# Invoice notifications and EZcount replay

EZcount documents that repeating `transaction_id` returns the original document
instead of creating another one. Both the Pelecard reference and EZcount's
Postman reference show a success body with `success`, `pdf_link`, `doc_number`,
and `doc_uuid`; neither documents a duplicate/replay indicator or a lookup by
`transaction_id`:

- https://docs.pelecard.com/documentation/ezcount-document-creation-api/
- https://documenter.getpostman.com/view/16363118/TzkyNLWB

Do not infer creation from HTTP 200 or invent an `already_exists` response field.
Business errors (`errNum`/`errMsg`, optionally `success: false`) can arrive under
HTTP 200. InvoiceCreator validates the business response before counting success.

## Durable history without changing the Sheets writer

InvoiceCreator reads prior invoice mappings from the configured Google Sheets
worksheet using a **read-only** client, once per batch. No header or row is
changed by the history reader. Existing Sheets storage/header behavior is
unchanged. This works across fresh GitHub Actions and Docker processes without a
local cache file or new configuration.

The existing `hash`, `doc_number`, and `pdf_link` columns must be present. Hashes
are matched against both the current `uniqueId` (the exact EZcount
`transaction_id`) and the legacy transaction hash. A saved complete mapping is
attached to the current transaction for downstream storage without creating a
document or sending an individual success. A partial mapping is completed via
the idempotent EZcount request, still without an individual success. Repeated
transactions within a batch are also deduplicated after a successful result.

Summary categories are intentionally:

- **newly recorded**: valid response for an invoice not present in the loaded
  mappings; one individual notification, labelled "newly recorded", not "created";
- **existing**: previously mapped invoice (or already completed in this batch);
- **failed**: HTTP, network, JSON, or business-response failure;
- **unclassified** (when needed): valid response but no usable durable history.
  Metadata is retained, with no individual success notification. This category
  also covers previously stored transaction rows with no invoice metadata.

Notifier failures do not change invoice outcomes, interrupt the batch, or prevent
returning invoice metadata to storage.

## Limits: provider creation cannot be proved from this response

"Newly recorded" is **not** a claim that EZcount just created the document. A
pre-existing EZcount document absent from the worksheet can be reported once as
newly recorded. This can happen after an earlier Sheets save failure or when
historical mappings were never saved. Sheets' existing writer does not backfill
invoice fields on already-stored transaction rows; this change intentionally does
not modify it. Such a row is explicitly unclassified on each run, with individual
notifications suppressed until its mapping is restored externally. Restore
complete invoice mappings for historical transactions to classify them as
existing rather than unclassified.

If Sheets is not configured, the required columns are absent, or history cannot
be read, successes are explicitly unclassified rather than falsely called new.
An unavailable history is not silently replaced with an empty map.

Concurrent runs can both see the same invoice as newly recorded before either
stores it. Enforce non-overlapping scheduled runs if first-seen notifications
must be unique. Exact creation-versus-replay counts, including orphaned invoices
and overlapping runs, require an authoritative EZcount lookup/replay signal or a
complete durable, concurrency-controlled ledger; the documented create response
alone cannot provide them.

No live invoice-creation request is needed for the unit tests.
