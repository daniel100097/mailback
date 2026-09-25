ALTER TABLE `mailboxes` ADD `remote_deleted_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `remote_deleted_at` integer;