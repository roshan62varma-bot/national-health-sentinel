export type Tier = "GREEN" | "AMBER" | "RED";
export type ResourceType = "MEDICINE" | "BED" | "STAFF";

export interface Facility {
  id: string;
  name: string;
  type: "PHC" | "CHC" | "DISTRICT_HOSPITAL";
  districtId: string;
  stateId: string;
  nationId: string;
  lat: number;
  lng: number;
  catchmentPopulation: number;
}

export interface District {
  id: string;
  name: string;
  stateId: string;
  emergencyMode: boolean;
  redHoursStreak: number;
}

export interface Medicine {
  id: string;
  name: string;
  whoEssential: boolean;
  unit: string;
}

export interface StockSnapshot {
  facilityId: string;
  medicineId: string;
  onHand: number;
  onOrder: number;
  backorder: number;
  avgDailyConsumption: number;
  sigmaDemand: number;
  leadTimeDays: number;
  updatedAt: string;
}

export interface Bed {
  id: string;
  facilityId: string;
  wardType: "General" | "ICU" | "Maternity" | "Isolation";
  total: number;
  occupied: number;
}

export interface StaffRoster {
  facilityId: string;
  role: "Doctor" | "Nurse" | "ANM" | "Pharmacist";
  present: number;
  minSafeStaffingCount: number;
}

export interface RiskScore {
  facilityId: string;
  stockRisk: number;
  bedRisk: number;
  staffRisk: number;
  composite: number;
  tier: Tier;
}

export interface DispatchManifest {
  id: string;
  resourceType: ResourceType;
  label: string;
  sourceFacilityId: string;
  destFacilityId: string;
  quantity: number;
  distanceKm: number;
  etaHours: number;
  severity: number;
  daysToStockout: number;
  status: "PENDING_APPROVAL" | "APPROVED";
  signatureToken?: string;
  rationale: string;
}

export interface FlRound {
  id: string;
  roundNumber: number;
  nationId: string;
  nation: string;
  dpEpsilon: number;
  weightsHash: string;
  aggregateAccuracyDelta: number;
  timestamp: string;
}