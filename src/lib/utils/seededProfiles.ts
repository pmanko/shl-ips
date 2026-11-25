export interface SeededPatientProfile {
  id: string;
  slug: string;
  name: string;
  givenName: string;
  familyName: string;
  email: string;
  birthDate: string;
  cohort: string;
  clinicalFocus: string;
  isChildProxy?: boolean;
}

/**
 * Canonical 12 seeded WAHS demo patient profiles backed by real Keycloak OIDC
 * accounts and HAPI FHIR R4 records. Ordered with Primary/Child first and
 * multi-site complex charts next so clinicians/testers can pick quickly.
 */
export const SEEDED_DEMO_ACCOUNTS: readonly SeededPatientProfile[] = [
  {
    id: 'alex',
    slug: 'alex',
    name: 'Alex Johnson',
    givenName: 'Alex',
    familyName: 'Johnson',
    email: 'alex.johnson@wahs.local',
    birthDate: '1962-03-14',
    cohort: 'Primary Persona',
    clinicalFocus: 'Adult cardiology, CKD & diabetes (4 sources)',
    isChildProxy: false
  },
  {
    id: 'leo',
    slug: 'leo',
    name: 'Leo Johnson',
    givenName: 'Leo',
    familyName: 'Johnson',
    email: 'leo.johnson@wahs.local',
    birthDate: '2019-08-22',
    cohort: 'Child Proxy Persona',
    clinicalFocus: 'Pediatric asthma & peanut allergy (3 sources)',
    isChildProxy: true
  },
  {
    id: 'maurice',
    slug: 'maurice',
    name: 'Maurice Auer',
    givenName: 'Maurice',
    familyName: 'Auer',
    email: 'maurice.auer@wahs.local',
    birthDate: '1973-03-25',
    cohort: 'Complex Multi-Site',
    clinicalFocus: 'Complex multi-site longitudinal record (7,099 resources)',
    isChildProxy: false
  },
  {
    id: 'julian',
    slug: 'julian',
    name: 'Julian Mercer',
    givenName: 'Julian',
    familyName: 'Mercer',
    email: 'julian.mercer@wahs.local',
    birthDate: '1954-10-08',
    cohort: 'MIMIC-IV ICU Heme/Renal',
    clinicalFocus: 'MIMIC-IV ICU hematology & cardiorenal (4,048 resources)',
    isChildProxy: false
  },
  {
    id: 'clara',
    slug: 'clara',
    name: 'Clara Hollis',
    givenName: 'Clara',
    familyName: 'Hollis',
    email: 'clara.hollis@wahs.local',
    birthDate: '1958-12-21',
    cohort: 'MIMIC-IV ICU Hepatopulmonary',
    clinicalFocus: 'MIMIC-IV ICU hepatopulmonary (2,661 resources)',
    isChildProxy: false
  },
  {
    id: 'marcus',
    slug: 'marcus',
    name: 'Marcus Vance',
    givenName: 'Marcus',
    familyName: 'Vance',
    email: 'marcus.vance@wahs.local',
    birthDate: '1961-09-22',
    cohort: 'Thoracic Oncology',
    clinicalFocus: 'Fred Hutch + UW thoracic oncology immunotherapy (1,612 resources)',
    isChildProxy: false
  },
  {
    id: 'lamar',
    slug: 'lamar',
    name: 'Lamar Beer',
    givenName: 'Lamar',
    familyName: 'Beer',
    email: 'lamar.beer@wahs.local',
    birthDate: '1971-02-16',
    cohort: 'Outpatient & Urgent Care',
    clinicalFocus: 'Outpatient & urgent care longitudinal record (892 resources)',
    isChildProxy: false
  },
  {
    id: 'byron',
    slug: 'byron',
    name: 'Byron Emard',
    givenName: 'Byron',
    familyName: 'Emard',
    email: 'byron.emard@wahs.local',
    birthDate: '2009-12-14',
    cohort: 'Adolescent Longitudinal',
    clinicalFocus: 'Pediatric & adolescent longitudinal care (480 resources)',
    isChildProxy: false
  },
  {
    id: 'elena',
    slug: 'elena',
    name: 'Elena Rostova',
    givenName: 'Elena',
    familyName: 'Rostova',
    email: 'elena.rostova@wahs.local',
    birthDate: '1954-04-12',
    cohort: 'Cardiorenal',
    clinicalFocus: 'UW Heart Institute + NW Kidney cardiorenal (454 resources)',
    isChildProxy: false
  },
  {
    id: 'margaret',
    slug: 'margaret',
    name: 'Margaret Chen',
    givenName: 'Margaret',
    familyName: 'Chen',
    email: 'margaret.chen@wahs.local',
    birthDate: '1943-11-03',
    cohort: 'Geriatrics Polypharmacy',
    clinicalFocus: 'Geriatrics & Overlake sleep polypharmacy (448 resources)',
    isChildProxy: false
  },
  {
    id: 'arthur',
    slug: 'arthur',
    name: 'Arthur Pendelton',
    givenName: 'Arthur',
    familyName: 'Pendelton',
    email: 'arthur.pendelton@wahs.local',
    birthDate: '1947-08-19',
    cohort: 'Anticoagulation & GI',
    clinicalFocus: 'Anticoagulation, GI & primary care (447 resources)',
    isChildProxy: false
  },
  {
    id: 'sofia',
    slug: 'sofia',
    name: 'Sofia Alvarez',
    givenName: 'Sofia',
    familyName: 'Alvarez',
    email: 'sofia.alvarez@wahs.local',
    birthDate: '1991-06-14',
    cohort: 'Maternal-Fetal & Endocrine',
    clinicalFocus: 'UW Maternal-Fetal & Endocrine (436 resources)',
    isChildProxy: false
  }
];

export function findSeededProfile(slugOrEmail: string): SeededPatientProfile | undefined {
  const q = String(slugOrEmail || '').trim().toLowerCase();
  if (!q) return undefined;
  return SEEDED_DEMO_ACCOUNTS.find(
    (acct) =>
      acct.slug.toLowerCase() === q ||
      acct.id.toLowerCase() === q ||
      acct.email.toLowerCase() === q
  );
}
