import type { Patient, Resource } from 'fhir/r4';
import {
  CATEGORY_SYSTEM,
  IDENTIFIER_SYSTEM,
  METHOD_SYSTEM,
  OBSERVATION_CATEGORY_SYSTEM,
  SOURCE_NAME_SYSTEM
} from '$lib/config/config';
import { CATEGORIES, METHODS } from '$lib/config/tags';

export function isLocalDemoMode(): boolean {
  const winVal =
    typeof window !== 'undefined' ? (window as any).__env?.VITE_LOCAL_DEMO : undefined;
  const raw = winVal ?? import.meta.env?.VITE_LOCAL_DEMO;
  return raw === '1' || raw === 'true';
}

export interface LocalDemoPersonaFixture {
  masterPatient: Patient;
  collections: Array<{
    sourceName: string;
    resources: Resource[];
  }>;
}

function makeDatasetPatient(params: {
  id: string;
  given: string;
  family: string;
  birthDate: string;
  gender: 'male' | 'female' | 'other' | 'unknown';
  category: string;
  method: string;
  sourceUri: string;
  sourceName: string;
  lastUpdated?: string;
}): Patient {
  return {
    resourceType: 'Patient',
    id: params.id,
    meta: {
      lastUpdated: params.lastUpdated || '2026-10-15T14:30:00Z',
      source: params.sourceUri,
      tag: [
        { system: CATEGORY_SYSTEM, code: params.category },
        { system: METHOD_SYSTEM, code: params.method },
        { system: SOURCE_NAME_SYSTEM, code: params.sourceName }
      ]
    },
    name: [{ given: [params.given], family: params.family }],
    gender: params.gender,
    birthDate: params.birthDate
  };
}

