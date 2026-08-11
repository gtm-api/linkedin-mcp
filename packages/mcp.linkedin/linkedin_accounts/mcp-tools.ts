// Entity: LinkedIn Account (gtm.service.linkedin)
// Source of truth: product/research/gtm.service.linkedin/entities/linkedin_accounts.md
// Format: registry v2, where each tool carries route metadata so the generic
// dispatcher can drive it. 24 tools: 22 on the linkedin-accounts route group,
// plus the 2 follow-edge writes that sit on /api/linkedin-followings/ and are
// filed here because this file is the research file that owns that edge (see
// the block above follow_linkedin_member). Smart-limits (3 more) share the
// /mcp/linkedin/accounts mount from their own entity file, so the mount stands
// at 27 of its 27 budget: the NEXT tool added to either package breaks worker
// boot, since resolveMounts throws at module scope. Count before you add.
//
// That budget was 25 until the three self-account feeds landed on 2026-08-07
// and pushed the mount to 27. The raise is recorded, with its alternatives and
// the reason it is still unsigned, in apps/worker/src/mounts.config.ts. Read it
// before adding the 28th tool: the answer there may well be a split, not
// another raise.

import { z } from 'zod';
import type { ToolDefinition } from '@gtm/mcp-runtime/types';
import {
  AccessIdentityValueActorTypeEnum,
  HandoverRoleEnum,
  filterOp,
  usageMetaField,
  McpActionResponse,
  McpAsyncActionResponse,
  McpGetRequestSchema,
  McpGetResponse,
  McpSearchRequestSchema,
  McpSearchResponse,
  McpUpdateResponse,
} from '@gtm/mcp-shared';

const SID = z.string().length(18).startsWith('ln_ac_')
  .describe('LinkedIn account sid (ln_ac_…).');

// LinkedinAccountStatusEnum, in its PHP order. Named once and reused by the
// item projection and the status filter so the two cannot drift apart.
const LinkedinAccountStatus = z.enum([
  'new',
  'initial_syncing',
  'active',
  'sync_failed',
  'shared_out',
  'subscription_required',
]);

// Target person for outward/probe actions: at least one identifier (backend-validated).
const Target = z.object({
  ln_id: z.string().optional().describe('LinkedIn member id.'),
  sn_id: z.string().optional().describe('Sales Navigator member id.'),
  nickname: z.string().optional().describe('Public profile slug.'),
}).describe('Target person; provide at least one of ln_id / sn_id / nickname.');

// Item projection: mirrors LinkedinAccountDomain (research §Domain) field-by-field.
// Trailing .passthrough() is forward-compat only (backend may add fields).
// Counts stays passthrough: the counts block is an auto-computed .groups
// distribution with no fixed shape documented (research §Groupable fields).
const LinkedinAccount = z.object({
  // PK → tenant → FK
  sid: z.string(),
  team_sid: z.string(),
  antidetect_browser_sid: z.string(),

  // Lifecycle state (LinkedinAccountStatusEnum). It is NOT derivable from the
  // timestamps: shared_out and subscription_required say the account is
  // unusable for reasons no clock records, and new / initial_syncing /
  // sync_failed are the onboarding phases initial_sync_completed_at alone
  // cannot tell apart (null means both "never started" and "failed").
  status: LinkedinAccountStatus,

  // Sharing linkage (sharing rework). Non-null only while the account is inside
  // a share; share_role says which side of it this row is.
  account_share_sid: z.string().nullable(),
  share_role: HandoverRoleEnum.nullable(),

  // Contact identity
  ln_id: z.string().nullable(),
  ln_member_id: z.string().nullable(),
  sn_id: z.string().nullable(),
  nickname: z.string().nullable(),

  // Display essentials
  full_name: z.string().nullable(),
  avatar_url: z.string().nullable(),

  // Operator display fields - team-authored, never synced from LinkedIn.
  display_name: z.string().nullable(),
  label: z.string().nullable(),

  // Premium / Sales-Navigator flags
  has_premium: z.boolean(),
  has_sn: z.boolean(),
  has_recruiter: z.boolean(),
  inmail_credits: z.number().nullable(),
  last_premium_check_at: z.string().nullable(),

  // Per-entity sync clocks
  last_connections_sync_at: z.string().nullable(),
  last_conversations_sync_at: z.string().nullable(),
  last_sales_navigator_conversations_sync_at: z.string().nullable(),
  last_connection_requests_sync_at: z.string().nullable(),
  last_connection_invitations_sync_at: z.string().nullable(),
  last_followers_sync_at: z.string().nullable(),
  last_snapshot_at: z.string().nullable(),

  // Initial-sync gate (one-way latch)
  initial_sync_completed_at: z.string().nullable(),

  // Heartbeat
  last_heartbeat_at: z.string().nullable(),

  // Configuration: shared Value objects, Partial<Record<enum, …>> ⇒ .partial()
  sync_config: z.object({
    entries: z.object({
      connections: z.object({ interval_minutes: z.number() }),
      conversations: z.object({ interval_minutes: z.number() }),
      sales_navigator_conversations: z.object({ interval_minutes: z.number() }),
      connection_requests: z.object({ interval_minutes: z.number() }),
      connection_invitations: z.object({ interval_minutes: z.number() }),
      premium_check: z.object({ interval_minutes: z.number() }),
      snapshot_check: z.object({ interval_minutes: z.number() }),
    }).partial().describe('Per-track sync-interval overrides, keyed by sync track.'),
    timezone: z.string().describe('IANA timezone the window is evaluated in.'),
    window: z.array(z.object({
      day_of_week: z.number().int().min(1).max(7),
      start_minute: z.number().int().min(0).max(1439),
      end_minute: z.number().int().min(1).max(1440),
    })).describe('Weekly sync-activity window blocks; empty = always open.'),
  }).partial().nullable(),
  webhook_config: z.object({
    connections: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    connection_requests: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    connection_invitations: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    conversations: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    sales_navigator_conversations: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    messages: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    followers: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    snapshot: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    strike_log: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
    limits: z.object({ enabled: z.boolean(), since: z.string().nullable() }),
  }).partial().nullable(),

  // Audit: AccessIdentityValue (shared)
  created_by: z.object({
    actor_type: AccessIdentityValueActorTypeEnum,
    actor_sid: z.string().nullable(),
    team_sid: z.string(),
    permissions: z.record(z.unknown()),
    request_sid: z.string().nullable().optional(),
    reason: z.string().nullable(),
  }),

  // Timestamps
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
}).passthrough();

