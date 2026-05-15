/** Debounce before hitting `/people` and `/companies` `q=` from table search boxes. */
export const TABLE_SEARCH_DEBOUNCE_MS = 320

export type PeopleTableFetchParams = {
  q?: string
  lifecycle?: string
  companyId?: string
  companyScope?: 'assigned' | 'unassigned'
  hasEmail?: 'true' | 'false'
  hasLinkedin?: 'true' | 'false'
}

export type CompaniesTableFetchParams = {
  q?: string
  outreachStatus?: 'dormant' | 'working' | 'paused' | 'completed' | 'dead'
  mailboxId?: string
  mailboxScope?: 'assigned' | 'unassigned'
  hasPeople?: 'true' | 'false'
  pendingDrafts?: 'true' | 'false'
}
