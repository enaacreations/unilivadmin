// ─────────────────────────────────────────────────────────────────────────────
// INTERIM Leave & License (rent) agreement template (O26).
//
// The clause body below is copied from docs/legal/interim-rent-agreement-template.md
// (standard Indian 11-month Leave & License structure) and is used as an
// interim/demo format until a counsel-approved template replaces it. It is
// NOT legal advice and has NOT been reviewed by an advocate — the
// "INTERIM — REPLACE BEFORE GO-LIVE" disclaimer is intentionally retained in
// the rendered output.
//
// renderAgreement(data) fills the {{merge_field}} placeholders from a resident,
// their property, and a licensor name (sourced from env/config by the caller),
// and returns the final plain-text document body. That body is what gets stored
// (encrypted at rest per WS5) as the esign documentBody and rendered into the
// signed PDF by buildSignedPdf.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal shape of a resident needed to render the agreement. */
export interface AgreementResident {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  gender?: string | null;
  dob?: Date | string | null;
  /** Government-id type (e.g. AADHAAR / PAN) for the recital line, if known. */
  idType?: string | null;
  /** Already-masked government-id number (never pass a raw id here). */
  idMasked?: string | null;
  /** Permanent address of the licensee, if on file. */
  permanentAddress?: string | null;
  accommodationType?: string | null;
  bedOrRoomNo?: string | null;
  checkInDate?: Date | string | null;
  checkOutDate?: Date | string | null;
  monthlyRent?: number | string | null;
  securityDeposit?: number | string | null;
}

/** Minimal shape of a property needed to render the agreement. */
export interface AgreementProperty {
  name: string;
  code?: string | null;
  address: string;
  city: string;
  state: string;
  pincode: string;
}

