-- 2026-09-28_named_actions.sql
--
-- RUN THIS BEFORE `drizzle-kit push` ON ANY ENVIRONMENT THAT PREDATES IT.
--
-- Like 2026-09-26_access_axis_rename.sql, this one is live and load-bearing.
-- It performs a VALUE rename inside a column plus an enum→text conversion, and
-- `push` can express neither: it sees an enum column where the schema now says
-- text and reconciles by dropping and recreating, taking every stored
-- permission cell with it. On a populated database that shows up as a
-- `Found data-loss statements` banner — and DEPLOYMENT.md's stop rule for the
-- upgrade is that ANY such banner means abort. Run this first; `push` then
-- reports "No changes detected".
--
-- ── What changed, and why ────────────────────────────────────────────────────
-- Actions used to be thirteen GLOBAL verbs shared by every functionality, so a
-- permission was a noun and a verb that happened to sit next to each other.
-- That produced cells which cannot mean anything — `DASHBOARD.create`,
-- `FOOD_CONFIRM_DELIVERY.delete` — and left the words on screen ("Update") too
-- weak to say what a tick actually allowed.
--
-- Each functionality now NAMES its own actions, GCP-style:
--
--     operations.properties.add_property      "Add property"
--     audits.audit_execution.record_answers   "Record answers"
--
-- The manifest in apps/api-server/src/lib/permissions.ts is the source of
-- truth. A stored action it does not name is INERT — decide() refuses it — so
-- an unmigrated row does not grant anything; it simply stops working, silently.
-- Hence this file.
--
-- ── Safety ───────────────────────────────────────────────────────────────────
-- Idempotent: re-running changes nothing. The rename matches on the OLD verbs,
-- which no longer exist after the first pass, and every DDL step is guarded.
--
-- The cleanup at step 4 deletes ONLY rows still holding one of the thirteen
-- legacy verbs after the rename — cells the new model has no name for, such as
-- "create a dashboard". It deliberately does NOT delete anything it merely
-- fails to recognise, so an action added to the manifest after this file was
-- written is left alone rather than swept away by a stale mapping.
--
-- Verified against the reference database: 330 rows in, 316 out, 14 removed,
-- and all six distinct dropped pairs were gated by zero endpoints.

BEGIN;

-- 1. `action` stops being an enum, for the same reason `functionality` never
--    was: a functionality that names a new action must not require a migration.
ALTER TABLE role_functionalities ALTER COLUMN action TYPE text;
ALTER TABLE privileges           ALTER COLUMN action TYPE text;

