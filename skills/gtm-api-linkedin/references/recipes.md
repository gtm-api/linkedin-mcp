# Worked flows

Every flow below discovers its tool names at runtime. Names are deliberately not hardcoded here,
because the catalog changes as toolsets ship and a stale name in a skill file is worse than no
name at all. The shape of each flow is stable; the tool names come from `get_toolset_tools`.

## Before any flow

```
list_toolsets                                  -> domains available to this account
get_toolset_tools { toolset, verbose: true }   -> exact names and parameters
```

Do this once per session and keep the result. Re-reading the catalog before every call wastes
context for no gain.

If the user has more than one LinkedIn account connected, resolve which one you are acting as
before the first outward action, and say so. Acting on the wrong account is not recoverable.

## Accept invitations and welcome the ones that fit

The most common standing request, and the one where the preview gate matters most.

1. Read pending invitations from the network toolset. Most listings are paginated; take one page
   and work it rather than pulling everything.
2. Filter locally against the user's stated criteria. Do not send the filter to the server as a
   free-text query and hope.
3. For each accept: call the action, read the preview, then commit with `commit_token`.
4. For a welcome message: same two-step, one message at a time.
5. Check the remaining allowance before the batch, and stop when it is spent. Report where you
   stopped and what is left.

Do not accept and message in a tight loop over a long list. Size the batch to the account's
allowance first.

## Find people, then act on a subset

1. Search from the search toolset with the narrowest criteria you have. Broad searches burn
   allowance and return noise.
2. Enrich only the profiles you will actually act on. Enrichment on a full result set is the
   most common way to waste a day's budget.
3. Present the shortlist to the user before any outward action.
4. Send connection requests one at a time through the preview gate.

A connection request with a note and a request without one are usually different actions with
different budgets. Read both in the verbose listing before choosing.

## Read and answer the inbox

1. Pull conversations from the messaging toolset, newest first.
2. Fetch the thread before replying. Replying from a preview line is how an agent answers a
   question nobody asked.
3. Draft, show the draft, then commit.

Inbox reads are inbound and cheap. Replies are outward and gated like everything else.

## Report what an account can do today

Useful on its own, and worth running before any bulk plan.

1. Read the account's smart limits and health snapshot from the account health toolset.
2. Report per-action budgets, what is already spent, and when the window refreshes.
3. If the account is new, say so. A young account is throttled on purpose and the allowance grows
   as it ages.

## Scheduling

There is no need to build your own pacing loop. Bulk work is spread server-side with randomized
gaps. Hand the work over and report, rather than sleeping between calls in your own runtime.

If the user wants something to run every morning, that is a scheduled job on their side calling
the same tools, not a long-lived agent holding a loop open.