const LinkedinAccountCounts = z.object({}).passthrough();

const LinkedinAccountFilter = z.object({
  q: z.string().optional().describe('Full-text LIKE over full_name + nickname. Identity ids (ln_member_id, sn_id) are exact-match fields, not q targets.'),

  // Lifecycle state. This filter (and the item field) used to be absent, under a
  // comment claiming the account carried no status enum and that its state was
  // derived from the timestamps and from the bound browser. That stopped being
  // true when the sharing rework added LinkedinAccountStatusEnum and the column
  // behind it, and LinkedinAccountFilter declares `status`.
  status: filterOp(LinkedinAccountStatus, ['eq', 'ne', 'in', 'nin']).optional()
    .describe('Lifecycle state. active = usable; shared_out = lent to another team; subscription_required = plan lapsed.'),

  // Identity / linkage (exact-match; substring on full_name/nickname is via q).
  sid: filterOp(z.string(), ['eq', 'in']).optional(),
  antidetect_browser_sid: filterOp(z.string(), ['eq', 'in']).optional(),
  account_share_sid: filterOp(z.string(), ['eq', 'in', 'is_null']).optional()
    .describe('is_null:false = the account is currently inside a share.'),
  ln_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  ln_member_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  sn_id: filterOp(z.string(), ['eq', 'ne', 'in', 'nin', 'is_null']).optional(),
  nickname: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  full_name: filterOp(z.string(), ['eq', 'in', 'is_null']).optional(),
  avatar_url: filterOp(z.string(), ['is_null']).optional()
    .describe('Display-completeness predicate only (is_null); the URL value is not a filter axis.'),

  // Premium / Sales-Navigator flags.
  has_premium: filterOp(z.boolean(), ['eq']).optional(),
  has_sn: filterOp(z.boolean(), ['eq']).optional(),
  has_recruiter: filterOp(z.boolean(), ['eq']).optional(),
  inmail_credits: filterOp(z.number().int(), ['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'is_null']).optional()
    .describe('is_null:true = last parse failed.'),
  last_premium_check_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),

  // Per-entity sync clocks (staleness / scheduler predicates).
  last_connections_sync_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  last_conversations_sync_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  last_sales_navigator_conversations_sync_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  last_connection_requests_sync_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  last_connection_invitations_sync_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),
  last_snapshot_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),

  // Onboarding gate + heartbeat.
  initial_sync_completed_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional()
    .describe('Onboarding gate; is_null:true = still onboarding, is_null:false = ready.'),
  last_heartbeat_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt', 'is_null']).optional(),

  // Timestamps.
  created_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  updated_at: filterOp(z.string(), ['gte', 'lte', 'gt', 'lt']).optional(),
  deleted_at: filterOp(z.string(), ['is_null', 'gte', 'lte']).optional()
    .describe('Default scope is { is_null: true } (live accounts).'),
}).partial();

// ─── Self-read insight projections (rows 40 / 41, LIVE since 2026-07-30) ───
//
// Both are transient: the account row is the envelope item, these are the action
// `result` payloads and nothing is persisted.
//
// Scores are z.number(), never z.number().int(). A live SSI read is 53.496 with
// pillars 11.546 / 7.2 / 9.75 / 25. The research file's "0-100" and "each 0-25"
// describe the RANGE, and reading them as an integer type truncates a real
// measurement. Note that a whole-number score still encodes as `25` in JSON, so
// consumers must accept both forms of number.
const LinkedinAccountSsiResult = z.object({
  status: z.string().describe('Plugin dispatch status for this read.'),
  ssi: z.object({
    active_seat: z.boolean()
      .describe('Whether the account holds a live Sales Navigator seat. False does NOT mean the scores are absent.'),
    overall: z.number().describe('0-100, the sum of the four pillars. Fractional.'),
    pillars: z.object({
      professional_brand: z.number(),
      find_right_people: z.number(),
      insight_engagement: z.number(),
      strong_relationship: z.number(),
    }).describe('The four SSI components, each 0-25 and fractional.'),
    group_ranks: z.array(z.object({
      group_type: z.string().describe('INDUSTRY or NETWORK. Open string: a group LinkedIn adds must surface, not vanish.'),
      rank: z.number().int().describe('Percentile standing inside the group, lower is better.'),
      group_size: z.number().int(),
      industry: z.string().nullable().optional().describe('Present on the INDUSTRY group only.'),
      overall: z.number().describe('SSI recomputed within this comparison group.'),
    })).describe('Peer-group standings. Empty when the read failed.'),
  }),
}).passthrough();

const LinkedinAccountAnalyticsResult = z.object({
  status: z.string().describe('Plugin dispatch status for this read.'),
  analytics: z.object({
    date_from: z.string().describe('Window start actually reported on, YYYY-MM-DD.'),
    date_to: z.string(),
    metrics: z.record(z.object({
      total: z.number().int().describe('Period total, equal to the sum of the daily series.'),
      change_percent: z.number().nullable()
        .describe('Magnitude of the change vs the prior period. UNSIGNED: pair it with change_direction, and when that is null the direction is genuinely unknown.'),
      change_direction: z.enum(['up', 'down']).nullable()
        .describe('Often null in practice, including when change_percent is present. Treat null as unknown, never as flat or as up.'),
      daily: z.array(z.object({ date: z.string(), value: z.number().int() }))
        .describe('One point per day in the window, UTC dates.'),
    })).describe('Keyed by wire metric name (impressions, engagements today). An OPEN map: new dashboard cards appear as new keys.'),
  }),
}).passthrough();

