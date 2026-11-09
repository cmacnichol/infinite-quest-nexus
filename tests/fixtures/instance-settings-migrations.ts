/** Ordered migrations expected when upgrading an existing installation across the Settings release. */
export const settingsReleaseMigrations = [
  "0121_instance_settings",
  "0122_instance_settings_changed_keys",
  "0123_archive_policy_snapshots",
  "0124_admission_policy_history",
  "0125_http_admission_leases",
  "0126_local_settings_actor",
  "0127_local_settings_restart",
  "0128_cancelled_dispatch_recoveries",
  "0129_character_settings_keys",
  "0130_campaign_first_appearance_eligibility",
  "0131_selected_character_world"
] as const;
