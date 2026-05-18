ALTER TABLE "outreach_drafts" ADD COLUMN "gmail_rfc_message_id" text;
--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD COLUMN "reply_to_draft_id" uuid;
--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_reply_to_draft_id_outreach_drafts_id_fk" FOREIGN KEY ("reply_to_draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE set null ON UPDATE no action;