// ─── Self-read FEED projections (the three readers the node shipped 2026-08-07) ───
//
// Same transient shape as the two insight reads above: the account row is the
// envelope item, these are the action `result` payloads, and nothing is
// persisted. What is new is paging, and the three page differently enough that
// they cannot share a row type.
//
// THE ABSENT-VS-NULL CONTRACT, and why every optional field below carries BOTH
// .nullable() and .optional(). The research file states the wire fact: every
// node parser assigns `undefined` for a field it could not read, the plugin
// frame is JSON.stringify'd, so the key is DELETED and "key missing" is the one
// unknown state. It also tells the backend not to normalize that into a null.
// But BaseValue::toArray() is get_object_vars(), so a value object that simply
// declares `?string $headline = null` emits `"headline": null` and cannot
// produce an absence at all. The projector does not exist yet, so pinning this
// schema to one of the two forms would just be a guess about which way the
// backend resolves it. `.nullable().optional()` is the union and cannot
// disagree with either, and it is exactly the shape this file already uses for
// the one genuinely-absent field it ships today (`industry` on the SSI group
// rank). What must NOT happen is a field being present with a MEANINGFUL null,
// so read null and missing as the same thing everywhere on these three rows.
//
// The same reasoning covers the sales-nav sub-objects from the other side: the
// node decides primary_cta / lead / account presence from the raw decoration
// being non-null, never from an inner field surviving the coercers, so `lead:
// {}` with nothing in it is a real answer and every inner field is optional.
//
// None of the three carries a total, and none carries a has-more flag. The only
// end-of-feed signal is next_page_cursor being absent.
const SelfFeedPaging = (pageSizeNote: string) => z.object({
  // page_size / page_cursor are typed non-optional by the research file, but
  // nullable here on purpose: fetchSelf answers a NON-success plugin response
  // with result: [], and fromWire([]) is required to tolerate that WITHOUT
  // inventing a page, which leaves nothing truthful to put in either field.
  page_size: z.number().int().nullable().describe(pageSizeNote),
  page_cursor: z.string().nullable()
    .describe('Absolute offset of the page just read, as a string. It is not an opaque token, but treat it as one.'),
  next_page_cursor: z.string().nullable().optional()
    .describe('Pass back as `cursor` to get the next page. ABSENT means the feed is over, and that is the ONLY end signal: there is deliberately no total and no has-more flag.'),
});

// A profile-views row. `position` and `is_anonymous` are the only two fields
// LinkedIn always fills; everything else depends on what the card rendered.
const LinkedinAccountProfileViewRow = z.object({
  position: z.number().int()
    .describe("LinkedIn's own rank for this viewer, read off the card. Server-authored and the sort key, ascending."),
  is_anonymous: z.boolean()
    .describe('True when the viewer browsed in private mode. Branch on this FIRST: an anonymous row has a descriptor instead of a name, a search url instead of a profile, and no member ids at all.'),
  display_name: z.string().nullable().optional()
    .describe('The viewer name. On an ANONYMIZED row this holds the descriptor LinkedIn shows instead, e.g. "Someone at Acme" or "Executive Director in the software industry".'),
  headline: z.string().nullable().optional(),
  network_distance: z.string().nullable().optional()
    .describe('Rendered degree: "1st" / "2nd" / "3rd". LinkedIn prefixes the line with punctuation, which is stripped before you see it.'),
  url: z.string().nullable().optional()
    .describe('Profile url for a named viewer. For an ANONYMIZED viewer it is a PEOPLE-SEARCH url instead, so there is nothing to open and it is not an identity key.'),
  public_identifier: z.string().nullable().optional()
    .describe('Vanity slug, taken from url. Never present on an anonymized row, because that url is a search rather than a profile.'),
  profile_id: z.string().nullable().optional()
    .describe('ACoA member id. Present only when the card offered the MESSAGE action, which depends on network distance.'),
  member_urn: z.string().nullable().optional()
    .describe('urn:li:member:N. Present only when the card offered the CONNECT action. A row may carry this, profile_id, both, or neither.'),
  image_url: z.string().nullable().optional()
    .describe('Viewer avatar. An anonymized card renders a ghost placeholder and carries none.'),
  company_logo_url: z.string().nullable().optional(),
  viewed_at_text: z.string().nullable().optional()
    .describe('RENDERED relative text, exactly as LinkedIn printed it, e.g. "Viewed 1w ago". Locale-bound and not parseable: this feed ships no machine-readable date anywhere.'),
  mutual_connections_text: z.string().nullable().optional()
    .describe('Rendered shared-connections line, e.g. "3 mutual connections".'),
}).passthrough();

// A catch-up nurture card. `position` is the only always-present field, and it
// is the one field on this row you must NOT key on.
const LinkedinAccountCatchUpCardRow = z.object({
  position: z.number().int()
    .describe('Index in the feed. OURS, not LinkedIn\'s: it counts the cards that parsed, so a card we could not read shifts every card after it. Key a card by card_urn.'),
  card_urn: z.string().nullable().optional()
    .describe('urn:li:prop:(TYPE,id): the id of the NURTURE PROMPT, not of the member and not of a post. The only stable key on the row.'),
  type: z.string().nullable().optional()
    .describe('Prompt type, taken off the urn. Captured so far: BIRTHDAY, JOB_CHANGE, WORK_ANNIVERSARY. OPEN vocabulary, so treat an unseen value as valid rather than as an error.'),
  display_name: z.string().nullable().optional()
    .describe('The person the card is about, as rendered. May carry emoji that a profile field would not.'),
  prompt_text: z.string().nullable().optional()
    .describe('The card\'s second line, e.g. "Celebrate Jane\'s recent birthday on Aug 6". The date exists ONLY here, as rendered words.'),
  suggested_message: z.string().nullable().optional()
    .describe('The label LinkedIn printed on the card\'s primary button, which for these cards is the one-click message itself, e.g. "Happy birthday!".'),
  message_sent: z.boolean().nullable().optional()
    .describe('True when this account already sent that card\'s message, so the card is spent. NULL means LinkedIn reported nothing for it, which is NOT the same as false.'),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  public_identifier: z.string().nullable().optional(),
  profile_id: z.string().nullable().optional(),
  member_urn: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
}).passthrough();

// The three sales-nav sub-objects. Each is null when the alert carried no such
// decoration, and fully keyed with nulls when it carried an empty one: presence
// is decided upstream by the raw block being non-null, never by its contents.
const LinkedinAccountSalesNavCta = z.object({
  text: z.string().nullable().optional(),
  type: z.string().nullable().optional()
    .describe('VIEW_UPDATE, MESSAGE, SAVE_LEAD and so on. Open vocabulary, same as the alert type.'),
  action_target: z.string().nullable().optional(),
}).passthrough();

const LinkedinAccountSalesNavLead = z.object({
  entity_urn: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  full_name: z.string().nullable().optional(),
  degree: z.number().int().nullable().optional()
    .describe('Network distance as a NUMBER, so 1 is a 1st-degree connection. Not the rendered "1st" string the profile-views feed uses.'),
  saved: z.boolean().nullable().optional().describe('Whether this lead is saved in Sales Navigator.'),
  image_url: z.string().nullable().optional(),
}).passthrough();

