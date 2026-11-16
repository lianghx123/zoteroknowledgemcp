# Troubleshooting

## The release or download is unavailable

The release XPI and `SHA256SUMS` are publicly downloadable without signing in. Download the release XPI rather than a source archive. Confirm the required Zotero version and compare `SHA256SUMS` if installation fails.

## No parsing task or missing PDF

Confirm parsing is enabled and saved. Check that the attachment is a PDF and
available locally in Zotero; the plugin does not download missing files.
Use **Parse attachments** for an existing knowledge item. Non-PDF items can
retain metadata without an extraction task.

## A task remains queued or fails

Inspect the task's extraction stage and processing details. Provider queueing
is distinct from local work; unknown progress is not a completed task. Check
the selected provider, endpoint, credentials, quota, network and file limits.
Retry the failed stage rather than repeatedly adding the same paper.

Accepted jobs retain their original provider identity. Preserve a matching
endpoint/key configuration if such a job needs to resume after you change
the selected parser. Disabling parsing does not cancel a request already running.

## Text is available but semantic search is not

Check that model services are enabled, saved and applied, and that the embedding
connection test succeeds. Inspect the semantic stage in Import Tasks and any
startup recovery notice. The selected model/dimensions must match the content's
vector space.

Use **Vectorize existing documents** to generate missing embeddings; this can
consume service quota. Use **Repair search index** when stored vectors exist
but the local index needs rebuilding; repair does not regenerate embeddings.

## The Markdown pane is empty or outdated

Wait for successful publication, then close and reopen the PDF and click **M**.
Confirm you opened the attachment that was processed. Existing content does not
silently adopt new parser normalization rules; explicit reprocessing is needed.
Preserve unsaved edits before closing or reprocessing.

## Settings refuse to save

Check validation messages. Another window or external editor may have changed
the configuration since you opened it. Preserve unsaved values, reload the form
and retry. A successful connection test does not save settings.

## MCP connection fails

- Check the running status and copy the actual configured address.
- Keep Zotero running and the computer awake.
- Confirm the client runs on the same computer and supports authenticated
  Streamable HTTP.
- Check the Bearer token, expiry, authorized libraries and required permissions.
- If the port is occupied, choose a free local port, apply it and update the client.

## PDF scrolling stalls during development automation

Windows UI Automation clients can activate Zotero accessibility and interfere
with PDF scrolling. This has been observed with the Codex computer-use helper
in isolated development checks. Close the task-owned automation session/helper
and restart isolated Zotero before comparing behavior. Do not treat this
test-tool interaction as evidence that every installation has the same issue.

If the problem persists, follow [support](support.md) and include a minimal
reproduction with sanitized details.
