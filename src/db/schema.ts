import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core'

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    emailDomain: text('email_domain').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => appUsers.id, {
      onDelete: 'set null'
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('organizations_slug_unique').on(t.slug),
    uniqueIndex('organizations_email_domain_lower_unique').on(sql`lower(${t.emailDomain})`),
    index('organizations_created_by_idx').on(t.createdByUserId)
  ]
)

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    domain: text('domain'),
    website: text('website'),
    industry: text('industry'),
    employeeRange: text('employee_range'),
    hqLocation: text('hq_location'),
    notes: text('notes'),
    enrichmentPayload: jsonb('enrichment_payload').$type<Record<string, unknown>>(),
    outreachStatus: text('outreach_status').notNull().default('dormant'),
    outreachMailboxId: uuid('outreach_mailbox_id'),
    outreachStrategy: text('outreach_strategy'),
    /** Operator standing instructions for cold email copy (merged into agent prompt for this account). */
    outreachEmailInstructions: text('outreach_email_instructions'),
    outreachNextWakeAt: timestamp('outreach_next_wake_at', { withTimezone: true }),
    outreachStartedAt: timestamp('outreach_started_at', { withTimezone: true }),
    outreachLastWorkedAt: timestamp('outreach_last_worked_at', { withTimezone: true }),
    outreachCompletedAt: timestamp('outreach_completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('companies_domain_lower_unique')
      .on(t.organizationId, sql`lower(trim(${t.domain}))`)
      .where(sql`${t.domain} is not null`),
    index('companies_organization_idx').on(t.organizationId),
    index('companies_name_idx').on(t.name),
    index('companies_outreach_status_idx').on(t.outreachStatus),
    index('companies_outreach_wake_idx').on(t.outreachNextWakeAt)
  ]
)

export const mailboxes = pgTable(
  'mailboxes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name'),
    signature: text('signature'),
    senderBio: text('sender_bio'),
    /** Operator standing instructions for cold email copy for every account using this mailbox. */
    outreachEmailInstructions: text('outreach_email_instructions'),
    oauthRefreshToken: text('oauth_refresh_token'),
    oauthAccessToken: text('oauth_access_token'),
    oauthExpiresAt: timestamp('oauth_expires_at', { withTimezone: true }),
    scopes: text('scopes'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('mailboxes_email_lower_unique').on(t.organizationId, sql`lower(${t.email})`),
    index('mailboxes_organization_idx').on(t.organizationId),
    index('mailboxes_status_idx').on(t.status)
  ]
)

export const outreachEvents = pgTable(
  'outreach_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>(),
    sourceUrl: text('source_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index('outreach_events_organization_idx').on(t.organizationId),
    index('outreach_events_company_idx').on(t.companyId),
    index('outreach_events_created_idx').on(t.createdAt)
  ]
)

export const outreachDrafts = pgTable(
  'outreach_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    mailboxId: uuid('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'restrict' }),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    bodyHtml: text('body_html'),
    status: text('status').notNull().default('pending_review'),
    reviewNotes: text('review_notes'),
    agentRationale: text('agent_rationale'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    gmailMessageId: text('gmail_message_id'),
    gmailThreadId: text('gmail_thread_id'),
    gmailRfcMessageId: text('gmail_rfc_message_id'),
    replyToDraftId: uuid('reply_to_draft_id'),
    sendError: text('send_error'),
    /** Opaque token embedded in the open-tracking pixel URL for this send. */
    trackingToken: text('tracking_token'),
    openCount: integer('open_count').notNull().default(0),
    firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
    threadSyncedAt: timestamp('thread_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index('outreach_drafts_organization_idx').on(t.organizationId),
    index('outreach_drafts_company_idx').on(t.companyId),
    index('outreach_drafts_mailbox_idx').on(t.mailboxId),
    index('outreach_drafts_status_idx').on(t.status),
    index('outreach_drafts_created_idx').on(t.createdAt),
    uniqueIndex('outreach_drafts_tracking_token_unique')
      .on(t.trackingToken)
      .where(sql`${t.trackingToken} is not null`)
  ]
)