const LinkedinAccountSalesNavAccount = z.object({
  entity_urn: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  saved: z.boolean().nullable().optional().describe('Whether this company is saved as an account in Sales Navigator.'),
  image_url: z.string().nullable().optional(),
}).passthrough();

// A Sales Navigator alert. notification_urn is the one guaranteed field: a raw
// row carrying no id is dropped before it reaches us, which is why the paging
// of this reader deliberately counts raw rows and not these.
const LinkedinAccountSalesNavNotificationRow = z.object({
  notification_urn: z.string()
    .describe('urn:li:notificationV2:(...). The row identity, and the only field always present.'),
  type: z.string().nullable().optional()
    .describe('Alert kind. Captured so far: ACCOUNT_SHARED_UPDATE, LEAD_SHARED_UPDATE, LEAD_ACCEPTED_INVITATION, LEAD_POSITION_CHANGE_NEW_COMPANY, LEAD_POSITION_CHANGE_SAME_COMPANY, LEAD_PROFILE_VIEW_SIGNAL, EMPLOYEE_AT_ACCOUNT_PROFILE_VIEW. OPEN vocabulary: never validate against that list, LinkedIn adds kinds.'),
  headline: z.string().nullable().optional().describe('Rendered headline, e.g. "Suggested lead: Jane shared a post".'),
  body_text: z.string().nullable().optional().describe('The shared post text. Shared-update alerts only.'),
  subline: z.string().nullable().optional().describe('Secondary line, e.g. "Acme Corp, Head of Sales".'),
  published_at: z.number().int().nullable().optional()
    .describe('UNIX epoch MILLISECONDS, passed through exactly as LinkedIn sent it. The ONLY machine-readable timestamp across all three self feeds, and the field to sort on, because the feed itself comes back ordered by relevance.'),
  read: z.boolean().nullable().optional(),
  score: z.number().nullable().optional()
    .describe("LinkedIn's own relevance score for the alert. This is what the feed order is built on."),
  action_target: z.string().nullable().optional()
    .describe('Main click-through: the post for a shared update, the sales profile page otherwise.'),
  entity_url: z.string().nullable().optional()
    .describe('The lead or account sales page, present EVEN WHEN action_target points at a post. Use it when you want the person rather than the thing they did.'),
  associated_entity_urn: z.string().nullable().optional()
    .describe('urn:li:share:N for a shared update; a member urn or a position-change urn on the person-level alerts.'),
  subject_entity_urn: z.string().nullable().optional()
    .describe('urn:li:fs_salesProfile:(...) of the lead the alert is about.'),
  company_urn: z.string().nullable().optional().describe('urn:li:fs_salesCompany:N, on account-level alerts.'),
  primary_cta: LinkedinAccountSalesNavCta.nullable().optional()
    .describe('The action LinkedIn suggests for this alert. Present or null; when present, every field inside it may still be null.'),
  lead: LinkedinAccountSalesNavLead.nullable().optional()
    .describe('The lead this alert is about. Present or null; when present, every field inside it may still be null.'),
  account: LinkedinAccountSalesNavAccount.nullable().optional()
    .describe('The company this alert is about, on account-level kinds. Same presence rule as lead.'),
  image_url: z.string().nullable().optional().describe('The card image, largest rendition.'),
}).passthrough();

const LinkedinAccountProfileViewsResult = z.object({
  status: z.string().describe('Plugin dispatch status for this read.'),
  profile_views: z.object({
    elements: z.array(LinkedinAccountProfileViewRow)
      .describe('The viewers on this page, newest first. Empty on a page that rendered with nothing on it, and ALSO empty when the read failed: check status.'),
    paging: SelfFeedPaging('Rows on this page as requested (the wire default is 10). It is what we ASKED for, not what came back.'),
  }),
}).passthrough();

const LinkedinAccountCatchUpResult = z.object({
  status: z.string().describe('Plugin dispatch status for this read.'),
  catch_up: z.object({
    elements: z.array(LinkedinAccountCatchUpCardRow)
      .describe('The nurture cards on this page. Empty on an exhausted feed, and ALSO empty when the read failed: check status.'),
    paging: SelfFeedPaging('Always 10. LinkedIn\'s own request carries no count knob, so the page is server-fixed and this number does not track how many rows actually came back.'),
  }),
}).passthrough();

const LinkedinAccountSalesNavNotificationsResult = z.object({
  status: z.string().describe('Plugin dispatch status for this read.'),
  sales_nav_notifications: z.object({
    elements: z.array(LinkedinAccountSalesNavNotificationRow)
      .describe('The alerts on this page, ordered by LinkedIn relevance rather than by time. Can be SHORTER than page_size while the feed continues, because rows without an id are dropped.'),
    // Kept nested rather than flattened to num_unseen, because that is the
    // shape the research file specifies and the whole block is absent when
    // LinkedIn sent no numeric counter. This is the ONLY one of the three
    // readers that fills metadata at all: the other two must not grow an empty
    // one for symmetry.
    metadata: z.object({
      num_unseen: z.number().int()
        .describe('Unseen alerts across the WHOLE feed, not on this page. NOT a row total, and not a count of anything returned here.'),
    }).nullable().optional()
      .describe('Absent whenever LinkedIn did not send a numeric unseen counter.'),
    paging: SelfFeedPaging('Rows on this page as requested (the wire default is 50). It is what we ASKED for, and elements can be shorter.'),
  }),
}).passthrough();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DANGER = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
// Same posture as DANGER, but idempotentHint is TRUE because the live probe of
// 2026-08-06 proved it rather than assumed it: follow and unfollow were each
// called twice against the same member and the repeat returned the same
// terminal following_state with an empty errors[]. The pair keeps
// destructiveHint (and therefore `dangerous: true`, which the registry ties to
// it) because they are outward writes on a real identity that spend a §9 write
// bucket, exactly like their neighbours visit-profile and endorse-skill. The
// research file's own annotation line guessed destructiveHint: false for
// follow; that predates this convention and the registry would reject it
// alongside dangerous: true, so the file convention wins.
const DANGER_IDEM = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const base = {
  service: 'linkedin',
  entity: 'linkedin_accounts',
  mount: 'linkedin.accounts',
} as const;

// Both closed sets come from the route's own rules(): a 422 on an `in:` rule
// says the value is invalid, never which values are valid, so the tool has to
// carry the list or the agent is guessing.
const LinkedinAccountInclude = z.enum([
  'antidetect_browser',
  'linkedin_account_smart_limits',
  'linkedin_account_snapshot',
  'linkedin_account_quota_hits',
  'linkedin_account_block_log',
  'linkedin_account_block_log_counts',
  'linkedin_connections_counts',
  'linkedin_connection_requests_counts',
  'linkedin_connection_invitations_counts',
  'linkedin_conversations_counts',
  'linkedin_followers_counts',
]);

