CREATE TABLE "outreach_email_style_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"mailbox_id" uuid,
	"rule" text NOT NULL,
	"source_draft_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_email_style_rules_scope_chk" CHECK (
		("company_id" IS NOT NULL AND "mailbox_id" IS NULL)
		OR ("mailbox_id" IS NOT NULL AND "company_id" IS NULL)
	)
);
--> statement-breakpoint
ALTER TABLE "outreach_email_style_rules" ADD CONSTRAINT "outreach_email_style_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_email_style_rules" ADD CONSTRAINT "outreach_email_style_rules_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_email_style_rules" ADD CONSTRAINT "outreach_email_style_rules_source_draft_id_outreach_drafts_id_fk" FOREIGN KEY ("source_draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_email_style_rules_company_idx" ON "outreach_email_style_rules" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "outreach_email_style_rules_mailbox_idx" ON "outreach_email_style_rules" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "outreach_email_style_rules_created_idx" ON "outreach_email_style_rules" USING btree ("created_at");