export const outreachEmailOpens = pgTable(
  'outreach_email_opens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => outreachDrafts.id, { onDelete: 'cascade' }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ipHash: text('ip_hash')
  },
  (t) => [
    index('outreach_email_opens_draft_idx').on(t.draftId),
    index('outreach_email_opens_opened_idx').on(t.openedAt)
  ]
)

export const outreachThreadMessages = pgTable(
  'outreach_thread_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => outreachDrafts.id, { onDelete: 'cascade' }),
    gmailMessageId: text('gmail_message_id').notNull(),
    kind: text('kind').notNull(),
    fromEmail: text('from_email'),
    toEmail: text('to_email'),
    subject: text('subject'),
    bodyText: text('body_text'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('outreach_thread_messages_gmail_message_unique').on(t.gmailMessageId),
    index('outreach_thread_messages_draft_idx').on(t.draftId),
    index('outreach_thread_messages_company_idx').on(t.companyId),
    index('outreach_thread_messages_received_idx').on(t.receivedAt)
  ]
)

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icpDocument: text('icp_document').notNull(),
    targetCount: integer('target_count').notNull(),
    status: text('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index('campaigns_organization_idx').on(t.organizationId)]
)

export const people = pgTable(
  'people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    fullName: text('full_name'),
    nameNormalized: text('name_normalized'),
    email: text('email'),
    phone: text('phone'),
    linkedinUrl: text('linkedin_url'),
    twitterUrl: text('twitter_url'),
    title: text('title'),
    seniority: text('seniority'),
    department: text('department'),
    notes: text('notes'),
    context: text('context'),
    icpKeywords: jsonb('icp_keywords').$type<string[]>(),
    enrichmentLastAttemptAt: timestamp('enrichment_last_attempt_at', { withTimezone: true }),
    enrichmentSources: jsonb('enrichment_sources').$type<Record<string, unknown>>(),
    lifecycleStatus: text('lifecycle_status').notNull().default('new'),
    firstSeenCampaignId: uuid('first_seen_campaign_id').references(() => campaigns.id, {
      onDelete: 'set null'
    }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('people_email_lower_unique')
      .on(t.organizationId, sql`lower(trim(${t.email}))`)
      .where(sql`${t.email} is not null`),
    uniqueIndex('people_linkedin_url_unique')
      .on(t.organizationId, t.linkedinUrl)
      .where(sql`${t.linkedinUrl} is not null`),
    index('people_organization_idx').on(t.organizationId),
    index('people_company_idx').on(t.companyId),
    index('people_lifecycle_idx').on(t.lifecycleStatus),
    index('people_first_campaign_idx').on(t.firstSeenCampaignId)
  ]
)

export const prospectLists = pgTable(
  'prospect_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index('prospect_lists_organization_idx').on(t.organizationId),
    index('prospect_lists_type_idx').on(t.type),
    index('prospect_lists_created_idx').on(t.createdAt)
  ]
)