const LinkedinAccountSortable = z.enum([
  'created_at',
  'updated_at',
  'last_premium_check_at',
  'last_snapshot_at',
  'last_heartbeat_at',
  'last_connections_sync_at',
  'last_conversations_sync_at',
  'last_sales_navigator_conversations_sync_at',
  'last_connection_requests_sync_at',
  'last_connection_invitations_sync_at',
  'initial_sync_completed_at',
  'inmail_credits',
  'full_name',
]);

// ─── the outbound follow edge (matrix rows 96 / 97) ─────────────────────
//
// follow_linkedin_member / unfollow_linkedin_member are the WRITE twins of
// get_linkedin_account_my_following above. They sit on a different route group
// (/api/linkedin-followings/) and a different backend bundle
// (LinkedinFollowingController), and they are filed in THIS package anyway
// because linkedin_accounts.md is the research file that owns the whole follow
// edge: there is no linkedin_followings.md, and research-parity resolves a
// package back to a research file by entity stem, so a linkedin_followings
// package would turn both tools into printed skips instead of checked rows.
//
// linkedin_account_sid travels in the BODY rather than as {sid} in the path
// because the handler mirrors LinkedinFollowerController, which has no /{sid}
// route either. That is why these two do not reuse SID / Target above.
const FOLLOWING_ACCOUNT_SID = z.string().length(18).startsWith('ln_ac_')
  .describe('LinkedIn account sid (ln_ac_…): the account that does the following. Identity-bound and non-creditable, so it is REQUIRED and is never a pool account. Travels in the body; this route group has no /{sid} path.');

// The same at-least-one rule as Target above, restated with the bounds
// LinkedinFollowingFollowRequest states (ln_id 128 / sn_id 64 / nickname 100)
// so an over-long value is refused here instead of costing a browser dispatch.
const FollowTarget = z.object({
  ln_id: z.string().max(128).nullable().optional()
    .describe('LinkedIn member id (ACoAA…). Dispatched straight through as the wire\'s profile_id, so a target carrying one needs no member lookup.'),
  sn_id: z.string().max(64).nullable().optional().describe('Sales Navigator member id.'),
  nickname: z.string().max(100).nullable().optional()
    .describe('Public profile slug, the vanity name in the profile URL. Pass it whenever you know it, INCLUDING alongside ln_id: it rides the wire as public_identifier and saves LinkedIn a member-resolution round trip, cutting the action from three requests to two. A nickname-ONLY target costs an extra profile read before the action instead.'),
}).describe('Target person; provide at least one of ln_id / sn_id / nickname. Best case is a member id plus the nickname.');

// The §4.12a dispatch row. Kept open rather than re-declaring
// LinkedinAccountActivityLogDomain, which its own package owns.
const FOLLOWING_ACTIVITY_LOG = z.object({}).passthrough()
  .describe('Full dispatch row (linkedin-account-activity-log) per §4.12a.');

// following_state is typed as an OPEN string on purpose, in both results. The
// SDK types it `string | null`, so pinning a two-member union here would ship
// narrower than the wire and break the day LinkedIn relabels the button. The
// equality check against the expected terminal state is the backend's success
// predicate, not this type.
const FollowResult = z.object({
  activity_log: FOLLOWING_ACTIVITY_LOG,
  followed: z.boolean()
    .describe('The wire field, mirrored. Always true in a 200, and never the proof on its own: the backend returns 200 only when the terminal following_state confirmed the direction.'),
  following_state: z.string()
    .describe('The follow button state AFTER the action, read off the wire. Always Following in a 200.'),
  message: z.string().nullable().describe('LinkedIn\'s own toast, when it sent one.'),
  is_retryable: z.boolean().describe('LinkedIn\'s own retry hint, passed through untouched.'),
}).passthrough();

const UnfollowResult = z.object({
  activity_log: FOLLOWING_ACTIVITY_LOG,
  unfollowed: z.boolean()
    .describe('The wire field, mirrored. Always true in a 200, and never the proof on its own: the backend returns 200 only when the terminal following_state confirmed the direction.'),
  following_state: z.string()
    .describe('The follow button state AFTER the action, read off the wire. Always Follow in a 200, meaning the button reverted to its pre-follow label.'),
  message: z.string().nullable().describe('LinkedIn\'s own toast, when it sent one.'),
  is_retryable: z.boolean().describe('LinkedIn\'s own retry hint, passed through untouched.'),
}).passthrough();