-- 2. The mapping, straight from the manifest.
CREATE TEMP TABLE action_rename(functionality text, legacy text, named text) ON COMMIT DROP;
INSERT INTO action_rename VALUES
  ('ACCESS_CONTROL','view','view_access'),
  ('ACCESS_CONTROL','create','grant_access'),
  ('ACCESS_CONTROL','edit','change_access'),
  ('ACCESS_CONTROL','delete','revoke_access'),
  ('ACCESS_CONTROL','configure','administer_access'),
  ('AUDIT_ADMIN','view','view_audit_admin'),
  ('AUDIT_ADMIN','create','add_audit_admin'),
  ('AUDIT_ADMIN','edit','edit_audit_admin'),
  ('AUDIT_ADMIN','delete','delete_audit_admin'),
  ('AUDIT_ADMIN','configure','configure_audit_admin'),
  ('AUDIT_DASHBOARD','view','view_audit_dashboard'),
  ('AUDIT_DASHBOARD','export','export_audit_dashboard'),
  ('AUDIT_EXECUTION','view','view_audit'),
  ('AUDIT_EXECUTION','create','start_audit'),
  ('AUDIT_EXECUTION','edit','record_answers'),
  ('AUDIT_EXECUTION','delete','discard_audit'),
  ('AUDIT_EXECUTION','submit','submit_audit'),
  ('AUDIT_EXECUTION','complete','close_audit'),
  ('AUDIT_EXECUTION','assign','reassign_audit'),
  ('AUDIT_LOG','view','view_activity'),
  ('AUDIT_LOG','export','export_activity'),
  ('AUDIT_REGISTER','view','view_audit_register'),
  ('AUDIT_REGISTER','create','add_audit_register'),
  ('AUDIT_REGISTER','edit','edit_audit_register'),
  ('AUDIT_REGISTER','delete','delete_audit_register'),
  ('AUDIT_REPORTS','view','view_audit_report'),
  ('AUDIT_REPORTS','create','add_audit_report'),
  ('AUDIT_REPORTS','edit','edit_audit_report'),
  ('AUDIT_REPORTS','delete','delete_audit_report'),
  ('AUDIT_REPORTS','export','export_audit_report'),
  ('AUDIT_REPORTS','download','download_audit_report'),
  ('AUDIT_REPORTS','configure','configure_audit_report'),
  ('AUDIT_REVIEW','view','view_review_queue'),
  ('AUDIT_REVIEW','edit','annotate_review'),
  ('AUDIT_REVIEW','approve','approve_audit'),
  ('AUDIT_REVIEW','reject','reject_audit'),
  ('AUDIT_REVIEW','verify','verify_evidence'),
  ('AUDIT_SCHEDULES','view','view_schedule'),
  ('AUDIT_SCHEDULES','create','add_schedule'),
  ('AUDIT_SCHEDULES','edit','edit_schedule'),
  ('AUDIT_SCHEDULES','delete','delete_schedule'),
  ('AUDIT_SCHEDULES','assign','assign_schedule'),
  ('AUDIT_SCHEDULES','configure','configure_schedule'),
  ('AUDIT_TEMPLATES','view','view_template'),
  ('AUDIT_TEMPLATES','create','add_template'),
  ('AUDIT_TEMPLATES','edit','edit_template'),
  ('AUDIT_TEMPLATES','delete','delete_template'),
  ('AUDIT_TEMPLATES','configure','configure_template'),
  ('BANKING','view','view_banking'),
  ('BANKING','create','add_banking'),
  ('BANKING','edit','edit_banking'),
  ('BANKING','delete','delete_banking'),
  ('BILLING_CYCLES','view','view_recurring_billing'),
  ('BILLING_CYCLES','create','add_recurring_billing'),
  ('BILLING_CYCLES','edit','edit_recurring_billing'),
  ('BILLING_CYCLES','delete','delete_recurring_billing'),
  ('COMMUNICATIONS','view','view_communication'),
  ('COMMUNICATIONS','create','add_communication'),
  ('COMMUNICATIONS','edit','edit_communication'),
  ('COMMUNICATIONS','delete','delete_communication'),
  ('COMPLAINT_ROUTING','view','view_routing_sla'),
  ('COMPLAINT_ROUTING','create','add_routing_sla'),
  ('COMPLAINT_ROUTING','edit','edit_routing_sla'),
  ('COMPLAINT_ROUTING','delete','delete_routing_sla'),
  ('COMPLAINT_ROUTING','configure','configure_routing_sla'),
  ('COMPLAINT_TICKETS','view','view_complaint'),
  ('COMPLAINT_TICKETS','create','add_complaint'),
  ('COMPLAINT_TICKETS','edit','edit_complaint'),
  ('COMPLAINT_TICKETS','delete','delete_complaint'),
  ('COMPLAINT_TICKETS','assign','assign_complaint'),
  ('COMPLAINT_TICKETS','complete','close_complaint'),
  ('COMPLAINT_TICKETS','verify','verify_complaint'),
  ('DASHBOARD','view','view_dashboard'),
  ('DASHBOARD','export','export_dashboard'),
  ('ELECTRICITY','view','view_electricity'),
  ('ELECTRICITY','create','add_electricity'),
  ('ELECTRICITY','edit','edit_electricity'),
  ('ELECTRICITY','delete','delete_electricity'),
  ('EMPLOYEES','view','view_employee'),
  ('EMPLOYEES','create','add_employee'),
  ('EMPLOYEES','edit','edit_employee'),
  ('EMPLOYEES','delete','delete_employee'),
  ('EMPLOYEES','approve','approve_employee'),
  ('EMPLOYEES','reject','reject_employee'),
  ('EMPLOYEES','export','export_employee'),
  ('EXECUTIVE_DASHBOARD','view','view_executive_dashboard'),
  ('EXECUTIVE_DASHBOARD','export','export_executive_dashboard'),
  ('EXPENSES','view','view_expense'),
  ('EXPENSES','create','add_expense'),
  ('EXPENSES','edit','edit_expense'),
  ('EXPENSES','delete','delete_expense'),
  ('EXPENSES','submit','submit_expense'),
  ('EXPENSES','approve','approve_expense'),
  ('EXPENSES','reject','reject_expense'),
  ('FACILITY','view','view_facility'),
  ('FACILITY','create','add_facility'),
  ('FACILITY','edit','edit_facility'),
  ('FACILITY','delete','delete_facility'),
  ('FOOD_ALL_ORDERS','view','view_order'),
  ('FOOD_ALL_ORDERS','create','add_order'),
  ('FOOD_ALL_ORDERS','edit','edit_order'),
  ('FOOD_ALL_ORDERS','delete','delete_order'),
  ('FOOD_CATALOGUE','view','view_service_catalogue'),
  ('FOOD_CATALOGUE','create','add_service_catalogue'),
  ('FOOD_CATALOGUE','edit','edit_service_catalogue'),
  ('FOOD_CATALOGUE','delete','delete_service_catalogue'),
  ('FOOD_CONFIRM_DELIVERY','view','view_deliveries'),
  ('FOOD_CONFIRM_DELIVERY','edit','amend_delivery'),
  ('FOOD_CONFIRM_DELIVERY','verify','confirm_receipt'),
  ('FOOD_DASHBOARD','view','view_food_dashboard'),
  ('FOOD_DASHBOARD','export','export_food_dashboard'),
  ('FOOD_DELIVERY_TRACKING','view','view_delivery_tracking'),
  ('FOOD_DELIVERY_TRACKING','create','add_delivery_tracking'),
  ('FOOD_DELIVERY_TRACKING','edit','edit_delivery_tracking'),
  ('FOOD_DELIVERY_TRACKING','delete','delete_delivery_tracking'),
  ('FOOD_DISPATCH','view','view_dispatch_queue'),
  ('FOOD_DISPATCH','edit','edit_dispatch'),
  ('FOOD_DISPATCH','assign','assign_rider'),
  ('FOOD_DISPATCH','complete','mark_dispatched'),
  ('FOOD_KITCHEN_SUMMARY','view','view_kitchen_summary'),
  ('FOOD_KITCHEN_SUMMARY','create','add_kitchen_summary'),
  ('FOOD_KITCHEN_SUMMARY','edit','edit_kitchen_summary'),
  ('FOOD_KITCHEN_SUMMARY','delete','delete_kitchen_summary'),
  ('FOOD_ORG','view','view_kitchen_org'),
  ('FOOD_ORG','create','add_kitchen_org'),
  ('FOOD_ORG','edit','edit_kitchen_org'),
  ('FOOD_ORG','delete','delete_kitchen_org'),
  ('FOOD_PLACE_ORDER','view','view_order_form'),
  ('FOOD_PLACE_ORDER','create','draft_order'),
  ('FOOD_PLACE_ORDER','edit','edit_order'),
  ('FOOD_PLACE_ORDER','delete','cancel_draft'),
  ('FOOD_PLACE_ORDER','submit','place_order'),
  ('FOOD_RECEIVE_UPDATE','view','view_receive_update'),
  ('FOOD_RECEIVE_UPDATE','create','add_receive_update'),
  ('FOOD_RECEIVE_UPDATE','edit','edit_receive_update'),
  ('FOOD_RECEIVE_UPDATE','delete','delete_receive_update'),
  ('FOOD_REPORTS','view','view_food_report'),
  ('FOOD_REPORTS','create','add_food_report'),
  ('FOOD_REPORTS','edit','edit_food_report'),
  ('FOOD_REPORTS','delete','delete_food_report'),
  ('FOOD_REPORTS','export','export_food_report'),
  ('FOOD_REPORTS','download','download_food_report'),
  ('FOOD_SETTINGS','view','view_food_setting'),
  ('FOOD_SETTINGS','create','add_food_setting'),
  ('FOOD_SETTINGS','edit','edit_food_setting'),
  ('FOOD_SETTINGS','delete','delete_food_setting'),
  ('FOOD_SETTINGS','configure','configure_food_setting'),
  ('FOOD_WASTE_TRACKING','view','view_waste_tracking'),
  ('FOOD_WASTE_TRACKING','create','add_waste_tracking'),
  ('FOOD_WASTE_TRACKING','edit','edit_waste_tracking'),
  ('FOOD_WASTE_TRACKING','delete','delete_waste_tracking'),
  ('GRN','view','view_goods_received'),
  ('GRN','create','add_goods_received'),
  ('GRN','edit','edit_goods_received'),
  ('GRN','delete','delete_goods_received'),
  ('HOUSEKEEPING_TASKS','view','view_housekeeping_task'),
  ('HOUSEKEEPING_TASKS','create','add_housekeeping_task'),
  ('HOUSEKEEPING_TASKS','edit','edit_housekeeping_task'),
  ('HOUSEKEEPING_TASKS','delete','delete_housekeeping_task'),
  ('INDENTS','view','view_indent'),
  ('INDENTS','create','add_indent'),
  ('INDENTS','edit','edit_indent'),
  ('INDENTS','delete','delete_indent'),
  ('INDENTS','submit','submit_indent'),
  ('INDENTS','approve','approve_indent'),
  ('INDENTS','reject','reject_indent'),
  ('INVENTORY','view','view_inventory'),
  ('INVENTORY','create','add_inventory'),
  ('INVENTORY','edit','edit_inventory'),
  ('INVENTORY','delete','delete_inventory'),
  ('IOT','view','view_iot'),
  ('IOT','create','add_iot'),
  ('IOT','edit','edit_iot'),
  ('IOT','delete','delete_iot'),
  ('LAUNDRY_BATCHES','view','view_laundry_batche'),
  ('LAUNDRY_BATCHES','create','add_laundry_batche'),
  ('LAUNDRY_BATCHES','edit','edit_laundry_batche'),
  ('LAUNDRY_BATCHES','delete','delete_laundry_batche'),
  ('LEDGER','view','view_ledger'),
  ('LEDGER','create','add_ledger'),
  ('LEDGER','edit','edit_ledger'),
  ('LEDGER','delete','delete_ledger'),
  ('LND','view','view_learning_development'),
  ('LND','create','add_learning_development'),
  ('LND','edit','edit_learning_development'),
  ('LND','delete','delete_learning_development'),
  ('PAYMENTS','view','view_payment'),
  ('PAYMENTS','create','add_payment'),
  ('PAYMENTS','edit','edit_payment'),
  ('PAYMENTS','delete','delete_payment'),
  ('PAYMENTS','approve','approve_payment'),
  ('PAYMENTS','verify','verify_payment'),
  ('PROPERTIES','view','view_property'),
  ('PROPERTIES','create','add_property'),
  ('PROPERTIES','edit','edit_property'),
  ('PROPERTIES','delete','delete_property'),
  ('PROPERTY_LEADS','view','view_property_lead'),
  ('PROPERTY_LEADS','create','add_property_lead'),
  ('PROPERTY_LEADS','edit','edit_property_lead'),
  ('PROPERTY_LEADS','delete','delete_property_lead'),
  ('PURCHASE_ORDERS','view','view_purchase_order'),
  ('PURCHASE_ORDERS','create','add_purchase_order'),
  ('PURCHASE_ORDERS','edit','edit_purchase_order'),
  ('PURCHASE_ORDERS','delete','delete_purchase_order'),
  ('PURCHASE_ORDERS','submit','submit_purchase_order'),
  ('PURCHASE_ORDERS','approve','approve_purchase_order'),
  ('PURCHASE_ORDERS','reject','reject_purchase_order'),
  ('RECRUITMENT','view','view_recruitment'),
  ('RECRUITMENT','create','add_recruitment'),
  ('RECRUITMENT','edit','edit_recruitment'),
  ('RECRUITMENT','delete','delete_recruitment'),
  ('RECRUITMENT','approve','approve_recruitment'),
  ('RECRUITMENT','reject','reject_recruitment'),
  ('REMINDERS','view','view_reminder'),
  ('REMINDERS','create','add_reminder'),
  ('REMINDERS','edit','edit_reminder'),
  ('REMINDERS','delete','delete_reminder'),
  ('RESIDENTS','view','view_resident'),
  ('RESIDENTS','create','add_resident'),
  ('RESIDENTS','edit','edit_resident'),
  ('RESIDENTS','delete','delete_resident'),
  ('RESIDENTS','export','export_resident'),
  ('RESIDENT_ATTENDANCE','view','view_resident_attendance'),
  ('RESIDENT_ATTENDANCE','create','add_resident_attendance'),
  ('RESIDENT_ATTENDANCE','edit','edit_resident_attendance'),
  ('RESIDENT_ATTENDANCE','delete','delete_resident_attendance'),
  ('SALES_DASHBOARD','view','view_sales_dashboard'),
  ('SALES_DASHBOARD','export','export_sales_dashboard'),
  ('SALES_LEADS','view','view_sales_crm'),
  ('SALES_LEADS','create','add_sales_crm'),
  ('SALES_LEADS','edit','edit_sales_crm'),
  ('SALES_LEADS','delete','delete_sales_crm'),
  ('SETTINGS','view','view_setting'),
  ('SETTINGS','create','add_setting'),
  ('SETTINGS','edit','edit_setting'),
  ('SETTINGS','delete','delete_setting'),
  ('SETTINGS','configure','configure_setting'),
  ('USERS','view','view_user'),
  ('USERS','create','add_user'),
  ('USERS','edit','edit_user'),
  ('USERS','delete','delete_user'),
  ('USERS','configure','configure_user'),
  ('VENDORS','view','view_vendor'),
  ('VENDORS','create','add_vendor'),
  ('VENDORS','edit','edit_vendor'),
  ('VENDORS','delete','delete_vendor'),
  ('WALLET','view','view_wallet'),
  ('WALLET','create','add_wallet'),
  ('WALLET','edit','edit_wallet'),
  ('WALLET','delete','delete_wallet'),
  ('WALLET','approve','approve_wallet'),
  ('WALLET','verify','verify_wallet');

