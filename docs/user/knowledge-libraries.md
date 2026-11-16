# Knowledge libraries

Knowledge libraries and their folders organize the plugin's selected papers.
They are separate from Zotero's personal/group libraries and native collections.
The same Zotero paper can belong to several knowledge locations while sharing
its processed content.

## Add papers

Use **Add to Knowledge Base** from a native Zotero item or collection context
menu and select a destination. A child attachment admits its parent paper and
links its attachments. Standalone notes and annotations are not admitted as
independent literature items.

One-time collection admission includes direct items. Continuous collection
bindings provide a separate synchronization workflow for descendants.
Eligible PDFs can proceed to parsing when enabled; unavailable PDFs must first
be downloaded or restored through Zotero. The plugin does not download missing
attachments automatically.

## Synchronize a collection

Use the collection synchronization action to create an explicit binding between
a native collection and a knowledge location. A binding can mirror descendants;
one-time admission does not imply an ongoing binding. Inspect its state and
processing in the plugin's synchronization/task views.

Synchronization is one way: native metadata changes refresh the knowledge copy.
Reorganizing knowledge folders does not rename or move native Zotero collections.

## Remove and recover

Removing a paper from a folder removes that placement. Removing it from a
knowledge library affects that membership; other memberships can remain.
These actions do not delete the original Zotero item or its PDF.

Use Knowledge Trash to inspect and restore recoverable plugin removals. Review
the target carefully before permanent deletion. Trash is not an external backup.

Native Zotero trash and unavailable sources can hide papers from active
knowledge results. Restoring the original item and refreshing metadata can
restore availability. See [data and privacy](privacy.md) for reset and backup behavior.