export function getLocalDemoPersonaFixture(persona: string = 'alex'): LocalDemoPersonaFixture {
  if (persona === 'leo') {
    const dsChildrenId = 'pat-leo-seattle-childrens';
    const dsEastsideId = 'pat-leo-eastside-peds';
    const dsStoryId = 'pat-leo-story';

    const masterPatient: Patient = {
      resourceType: 'Patient',
      id: 'master-leo',
      meta: { lastUpdated: '2026-10-20T09:00:00Z' },
      identifier: [{ system: IDENTIFIER_SYSTEM, value: 'demo-user-leo' }],
      name: [{ given: ['Leo'], family: 'Johnson' }],
      gender: 'male',
      birthDate: '2019-08-22',
      link: [
        { other: { reference: `Patient/${dsChildrenId}` }, type: 'seealso' },
        { other: { reference: `Patient/${dsEastsideId}` }, type: 'seealso' },
        { other: { reference: `Patient/${dsStoryId}` }, type: 'seealso' }
      ]
    };

    return {
      masterPatient,
      collections: [
        {
          sourceName: "Seattle Children's Pulmonary",
          resources: [
            makeDatasetPatient({
              id: dsChildrenId,
              given: 'Leo',
              family: 'Johnson',
              birthDate: '2019-08-22',
              gender: 'male',
              category: CATEGORIES.PROVIDER_HEALTH_RECORD,
              method: METHODS.PROVIDER_HEALTH_RECORD_SOF,
              sourceUri: 'https://fhir.seattlechildrens.example.org/r4',
              sourceName: "Seattle Children's Pulmonary"
            }),
            {
              resourceType: 'Condition',
              id: 'leo-cond-asthma',
              clinicalStatus: {
                coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }]
              },
              code: {
                coding: [{ system: 'http://snomed.info/sct', code: '195967001', display: 'Mild persistent asthma' }],
                text: 'Mild persistent asthma'
              },
              subject: { reference: `Patient/${dsChildrenId}` },
              recordedDate: '2025-11-10'
            } as Resource,
            {
              resourceType: 'MedicationRequest',
              id: 'leo-med-fluticasone',
              status: 'active',
              intent: 'order',
              medicationCodeableConcept: {
                coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '896188', display: 'Fluticasone propionate 44 MCG/ACTUAT Metered Dose Inhaler' }],
                text: 'Fluticasone HFA 44 mcg inhaler (controller — 2 puffs twice daily)'
              },
              subject: { reference: `Patient/${dsChildrenId}` },
              authoredOn: '2026-08-18'
            } as Resource,
            {
              resourceType: 'AllergyIntolerance',
              id: 'leo-allergy-peanut',
              clinicalStatus: {
                coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }]
              },
              criticality: 'high',
              code: {
                coding: [{ system: 'http://snomed.info/sct', code: '91935009', display: 'Allergy to peanut' }],
                text: 'Peanut (anaphylaxis — carries EpiPen Jr 0.15 mg)'
              },
              patient: { reference: `Patient/${dsChildrenId}` }
            } as Resource
          ]
        },
        {
          sourceName: 'Eastside Pediatrics',
          resources: [
            makeDatasetPatient({
              id: dsEastsideId,
              given: 'Leo',
              family: 'Johnson',
              birthDate: '2019-08-22',
              gender: 'male',
              category: CATEGORIES.PROVIDER_HEALTH_RECORD,
              method: METHODS.PROVIDER_HEALTH_RECORD_SOF,
              sourceUri: 'https://fhir.eastsidepeds.example.org/r4',
              sourceName: 'Eastside Pediatrics'
            }),
            {
              resourceType: 'MedicationRequest',
              id: 'leo-med-albuterol',
              status: 'active',
              intent: 'order',
              medicationCodeableConcept: {
                coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '745679', display: 'Albuterol 90 MCG/ACTUAT Metered Dose Inhaler' }],
                text: 'Albuterol HFA 90 mcg rescue inhaler (2 puffs every 4h PRN wheezing)'
              },
              subject: { reference: `Patient/${dsEastsideId}` },
              authoredOn: '2026-09-02'
            } as Resource,
            {
              resourceType: 'Immunization',
              id: 'leo-imm-mmr2',
              status: 'completed',
              vaccineCode: {
                coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '03', display: 'MMR' }],
                text: 'MMR Dose #2 (Kindergarten booster)'
              },
              patient: { reference: `Patient/${dsEastsideId}` },
              occurrenceDateTime: '2026-08-25'
            } as Resource
          ]
        },
        {
          sourceName: 'My Story',
          resources: [
            makeDatasetPatient({
              id: dsStoryId,
              given: 'Leo',
              family: 'Johnson',
              birthDate: '2019-08-22',
              gender: 'male',
              category: CATEGORIES.PATIENT_STORY,
              method: METHODS.PATIENT_STORY_FORM,
              sourceUri: 'http://localhost:4000',
              sourceName: 'My Story'
            }),
            {
              resourceType: 'Observation',
              id: 'leo-story-obs',
              status: 'final',
              category: [
                {
                  coding: [
                    { system: OBSERVATION_CATEGORY_SYSTEM, code: 'patient-story', display: 'Patient Story' }
                  ]
                }
              ],
              code: {
                coding: [{ system: 'http://loinc.org', code: '51855-5', display: 'Patient Note' }]
              },
              subject: { reference: `Patient/${dsStoryId}` },
              effectiveDateTime: '2026-10-12',
              valueString:
                'Caregiver note (Alex for Leo): Leo coughs after outdoor recess when wildfire smoke AQI is above 80. School nurse needs updated spacer instructions and EpiPen Jr authorization.'
            } as Resource,
            {
              resourceType: 'Goal',
              id: 'leo-goal-1',
              lifecycleStatus: 'active',
              achievementStatus: {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/goal-achievement',
                    code: 'in-progress',
                    display: 'In Progress'
                  }
                ]
              },
              description: { text: 'Keep asthma controlled through soccer season without nighttime coughing' },
              subject: { reference: `Patient/${dsStoryId}` },
              statusDate: '2026-10-12'
            } as Resource
          ]
        }
      ]
    };
  }

  // Default persona: Alex Johnson (4 sources across UW Medicine, City Clinic, MultiCare Urgent Care, My Story)
  const dsUwId = 'pat-alex-uw';
  const dsClinicId = 'pat-alex-cityclinic';
  const dsUrgentId = 'pat-alex-multicare';
  const dsStoryId = 'pat-alex-story';

  const masterPatient: Patient = {
    resourceType: 'Patient',
    id: 'master-alex',
    meta: { lastUpdated: '2026-10-28T16:15:00Z' },
    identifier: [{ system: IDENTIFIER_SYSTEM, value: 'demo-user-alex' }],
    name: [{ given: ['Alex'], family: 'Johnson' }],
    gender: 'male',
    birthDate: '1962-03-14',
    link: [
      { other: { reference: `Patient/${dsUwId}` }, type: 'seealso' },
      { other: { reference: `Patient/${dsClinicId}` }, type: 'seealso' },
      { other: { reference: `Patient/${dsUrgentId}` }, type: 'seealso' },
      { other: { reference: `Patient/${dsStoryId}` }, type: 'seealso' }
    ]
  };

  return {
    masterPatient,
    collections: [
      {
        sourceName: 'UW Medicine Cardiology & Nephrology',
        resources: [
          makeDatasetPatient({
            id: dsUwId,
            given: 'Alex',
            family: 'Johnson',
            birthDate: '1962-03-14',
            gender: 'male',
            category: CATEGORIES.PROVIDER_HEALTH_RECORD,
            method: METHODS.PROVIDER_HEALTH_RECORD_SOF,
            sourceUri: 'https://fhir.uwmedicine.example.org/r4',
            sourceName: 'UW Medicine Cardiology & Nephrology'
          }),
          {
            resourceType: 'Condition',
            id: 'alex-cond-afib',
            clinicalStatus: {
              coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }]
            },
            code: {
              coding: [{ system: 'http://snomed.info/sct', code: '49436004', display: 'Atrial fibrillation' }],
              text: 'Paroxysmal atrial fibrillation'
            },
            subject: { reference: `Patient/${dsUwId}` },
            recordedDate: '2024-05-19'
          } as Resource,
          {
            resourceType: 'Condition',
            id: 'alex-cond-ckd',
            clinicalStatus: {
              coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }]
            },
            code: {
              coding: [{ system: 'http://snomed.info/sct', code: '433144002', display: 'Chronic kidney disease stage 3A' }],
              text: 'Chronic kidney disease stage 3a (baseline eGFR 51 mL/min)'
            },
            subject: { reference: `Patient/${dsUwId}` },
            recordedDate: '2025-03-04'
          } as Resource,
          {
            resourceType: 'MedicationRequest',
            id: 'alex-med-warfarin',
            status: 'active',
            intent: 'order',
            medicationCodeableConcept: {
              coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '855332', display: 'Warfarin Sodium 5 MG Oral Tablet' }],
              text: 'Warfarin sodium 5 mg tablet once daily (target INR 2.0-3.0)'
            },
            subject: { reference: `Patient/${dsUwId}` },
            authoredOn: '2026-09-12'
          } as Resource,
          {
            resourceType: 'MedicationRequest',
            id: 'alex-med-lisinopril',
            status: 'active',
            intent: 'order',
            medicationCodeableConcept: {
              coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '314076', display: 'Lisinopril 20 MG Oral Tablet' }],
              text: 'Lisinopril 20 mg tablet once daily'
            },
            subject: { reference: `Patient/${dsUwId}` },
            authoredOn: '2026-09-12'
          } as Resource,
          {
            resourceType: 'Observation',
            id: 'alex-obs-egfr',
            status: 'final',
            category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
            code: {
              coding: [{ system: 'http://loinc.org', code: '62238-1', display: 'eGFR CKD-EPI' }],
              text: 'eGFR'
            },
            subject: { reference: `Patient/${dsUwId}` },
            effectiveDateTime: '2026-10-03',
            valueQuantity: { value: 51, unit: 'mL/min/1.73m2', system: 'http://unitsofmeasure.org', code: 'mL/min/{1.73_m2}' }
          } as Resource
        ]
      },
      {
        sourceName: 'City Clinic Primary Care',
        resources: [
          makeDatasetPatient({
            id: dsClinicId,
            given: 'Alex',
            family: 'Johnson',
            birthDate: '1962-03-14',
            gender: 'male',
            category: CATEGORIES.PROVIDER_HEALTH_RECORD,
            method: METHODS.PROVIDER_HEALTH_RECORD_SOF,
            sourceUri: 'https://fhir.cityclinic.example.org/r4',
            sourceName: 'City Clinic Primary Care'
          }),
          {
            resourceType: 'Condition',
            id: 'alex-cond-t2dm',
            clinicalStatus: {
              coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }]
            },
            code: {
              coding: [{ system: 'http://snomed.info/sct', code: '44054006', display: 'Type 2 diabetes mellitus' }],
              text: 'Type 2 diabetes mellitus'
            },
            subject: { reference: `Patient/${dsClinicId}` },
            recordedDate: '2021-07-22'
          } as Resource,
          {
            resourceType: 'MedicationRequest',
            id: 'alex-med-metformin',
            status: 'active',
            intent: 'order',
            medicationCodeableConcept: {
              coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '861007', display: 'Metformin hydrochloride 500 MG Extended Release Oral Tablet' }],
              text: 'Metformin ER 500 mg twice daily with meals'
            },
            subject: { reference: `Patient/${dsClinicId}` },
            authoredOn: '2026-09-28'
          } as Resource,
          {
            resourceType: 'Observation',
            id: 'alex-obs-a1c-oct',
            status: 'final',
            category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
            code: {
              coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood' }],
              text: 'Hemoglobin A1c'
            },
            subject: { reference: `Patient/${dsClinicId}` },
            effectiveDateTime: '2026-10-05',
            valueQuantity: { value: 7.4, unit: '%', system: 'http://unitsofmeasure.org', code: '%' }
          } as Resource,
          {
            resourceType: 'Observation',
            id: 'alex-obs-a1c-apr',
            status: 'final',
            category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
            code: {
              coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c/Hemoglobin.total in Blood' }],
              text: 'Hemoglobin A1c'
            },
            subject: { reference: `Patient/${dsClinicId}` },
            effectiveDateTime: '2026-04-11',
            valueQuantity: { value: 8.1, unit: '%', system: 'http://unitsofmeasure.org', code: '%' }
          } as Resource,
          {
            resourceType: 'AllergyIntolerance',
            id: 'alex-allergy-penicillin',
            clinicalStatus: {
              coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }]
            },
            criticality: 'high',
            code: {
              coding: [{ system: 'http://snomed.info/sct', code: '91936005', display: 'Allergy to penicillin' }],
              text: 'Penicillin (hives and facial swelling)'
            },
            patient: { reference: `Patient/${dsClinicId}` }
          } as Resource
        ]
      },
      {
        sourceName: 'MultiCare Urgent Care',
        resources: [
          makeDatasetPatient({
            id: dsUrgentId,
            given: 'Alex',
            family: 'Johnson',
            birthDate: '1962-03-14',
            gender: 'male',
            category: CATEGORIES.PROVIDER_HEALTH_RECORD,
            method: METHODS.PROVIDER_HEALTH_RECORD_SOF,
            sourceUri: 'https://fhir.multicare.example.org/r4',
            sourceName: 'MultiCare Urgent Care'
          }),
          {
            resourceType: 'MedicationRequest',
            id: 'alex-med-ibuprofen-urgent',
            status: 'active',
            intent: 'order',
            medicationCodeableConcept: {
              coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '197806', display: 'Ibuprofen 600 MG Oral Tablet' }],
              text: 'Ibuprofen 600 mg tablet every 8 hours PRN right knee pain (prescribed at walk-in visit)'
            },
            subject: { reference: `Patient/${dsUrgentId}` },
            authoredOn: '2026-10-22'
          } as Resource
        ]
      },
      {
        sourceName: 'My Story',
        resources: [
          makeDatasetPatient({
            id: dsStoryId,
            given: 'Alex',
            family: 'Johnson',
            birthDate: '1962-03-14',
            gender: 'male',
            category: CATEGORIES.PATIENT_STORY,
            method: METHODS.PATIENT_STORY_FORM,
            sourceUri: 'http://localhost:4000',
            sourceName: 'My Story'
          }),
          {
            resourceType: 'Observation',
            id: 'alex-story-obs',
            status: 'final',
            category: [
              {
                coding: [
                  { system: OBSERVATION_CATEGORY_SYSTEM, code: 'patient-story', display: 'Patient Story' }
                ]
              }
            ],
            code: {
              coding: [{ system: 'http://loinc.org', code: '51855-5', display: 'Patient Note' }]
            },
            subject: { reference: `Patient/${dsStoryId}` },
            effectiveDateTime: '2026-10-26',
            valueString:
              'I noticed lightheadedness when standing up in the evenings and mild bruising on my forearms since starting the urgent care knee medication. Walking my dog 30 minutes daily is my top priority.'
          } as Resource,
          {
            resourceType: 'Goal',
            id: 'alex-goal-walk',
            lifecycleStatus: 'active',
            achievementStatus: {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/goal-achievement',
                  code: 'in-progress',
                  display: 'In Progress'
                }
              ]
            },
            description: { text: 'Walk 30 minutes pain-free every morning and bring A1c under 7.0%' },
            subject: { reference: `Patient/${dsStoryId}` },
            statusDate: '2026-10-26'
          } as Resource
        ]
      }
    ]
  };
}
