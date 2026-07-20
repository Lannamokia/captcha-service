ALTER TABLE "WidgetSession"
  ADD COLUMN "machine_fingerprint" TEXT,
  ADD COLUMN "fingerprint_version" INTEGER,
  ADD COLUMN "fingerprint_capabilities" INTEGER,
  ADD COLUMN "wasm_score" INTEGER,
  ADD COLUMN "wasm_integrity_verified" BOOLEAN,
  ADD COLUMN "integrity_challenge" TEXT;

CREATE INDEX "WidgetSession_site_id_machine_fingerprint_created_at_idx"
  ON "WidgetSession"("site_id", "machine_fingerprint", "created_at");
