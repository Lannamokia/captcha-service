CREATE TABLE "Admin" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Admin_username_key" ON "Admin"("username");

CREATE TABLE "Site" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "encrypted_secret" TEXT NOT NULL,
  "allowed_origins" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Site_active_idx" ON "Site"("active");

CREATE TABLE "WidgetSession" (
  "id" TEXT NOT NULL,
  "site_id" TEXT NOT NULL,
  "token_digest" TEXT NOT NULL,
  "parent_origin" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "username_digest" TEXT NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "level" TEXT NOT NULL,
  "credential_failure" BOOLEAN NOT NULL DEFAULT false,
  "theme" TEXT NOT NULL DEFAULT 'light',
  "brand_color" TEXT NOT NULL DEFAULT '#2563eb',
  "risk_score" INTEGER,
  "challenge_type" TEXT,
  "challenge_answer_digest" TEXT,
  "slider_target" INTEGER,
  "challenge_digest" TEXT,
  "completion_digest" TEXT,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "redeemed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WidgetSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WidgetSession_token_digest_key" ON "WidgetSession"("token_digest");
CREATE UNIQUE INDEX "WidgetSession_completion_digest_key" ON "WidgetSession"("completion_digest");
CREATE INDEX "WidgetSession_site_id_created_at_idx" ON "WidgetSession"("site_id", "created_at");
CREATE INDEX "WidgetSession_state_expires_at_idx" ON "WidgetSession"("state", "expires_at");

CREATE TABLE "ChallengeAsset" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChallengeAsset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ChallengeAsset_kind_active_idx" ON "ChallengeAsset"("kind", "active");

CREATE TABLE "SecurityEvent" (
  "id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "site_id" TEXT,
  "session_id" TEXT,
  "metadata" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SecurityEvent_action_created_at_idx" ON "SecurityEvent"("action", "created_at");
CREATE INDEX "SecurityEvent_site_id_idx" ON "SecurityEvent"("site_id");

ALTER TABLE "WidgetSession" ADD CONSTRAINT "WidgetSession_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