export const prospectListPeople = pgTable(
  'prospect_list_people',
  {
    listId: uuid('list_id')
      .notNull()
      .references(() => prospectLists.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('prospect_list_people_unique').on(t.listId, t.personId),
    index('prospect_list_people_list_idx').on(t.listId),
    index('prospect_list_people_person_idx').on(t.personId)
  ]
)

export const prospectListCompanies = pgTable(
  'prospect_list_companies',
  {
    listId: uuid('list_id')
      .notNull()
      .references(() => prospectLists.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('prospect_list_companies_unique').on(t.listId, t.companyId),
    index('prospect_list_companies_list_idx').on(t.listId),
    index('prospect_list_companies_company_idx').on(t.companyId)
  ]
)

export const campaignRuns = pgTable(
  'campaign_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    qualifiedCount: integer('qualified_count').notNull().default(0),
    checkpoint: jsonb('checkpoint').notNull().default({}).$type<Record<string, unknown>>(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index('campaign_runs_organization_idx').on(t.organizationId),
    index('campaign_runs_campaign_idx').on(t.campaignId),
    index('campaign_runs_status_idx').on(t.status)
  ]
)

export const discoveryEvents = pgTable(
  'discovery_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
    sourceType: text('source_type').notNull(),
    sourceQuery: text('source_query'),
    sourceUrl: text('source_url'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index('discovery_events_organization_idx').on(t.organizationId),
    index('discovery_events_campaign_idx').on(t.campaignId),
    index('discovery_events_person_idx').on(t.personId)
  ]
)

export const appUsers = pgTable(
  'app_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true })
  },
  (t) => [index('app_users_created_idx').on(t.createdAt)]
)

export const emailLoginChallenges = pgTable(
  'email_login_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index('email_login_challenges_email_idx').on(t.email),
    index('email_login_challenges_expires_idx').on(t.expiresAt)
  ]
)

export const appSessions = pgTable(
  'app_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    activeOrganizationId: uuid('active_organization_id').references(() => organizations.id, {
      onDelete: 'set null'
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index('app_sessions_user_idx').on(t.userId),
    index('app_sessions_active_org_idx').on(t.activeOrganizationId),
    index('app_sessions_expires_idx').on(t.expiresAt)
  ]
)

export const organizationMemberships = pgTable(
  'organization_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    uniqueIndex('organization_memberships_org_user_unique').on(t.organizationId, t.userId),
    index('organization_memberships_user_idx').on(t.userId),
    index('organization_memberships_org_idx').on(t.organizationId)
  ]
)

export const organizationInvites = pgTable(
  'organization_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull().default('member'),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => appUsers.id, {
      onDelete: 'set null'
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index('organization_invites_org_idx').on(t.organizationId),
    index('organization_invites_email_idx').on(t.email),
    index('organization_invites_expires_idx').on(t.expiresAt)
  ]
)

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    operation: text('operation').notNull(),
    model: text('model'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    units: integer('units'),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }),
    estimated: boolean('estimated').notNull().default(false),
    campaignId: uuid('campaign_id').references(() => campaigns.id, {
      onDelete: 'set null'
    }),
    campaignRunId: uuid('campaign_run_id').references(() => campaignRuns.id, {
      onDelete: 'set null'
    }),
    companyId: uuid('company_id').references(() => companies.id, {
      onDelete: 'set null'
    }),
    personId: uuid('person_id').references(() => people.id, { onDelete: 'set null' }),
    slotIndex: integer('slot_index'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index('usage_events_organization_idx').on(t.organizationId),
    index('usage_events_campaign_idx').on(t.campaignId),
    index('usage_events_run_idx').on(t.campaignRunId),
    index('usage_events_company_idx').on(t.companyId),
    index('usage_events_person_idx').on(t.personId),
    index('usage_events_provider_idx').on(t.provider),
    index('usage_events_created_idx').on(t.createdAt)
  ]
)

export type Company = typeof companies.$inferSelect
export type Person = typeof people.$inferSelect
export type Campaign = typeof campaigns.$inferSelect
export type CampaignRun = typeof campaignRuns.$inferSelect
export type DiscoveryEvent = typeof discoveryEvents.$inferSelect
export type ProspectList = typeof prospectLists.$inferSelect
export type UsageEvent = typeof usageEvents.$inferSelect
export type Mailbox = typeof mailboxes.$inferSelect
export type OutreachEvent = typeof outreachEvents.$inferSelect
export type OutreachDraft = typeof outreachDrafts.$inferSelect
export type OutreachThreadMessage = typeof outreachThreadMessages.$inferSelect
export type AppUser = typeof appUsers.$inferSelect
export type AppSession = typeof appSessions.$inferSelect
export type Organization = typeof organizations.$inferSelect
export type OrganizationMembership = typeof organizationMemberships.$inferSelect
export type OrganizationInvite = typeof organizationInvites.$inferSelect
