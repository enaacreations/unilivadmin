export const PORTFOLIO_TYPES = [
  "CO_LIVING",
  "STUDENT_HOUSING",
  "SERVICED_APARTMENTS",
  "PG",
  "COLLEGE_HOSTEL",
  "COWORKING",
  "MANAGED_OFFICE",
] as const;

export type PortfolioType = (typeof PORTFOLIO_TYPES)[number];

export const PORTFOLIO_TYPE_LABELS: Record<PortfolioType, string> = {
  CO_LIVING: "Co-living",
  STUDENT_HOUSING: "Student Housing",
  SERVICED_APARTMENTS: "Serviced Apartments",
  PG: "PG",
  COLLEGE_HOSTEL: "College Hostel",
  COWORKING: "Co-working",
  MANAGED_OFFICE: "Managed Office",
};

export type PortfolioAttributes = {
  institutionAffiliation?: string;
  academicYear?: string;
  gender?: "MALE" | "FEMALE" | "COED";
  mealPlanIncluded?: boolean;
  mealPlanDetails?: string;
  nightlyRate?: number;
  weeklyRate?: number;
  deskCapacity?: number;
  privateOfficeCount?: number;
  seatCapacity?: number;
  leaseTermMonths?: number;
};

export function portfolioAttrFields(t: PortfolioType): (keyof PortfolioAttributes)[] {
  switch (t) {
    case "STUDENT_HOUSING":
      return ["institutionAffiliation", "academicYear", "gender"];
    case "COLLEGE_HOSTEL":
      return ["institutionAffiliation", "gender"];
    case "PG":
      return ["gender", "mealPlanIncluded", "mealPlanDetails"];
    case "SERVICED_APARTMENTS":
      return ["nightlyRate", "weeklyRate"];
    case "COWORKING":
      return ["deskCapacity", "privateOfficeCount"];
    case "MANAGED_OFFICE":
      return ["seatCapacity", "leaseTermMonths"];
    case "CO_LIVING":
    default:
      return [];
  }
}

export const ATTR_LABELS: Record<keyof PortfolioAttributes, string> = {
  institutionAffiliation: "Institution Affiliation",
  academicYear: "Academic Year",
  gender: "Gender",
  mealPlanIncluded: "Meal Plan Included",
  mealPlanDetails: "Meal Plan Details",
  nightlyRate: "Nightly Rate (₹)",
  weeklyRate: "Weekly Rate (₹)",
  deskCapacity: "Desk Capacity",
  privateOfficeCount: "Private Offices",
  seatCapacity: "Seat Capacity",
  leaseTermMonths: "Lease Term (months)",
};
