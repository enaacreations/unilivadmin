import { pgTable, text, timestamp, json } from "drizzle-orm/pg-core";
import { residentsTable, usersTable } from "./core";

export const kycRequestsTable = pgTable("kyc_requests", {
  id: text("id").primaryKey(),
  residentId: text("resident_id").notNull().references(() => residentsTable.id, { onDelete: "cascade" }),
  idType: text("id_type").notNull(),
  idNumber: text("id_number").notNull(),
  idImageFront: text("id_image_front"),
  idImageBack: text("id_image_back"),
  selfieImage: text("selfie_image"),
  status: text("status").notNull().default("PENDING"),
  provider: text("provider").default("MANUAL"),
  providerRef: text("provider_ref"),
  providerData: json("provider_data"),
  rejectionReason: text("rejection_reason"),
  reviewedBy: text("reviewed_by").references(() => usersTable.id),
  reviewedAt: timestamp("reviewed_at"),
  createdBy: text("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const esignRequestsTable = pgTable("esign_requests", {
  id: text("id").primaryKey(),
  residentId: text("resident_id").notNull().references(() => residentsTable.id, { onDelete: "cascade" }),
  documentName: text("document_name").notNull(),
  documentBody: text("document_body").notNull(),
  signerEmail: text("signer_email"),
  signerPhone: text("signer_phone"),
  signerToken: text("signer_token").notNull().unique(),
  status: text("status").notNull().default("PENDING"),
  expiresAt: timestamp("expires_at").notNull(),
  viewedAt: timestamp("viewed_at"),
  signedAt: timestamp("signed_at"),
  signerName: text("signer_name"),
  signatureSvg: text("signature_svg"),
  signerIp: text("signer_ip"),
  signerUserAgent: text("signer_user_agent"),
  signedPdf: text("signed_pdf"),
  createdBy: text("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const kycEventsTable = pgTable("kyc_events", {
  id: text("id").primaryKey(),
  kycRequestId: text("kyc_request_id").notNull().references(() => kycRequestsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  actorId: text("actor_id").references(() => usersTable.id),
  ip: text("ip"),
  userAgent: text("user_agent"),
  payload: json("payload"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const esignEventsTable = pgTable("esign_events", {
  id: text("id").primaryKey(),
  esignRequestId: text("esign_request_id").notNull().references(() => esignRequestsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  payload: json("payload"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