-- 3. Re-spell every stored cell. Injective per functionality (asserted by
--    named-actions.test.ts), so no unique index can collide.
UPDATE role_functionalities r SET action = a.named
  FROM action_rename a WHERE r.functionality = a.functionality AND r.action = a.legacy;
UPDATE privileges p SET action = a.named
  FROM action_rename a WHERE p.functionality = a.functionality AND p.action = a.legacy;

-- 4. Cells the new model has no name for. Scoped to the legacy verbs on
--    purpose — see the note above.
DELETE FROM role_functionalities
 WHERE action IN ('view', 'create', 'edit', 'delete', 'submit', 'approve', 'reject', 'assign', 'complete', 'verify', 'export', 'download', 'configure');
DELETE FROM privileges
 WHERE action IN ('view', 'create', 'edit', 'delete', 'submit', 'approve', 'reject', 'assign', 'complete', 'verify', 'export', 'download', 'configure');

-- 5. The type is unreferenced once both columns are text.
DROP TYPE IF EXISTS action;

COMMIT;

-- ── After this file ──────────────────────────────────────────────────────────
-- `drizzle-kit push` adds the rest, all of which it CAN express: the
-- privilege_sets / privilege_set_items / privilege_set_assignments tables, the
-- nullable approval_* and from_set_id columns on privileges, and the `within`
-- narrowing on audit scope rules (a jsonb field, so no DDL at all).
