CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 993 NOT NULL,
	`secure` integer DEFAULT true NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_sync_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `data_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wrapped_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`path` text NOT NULL,
	`delimiter` text,
	`special_use` text,
	`uid_validity` integer,
	`last_synced_uid` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_account_path_idx` ON `mailboxes` (`account_id`,`path`);--> statement-breakpoint
CREATE TABLE `message_sources` (
	`message_id` integer PRIMARY KEY NOT NULL,
	`source` blob NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mailbox_id` integer NOT NULL,
	`uid` integer NOT NULL,
	`uid_validity` integer NOT NULL,
	`data_key_id` integer NOT NULL,
	`envelope` blob NOT NULL,
	`search_doc` blob NOT NULL,
	`received_at` integer,
	`flags` text DEFAULT '[]' NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`data_key_id`) REFERENCES `data_keys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_mailbox_uid_idx` ON `messages` (`mailbox_id`,`uid_validity`,`uid`);--> statement-breakpoint
CREATE INDEX `messages_mailbox_received_idx` ON `messages` (`mailbox_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `search_index` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`data` blob NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "search_index_single_row" CHECK("search_index"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`messages_fetched` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_runs_account_started_idx` ON `sync_runs` (`account_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `vault` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`public_key` text NOT NULL,
	`encrypted_private_key` text NOT NULL,
	`wrapped_user_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "vault_single_row" CHECK("vault"."id" = 1)
);