/** Everything renderAgreement needs to fill the merge fields. */
export interface AgreementData {
  resident: AgreementResident;
  property: AgreementProperty;
  /** Licensor (operating entity) legal name — from env/config. */
  licensorName: string;
  /** Licensor registered address — from env/config. Optional. */
  licensorAddress?: string | null;
  /** Place of execution; defaults to the property city. */
  place?: string | null;
  /** Execution date; defaults to "now". */
  executedOn?: Date | null;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(v: Date | string | null | undefined): string {
  const d = toDate(v);
  if (!d) return "________________";
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** End date = start + 11 months (interim default term), when no explicit end. */
function elevenMonthsAfter(start: Date): Date {
  const d = new Date(start);
  d.setMonth(d.getMonth() + 11);
  return d;
}

function fmtMoney(v: number | string | null | undefined): string {
  if (v == null || v === "") return "________";
  const n = Number(v);
  if (Number.isNaN(n)) return "________";
  return n.toLocaleString("en-IN");
}

function or(value: string | null | undefined, fallback: string): string {
  const s = (value ?? "").toString().trim();
  return s.length ? s : fallback;
}

/**
 * Render the interim Leave & License agreement to its final plain-text body by
 * filling all merge fields. Unknown/optional fields fall back to neutral
 * placeholders ("________") so the document is always complete and signable.
 * The INTERIM — REPLACE BEFORE GO-LIVE disclaimer is always included.
 */
export function renderAgreement(data: AgreementData): string {
  const { resident, property, licensorName } = data;
  const executedOn = data.executedOn ?? new Date();
  const place = or(data.place, property.city);

  const start = toDate(resident.checkInDate);
  const end = toDate(resident.checkOutDate) ?? (start ? elevenMonthsAfter(start) : null);

  const accommodationType = or(resident.accommodationType, "Bed / Room");
  const bedOrRoomNo = or(resident.bedOrRoomNo, "as allotted");
  const idType = or(resident.idType, "Government ID");
  const idMasked = or(resident.idMasked, "____________");
  const genderAge = or(resident.gender, "adult");

  return `LEAVE AND LICENSE AGREEMENT

This Leave and License Agreement ("Agreement") is made and executed at ${place} on this ${String(
    executedOn.getDate(),
  ).padStart(2, "0")} day of ${MONTHS[executedOn.getMonth()]}, ${executedOn.getFullYear()}.

BETWEEN

${licensorName}, the operator/manager of the licensed accommodation, having its place of business at ${or(
    data.licensorAddress,
    "________________",
  )} (hereinafter referred to as the "Licensor", which expression shall, unless repugnant to the context, include its successors and assigns), of the ONE PART;

AND

${or(resident.name, "________________")}, ${genderAge}, holder of ${idType} no. ${idMasked}, residing permanently at ${or(
    resident.permanentAddress,
    "________________",
  )}, mobile ${or(resident.phone, "____________")} (hereinafter referred to as the "Licensee", which expression shall, unless repugnant to the context, include his/her heirs and legal representatives), of the OTHER PART.

The Licensor and the Licensee are hereinafter individually referred to as a "Party" and collectively as the "Parties".

RECITALS

WHEREAS the Licensor is in lawful possession and control of the residential premises more particularly described in the Schedule below (the "Licensed Premises"); AND WHEREAS the Licensee has requested the Licensor to grant, and the Licensor has agreed to grant, a license to occupy and use the Licensed Premises on a leave-and-license basis on the terms and conditions set out below. This Agreement does not create any tenancy, lease, or interest in the Licensed Premises in favour of the Licensee, and only a revocable license to occupy is granted.

NOW THIS AGREEMENT WITNESSETH AS FOLLOWS:

1. Grant of License. The Licensor hereby grants to the Licensee a non-transferable, non-exclusive license to occupy and use the Licensed Premises, being ${accommodationType} (${bedOrRoomNo}) at ${property.name}, ${property.address}, ${property.city} ${property.pincode}, solely for the Licensee's personal residential use.

2. Term. This license is granted for a period of eleven (11) months commencing from ${fmtDate(
    start,
  )} and expiring on ${fmtDate(end)}, unless terminated earlier or renewed in writing by mutual consent. The Parties may renew this Agreement for further like periods on mutually agreed terms.

3. License Fee (Rent). The Licensee shall pay a monthly license fee of Rs. ${fmtMoney(
    resident.monthlyRent,
  )}, payable in advance on or before the 5th day of each English calendar month, by the mode notified by the Licensor. Timely payment is of the essence of this Agreement.

4. Security Deposit. The Licensee has paid / shall pay an interest-free refundable security deposit of Rs. ${fmtMoney(
    resident.securityDeposit,
  )}. The deposit shall be refunded within 30 days of the Licensee vacating and handing over peaceful possession of the Licensed Premises, after deducting any arrears of license fee, utility dues, damages (fair wear and tear excepted), and other amounts payable under this Agreement.

5. Utilities and Maintenance. Charges for electricity, water, internet, and common-area maintenance shall be borne as per the plan and house policy notified by the Licensor. The Licensee shall use the Licensed Premises and all amenities with reasonable care and shall be responsible for any damage caused by the Licensee's negligence or misuse.

6. Use and Conduct. The Licensee shall: (a) use the Licensed Premises only for lawful residential purposes; (b) not sublet, assign, or part with possession of the Licensed Premises or any part thereof; (c) not carry on any trade, business, or illegal/immoral activity; (d) not cause nuisance, annoyance, or disturbance to other residents or neighbours; (e) abide by the house rules, code of conduct, and safety/security policies notified by the Licensor from time to time; and (f) provide and keep current valid identity/KYC documentation as required by law and by the Licensor.

7. Licensor's Obligations. The Licensor shall permit the Licensee peaceful use and occupation of the Licensed Premises during the term, subject to the Licensee's compliance with this Agreement, and shall make available the essential services and amenities applicable to the Licensed Premises.

8. Right of Entry. The Licensor or its authorised representatives may enter the Licensed Premises at reasonable times, with reasonable prior notice (except in an emergency), for inspection, maintenance, repairs, or to show the premises to prospective residents during the notice period.

9. Lock-in and Termination. Either Party may terminate this Agreement by giving 30 days' prior written notice. The Licensor may terminate this Agreement forthwith upon the Licensee's breach of any material term, including non-payment of the license fee for two (2) months or more, or violation of house rules, whereupon the Licensee shall vacate and hand over peaceful possession of the Licensed Premises.

10. Handover. Upon expiry or earlier termination, the Licensee shall remove all personal belongings and hand over vacant and peaceful possession of the Licensed Premises in the same condition as at the commencement, fair wear and tear excepted, together with all keys/access devices and fixtures provided.

11. Inventory. The fixtures, fittings, and articles provided with the Licensed Premises are listed in the Schedule and shall be returned by the Licensee in good working condition at handover.

12. Indemnity. The Licensee shall indemnify and keep the Licensor indemnified against any loss, damage, claim, or liability arising from the Licensee's breach of this Agreement or negligent/wrongful acts or omissions.

13. Stamp Duty and Registration. This Agreement shall be executed on stamp paper of the value required under the applicable State Stamp Act, and where required by law shall be registered/notified to the appropriate authority; the costs thereof shall be borne as per prevailing practice in ${property.state}.

14. Dispute Resolution and Jurisdiction. This Agreement shall be governed by and construed in accordance with the laws of India. The Parties shall endeavour to settle any dispute amicably; failing which, the courts at ${property.city} shall have exclusive jurisdiction.

15. Entire Agreement. This Agreement, together with the house rules and policies referenced herein, constitutes the entire understanding between the Parties and supersedes all prior arrangements. Any amendment shall be in writing and signed by both Parties.

IN WITNESS WHEREOF the Parties have set their hands to this Agreement on the day, month, and year first above written.

----------------------------------------------------------------------

SCHEDULE — The Licensed Premises

Accommodation: ${accommodationType} — ${bedOrRoomNo}
Property: ${property.name} (${or(property.code, "—")})
Address: ${property.address}, ${property.city}, ${property.state} ${property.pincode}

----------------------------------------------------------------------

For and on behalf of the LICENSOR            LICENSEE

____________________________                 ____________________________
${licensorName}                              ${or(resident.name, "________________")}
(Authorised Signatory)                       (Resident)

WITNESSES
1. ______________________   Name: ____________   Address: ____________
2. ______________________   Name: ____________   Address: ____________

----------------------------------------------------------------------

INTERIM DOCUMENT — REPLACE BEFORE GO-LIVE. This template is a reasonable
approximation of a standard Indian 11-month Leave & License agreement generated
for demo/testing. It is NOT legal advice and has NOT been reviewed by a
qualified advocate. Before production use, replace it with a counsel-approved
template, confirm the correct State stamp-duty value and any e-registration /
police-intimation requirement, and finalise the Licensor entity details.
`;
}