export const linkedinAccountsTools: ToolDefinition[] = [
  {
    ...base,
    name: 'search_linkedin_accounts',
    description:
      'List LinkedIn accounts on the team with filtering, sorting and cursor pagination. Returns a counts block of predicate tallies. Use this to find an account sid before calling account-scoped tools.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/search' },
    operation: 'search',
    envelope: 'search',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpSearchRequestSchema(LinkedinAccountFilter, LinkedinAccountInclude, LinkedinAccountSortable),
    outputSchema: McpSearchResponse(LinkedinAccount, undefined, LinkedinAccountCounts),
    annotations: { title: 'Search LinkedIn accounts', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account',
    description: 'Fetch a single LinkedIn account by sid, with optional eager-loaded relations.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'GET', pathTemplate: '/api/linkedin-accounts/{sid}', sidParam: 'sid' },
    operation: 'get',
    envelope: 'get',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    inputSchema: McpGetRequestSchema('ln_ac_', LinkedinAccountInclude),
    outputSchema: McpGetResponse(LinkedinAccount),
    annotations: { title: 'Get LinkedIn account', ...RO },
  },
  {
    ...base,
    // ONE tool for the four steps of the §5.7 subscription refresh, merged
    // 2026-08-09. `check_linkedin_account_recruiter_access` and
    // `..._sales_nav_access` were steps 3 and 2 exposed as their own tools over
    // their own backend routes; both routes are DELETED and this `checks` member
    // is what replaces them (product/KNOWLEDGE.md §4.10: one tool per action, the
    // caller picks the scope).
    //
    // 🛑 The path stays STATIC on purpose. The first attempt gave this tool a
    // templated `/check-{capability}` segment, which the registry can express via
    // `route.pathParams` - and six gates (coverage, contract-parity x2,
    // oracle-freshness, enum-parity, research-parity) key a tool by its LITERAL
    // pathTemplate against the oracle's route list, so every one of them went red.
    // Widening six safety gates to fit one tool was the wrong trade; moving the
    // selection into the BODY of one real route is the right one.
    //
    // ⚠️ A narrow `checks` now PERSISTS, which the two deleted tools did not: they
    // ran through `fetchSelf`, returned the raw wire body and wrote nothing.
    // Eugene's call - asking LinkedIn a question and discarding the answer leaves
    // the row stale for no gain.
    name: 'check_linkedin_account_premium_subscription',
    description:
      'Refresh the account\'s subscription state and persist it: Premium, the Sales Navigator and Recruiter seats, and the InMail balance (self-probe, no target, no credits). `checks` picks which of those four to run and omitting it runs all four, which is the call you want when you just need the picture. Ask for a subset when you need one answer cheaply: `recruiter` reads a marker in the already-open tab, while the full run opens a background tab for the profile. Each result is written to the account record, and a probe that fails leaves the previous value alone rather than clearing it, so a failure never reads as "seat lost". On the full run a false Premium settles both seats without probing them, because each includes Premium.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/check-premium', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      checks: z.array(z.enum(['premium', 'sales_nav', 'recruiter', 'inmail_credits'])).min(1).max(4).nullable().optional()
        .describe('Which steps to run. OMIT for all four, which is the normal call. `premium` reads the profile flag and, on a full run, settles both seats when it comes back false. `sales_nav` and `recruiter` probe one seat each and are the cheap ones. `inmail_credits` reads the balance and is never gated on Premium. Asking for a subset skips the rest entirely, so nothing you did not ask for is re-read or re-written.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Check premium subscription', ...RO },
  },
  {
    ...base,
    name: 'check_linkedin_account_target_block',
    description:
      'Check whether a target person can be reached from this account (not blocked / out of network). CREDITABLE: may run an infra-pool probe and debit credits, and the response carries a credits block.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/check-target-block', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      target: Target,
      force: z.boolean().optional().describe('Bypass a cached result and re-probe (may cost credits).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Check target reachability', ...ACT },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_full_profile',
    description: 'Fetch the full self-profile of the connected LinkedIn account.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-full-profile', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Get my full profile', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_lite_profile',
    description: 'Fetch the lite self-profile (name, headline, avatar) of the connected account.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-lite-profile', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Get my lite profile', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_sessions',
    description: 'List the active LinkedIn sessions for the connected account.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-sessions', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Get my sessions', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_credits',
    description: 'Return the InMail / message credit balance for the connected account.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-credits', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Get my credits', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_following',
    description: 'List who the connected account follows, newest-first: the follow-edge twin of get-my-followers (§5.8 latest-*). A null cursor refreshes then returns the head page; a non-null cursor is a read-only continuation over the already-refreshed head (no limit spend). Cursor-paginated.',
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-following', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      page_size: z.number().int().min(1).max(100).optional(),
      cursor: z.string().nullable().optional(),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Get my following', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_ssi',
    description: "Read the connected account's Social Selling Index: the overall score, the four pillars it is the sum of (professional brand, finding the right people, engaging with insights, building relationships), and where the account stands inside its industry and its own network. Answers WITHOUT a Sales Navigator seat, reporting that as active_seat: false with the scores still filled in, so it is a health signal for any account rather than a premium-only read. Non-creditable and identity-bound: the sid names the account whose own dashboard is read; there is no way to read someone else's SSI. Every score is FRACTIONAL (a real reading is 53.496, not 53), so do not round before comparing runs, the week-over-week movement is usually under a point.",
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-ssi', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount, LinkedinAccountSsiResult),
    annotations: { title: 'Get my SSI', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_analytics',
    description: "Read the connected account's creator content analytics over a date window: per metric (impressions, engagements) the daily series, the period total, and the percentage change against the prior period. Omit both dates to get the trailing 28 days, which is what the LinkedIn dashboard itself opens on. Supplying one date without the other is refused rather than half-defaulted, and a window running into the future is refused too (LinkedIn has no data there and would answer with zeroes that read like a collapse in reach). Non-creditable and identity-bound: this is the account's own dashboard, not a competitor read. The metrics map is open: new cards LinkedIn adds show up as extra keys. The 'Discovery' card (in-network vs out-of-network reach) is a separate component and is NOT included.",
    toolClass: 'trivial',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-analytics', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
        .describe('Window start, YYYY-MM-DD. Omit BOTH dates for the trailing 28 days; supplying only one is a 422.'),
      date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
        .describe('Window end, YYYY-MM-DD. Must not precede date_from and must not be in the future.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount, LinkedinAccountAnalyticsResult),
    annotations: { title: 'Get my analytics', ...RO },
  },
  {
    // The three feeds below all answer "what is waiting for this account", and
    // an agent picking between them from tools/list alone will get it wrong
    // unless each description says what the OTHER two are. So each one names
    // its two siblings. They differ on more than content: only the sales-nav
    // one carries a real timestamp, only the catch-up one has no page size, and
    // only the sales-nav one needs a paid seat.
    //
    // All three take ...RO, though the research file's annotation line for each
    // says readOnlyHint: false. That line is the family default it inherited
    // from the self-account VERBS (visit-profile, endorse-skill), and the
    // shipped registry has never followed it for the getters: get-my-ssi,
    // get-my-analytics and get-my-following are all RO despite carrying the
    // same line. These three persist nothing and change nothing on LinkedIn, so
    // the file convention wins, exactly as it does for follow/unfollow below.
    ...base,
    name: 'get_linkedin_account_my_profile_views',
    description:
      "Who viewed this account's profile over the LAST 90 DAYS, newest first: the list behind linkedin.com/me/profile-views. Window and sort are fixed by LinkedIn and there is no filter, so \"who viewed me today\" means reading the top of the feed. Rows carry rendered text only (\"Viewed 1w ago\"), never a parseable date. An ANONYMIZED viewer arrives with is_anonymous true, a descriptor where the name goes, a people-search url instead of a profile, and no member ids, so branch on that flag before opening or keying a row. Served by the Premium viewer screen, so what a non-premium account gets back is unverified. Cursor-paginated, no total: pass paging.next_page_cursor back as `cursor` until it is absent. A short page is usually the end but can also be one card we could not read, so do not call the list complete. NOT the catch-up prompts (get_linkedin_account_my_catch_up) and NOT Sales Navigator alerts (get_linkedin_account_my_sales_nav_notifications).",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-profile-views', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      page_size: z.number().int().min(1).max(100).optional()
        .describe('Rows per page, 1..100. Prefer omitting it: 10 is the wire default and the only page size with capture evidence behind it, and if LinkedIn caps the page server side a bigger ask returns a short page that stops the loop after one call.'),
      cursor: z.string().nullable().optional()
        .describe('Pass paging.next_page_cursor back verbatim. Omitted or null starts at the top of the feed.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount, LinkedinAccountProfileViewsResult),
    annotations: { title: 'Get my profile views', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_catch_up',
    description:
      "The nurture cards on this account's My Network catch-up tab (linkedin.com/mynetwork/catch-up/all): birthdays, job changes and work anniversaries among its connections, each with the one-click message LinkedIn printed on the card's button. The \"who is worth congratulating today\" feed. READ ONLY: it lists prompts and sends nothing. message_sent means this account already answered that card, and null means LinkedIn said nothing, not no. NO page_size, deliberately: LinkedIn's own request carries no count knob, so the page is server-fixed at 10. Page with `cursor` instead, passing paging.next_page_cursor back until it is absent; an empty page is the end. Key a card by card_urn, which identifies the PROMPT rather than the person, since `position` is our own count and shifts whenever a card fails to parse. NOT profile views (get_linkedin_account_my_profile_views) and NOT Sales Navigator alerts (get_linkedin_account_my_sales_nav_notifications).",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-catch-up', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      // No page_size here on purpose. See the description: the wire has no
      // count field, so offering one would be inert and misleading.
      cursor: z.string().nullable().optional()
        .describe('Pass paging.next_page_cursor back verbatim. Omitted or null starts at the top of the feed.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount, LinkedinAccountCatchUpResult),
    annotations: { title: 'Get my catch-up cards', ...RO },
  },
  {
    ...base,
    name: 'get_linkedin_account_my_sales_nav_notifications',
    description:
      "This account's Sales Navigator alert feed, the bell on linkedin.com/sales/home: saved leads and accounts posting, changing job, accepting an invitation, or turning up in a profile-view signal. NEEDS A SALES NAVIGATOR SEAT on the account; without one we refuse up front rather than spend a run on a likely refusal. Ordered by LinkedIn's own RELEVANCE score, NOT reverse-chronological, so sort by published_at yourself before calling anything new. That field is epoch milliseconds and is the only machine-readable timestamp across the three self feeds. metadata.num_unseen counts unseen alerts feed-wide, not on this page, and is not a row total. Cursor-paginated, no total: pass paging.next_page_cursor back as `cursor` until it is absent. Alerts sent without an id are dropped, so a page can be shorter than page_size while the feed continues; never read a short page as the end here. NOT profile views (get_linkedin_account_my_profile_views) and NOT the catch-up prompts (get_linkedin_account_my_catch_up).",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/get-my-sales-nav-notifications', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      page_size: z.number().int().min(1).max(100).optional()
        .describe('Rows per page, 1..100 (the wire default is 50, which is what the Sales Navigator web client itself pages with).'),
      cursor: z.string().nullable().optional()
        .describe('Pass paging.next_page_cursor back verbatim. Omitted or null starts at the top of the feed.'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount, LinkedinAccountSalesNavNotificationsResult),
    annotations: { title: 'Get my Sales Navigator alerts', ...RO },
  },
  {
    ...base,
    name: 'edit_linkedin_account_my_profile',
    description: "Edit the connected account's OWN LinkedIn profile intro card: name, headline, additional name, industry, location, the current position/education pins and their visibility, website, and pronouns. Send only what changes; the backend reads the current card first and submits the complete form, because the LinkedIn form is a REPLACE and anything omitted would be blanked. The About section is NOT editable here (LinkedIn uses a separate form), so passing summary is rejected rather than ignored. Industry, city, position and education take LinkedIn's own numeric ids, which this API does not resolve: omit them and their current values are kept. Spends the tight edit_profile budget (10/day, 600 s apart), because rapid profile churn is a bot signal. LinkedIn returns no confirmation of what it saved, so updated_fields reflects what was ASKED for; read the profile back to confirm.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'PATCH', pathTemplate: '/api/linkedin-accounts/{sid}/my-profile', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      first_name: z.string().min(1).max(100).optional(),
      last_name: z.string().min(1).max(100).optional(),
      headline: z.string().min(1).max(220).optional().describe("LinkedIn's own cap is 220 characters."),
      additional_name: z.string().max(100).optional(),
      industry_id: z.string().regex(/^\d+$/).optional().describe("LinkedIn industry id, e.g. '96'."),
      location_geo_id: z.number().int().min(1).optional(),
      sub_location_geo_id: z.number().int().min(1).optional(),
      city_geo_id: z.string().regex(/^\d+$/).optional(),
      location: z.string().max(200).optional().describe('Display text for the location, e.g. Buenos Aires.'),
      postal_code: z.string().max(20).optional(),
      current_position_id: z.string().regex(/^\d+$/).optional(),
      current_education_id: z.string().regex(/^\d+$/).optional(),
      show_current_position: z.boolean().optional(),
      show_education: z.boolean().optional(),
      website: z.string().max(2048).optional(),
      website_label: z.string().max(100).optional(),
      custom_pronouns: z.string().max(50).optional(),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount, z.object({
      activity_log: z.object({}).passthrough().describe('The dispatch row (linkedin-account-activity-log), action_type edit_my_profile.'),
      updated_fields: z.array(z.string())
        .describe('The fields the caller asked to change. NOT a confirmation: LinkedIn answers with a bare ok and does not echo the saved profile.'),
    }).passthrough()),
    annotations: { title: 'Edit my profile', ...DANGER },
  },
  {
    ...base,
    name: 'endorse_linkedin_account_skill',
    description:
      'Endorse a target person\'s skills from this account (warm-up / engagement action). Outward action on LinkedIn.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/endorse-skill', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      target: Target,
      skills_count: z.number().int().min(1).max(10).optional().describe('How many skills to endorse (1..10, default 1).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Endorse skills', ...DANGER },
  },
  {
    ...base,
    name: 'visit_linkedin_account_profile',
    description: 'Visit a target person\'s profile from this account (warm-up / signal action). Outward action on LinkedIn.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/visit-profile', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({ sid: SID, target: Target, ...usageMetaField }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Visit profile', ...DANGER },
  },
  {
    ...base,
    name: 'follow_linkedin_member',
    description:
      "Follow a LinkedIn member as this account, so their posts reach its feed. One-way and needs no relationship: you can follow anyone whose profile allows it, connected or not, which makes it a common warmup step before a connection request. IDEMPOTENT: following someone this account already follows returns 200 with the same terminal state, so a repeat is a success, not an error. The wire cannot tell a fresh follow from a repeat, so read get_linkedin_account_my_following first if you need that answer; either way the call spends one networking_general unit (40 a day, 180 s apart). Pass target.nickname whenever you know it, even alongside ln_id: it saves LinkedIn a member lookup and cuts the action from three wire requests to two. Identity-bound and non-creditable: linkedin_account_sid REQUIRED, no pool fallback, 429 on saturation. Writes nothing locally; the follow list catches up on the next get_linkedin_account_my_following refresh.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-followings/follow' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: FOLLOWING_ACCOUNT_SID,
      target: FollowTarget,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount, FollowResult),
    annotations: { title: 'Follow LinkedIn member', ...DANGER_IDEM },
  },
  {
    ...base,
    name: 'unfollow_linkedin_member',
    description:
      "Stop following a LinkedIn member as this account, the inverse of follow_linkedin_member. NOT a disconnect: it leaves a 1st-degree connection intact and only stops that member's posts reaching the feed, so it is how you mute someone you still want to stay connected to. Severing the relationship is remove_linkedin_connection. IDEMPOTENT: unfollowing someone this account does not follow returns 200 with the same terminal state, so a repeat is a success, not an error, and it still spends one networking_general unit (40 a day, 180 s apart). Pass target.nickname whenever you know it, even alongside ln_id: it saves LinkedIn a member lookup and cuts the action from three wire requests to two. Identity-bound and non-creditable: linkedin_account_sid REQUIRED, no pool fallback, 429 on saturation. Deletes nothing locally; the follow list catches up on the next get_linkedin_account_my_following refresh.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-followings/unfollow' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      linkedin_account_sid: FOLLOWING_ACCOUNT_SID,
      target: FollowTarget,
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount, UnfollowResult),
    annotations: { title: 'Unfollow LinkedIn member', ...DANGER_IDEM },
  },
  {
    ...base,
    name: 'reset_linkedin_account_sync',
    description:
      'Reset one or more sync tracks for the account and re-run them from scratch. ASYNC: returns pending refs to poll; DESTRUCTIVE: discards sync cursors.',
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/reset-sync', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action_async',
    availability: 'ga',
    dangerous: true,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      types: z.array(z.enum([
        'connections',
        'connection_requests',
        'connection_invitations',
        'conversations',
        'sales_navigator_conversations',
      ])).min(1).describe('Sync tracks to reset (LinkedinAccountResetSyncTypeEnum values).'),
      ...usageMetaField,
    }),
    outputSchema: McpAsyncActionResponse(LinkedinAccount),
    annotations: { title: 'Reset account sync', ...DANGER },
  },
  {
    ...base,
    name: 'update_linkedin_account_sync_config',
    description:
      "Set the account's weekly sync schedule: the timezone, the allowed per-weekday time windows, and per-track cadence entries. Replaces the stored sync_config wholesale (send the full desired config, not a delta). Returns the updated account. SINGLE account: to reschedule a fleet, author a mass action on /mcp/orchestration/mass-actions with the step `linkedin-accounts.update-sync-config` (scope objects) so the whole change rides ONE approval.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'POST', pathTemplate: '/api/linkedin-accounts/{sid}/update-sync-config', sidParam: 'sid' },
    operation: 'action',
    envelope: 'action',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    stepEligible: true,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      sync_config: z.object({
        timezone: z.string().describe('IANA timezone (e.g. Europe/Amsterdam) the windows/entries are evaluated in.'),
        window: z.array(z.object({
          day_of_week: z.number().int().min(1).max(7).describe('ISO weekday: 1=Mon … 7=Sun.'),
          start_minute: z.number().int().min(0).max(1439).describe('Window start, minutes from local midnight (0..1439).'),
          end_minute: z.number().int().min(1).max(1440).describe('Window end, minutes from local midnight (1..1440); must be after start_minute.'),
        })).optional().describe('Allowed sync hours per weekday; omit to sync around the clock.'),
        entries: z.object({
          connections: z.object({ interval_minutes: z.number().int().min(5) }),
          conversations: z.object({ interval_minutes: z.number().int().min(5) }),
          sales_navigator_conversations: z.object({ interval_minutes: z.number().int().min(5) }),
          connection_requests: z.object({ interval_minutes: z.number().int().min(5) }),
          connection_invitations: z.object({ interval_minutes: z.number().int().min(5) }),
          premium_check: z.object({ interval_minutes: z.number().int().min(5) }),
          snapshot_check: z.object({ interval_minutes: z.number().int().min(5) }),
        }).partial().optional().describe('Per-track cadence overrides (minutes, ≥5), keyed by sync track.'),
      }).describe('Weekly sync schedule for the account (replaces the stored config wholesale).'),
      ...usageMetaField,
    }),
    outputSchema: McpActionResponse(LinkedinAccount),
    annotations: { title: 'Update account sync config', ...ACT },
  },
  {
    ...base,
    name: 'update_linkedin_account',
    description:
      "Set the account's operator display fields: display_name and label. These are team-authored (never synced from LinkedIn) and are the only editable fields on the account row - sync cadence has its own tool (update_linkedin_account_sync_config), premium flags have their checks, and lifecycle is driven by the browser. Send only the fields to change; an explicit null clears a field. Returns the updated account. To edit these across many accounts at once, author a mass action with the linkedin-accounts.update step instead.",
    toolClass: 'typical',
    route: { service: 'linkedin', method: 'PATCH', pathTemplate: '/api/linkedin-accounts/{sid}', sidParam: 'sid' },
    operation: 'update',
    envelope: 'update',
    availability: 'ga',
    dangerous: false,
    creditable: false,
    massAction: false,
    scheduleRequired: false,
    inputSchema: z.object({
      sid: SID,
      display_name: z.string().max(255).nullable().optional().describe('Team-facing display name for the account; null clears it.'),
      label: z.string().max(255).nullable().optional().describe('Free-form label/tag for the account (e.g. a pod or campaign name); null clears it.'),
      ...usageMetaField,
    }),
    outputSchema: McpUpdateResponse(LinkedinAccount),
    annotations: { title: 'Update account display fields', ...ACT },
  },
];
