DROP TABLE IF EXISTS "outreach_email_style_rules";
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "outreach_email_instructions" text;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "outreach_email_instructions" text;
