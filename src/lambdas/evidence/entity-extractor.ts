/**
 * Comprehend Medical Entity Extraction and Relevance Scoring
 *
 * Invokes Amazon Comprehend Medical DetectEntitiesV2 to extract medical entities
 * from FHIR resource text, maps them to denial reason categories, calculates
 * relevance scores, and filters/ranks evidence by relevance.
 *
 * Requirements: 3.4, 3.5, 3.6
 */

import {
  ComprehendMedicalClient,
  DetectEntitiesV2Command,
  type Entity as ComprehendEntity,
} from '@aws-sdk/client-comprehendmedical';
import type {
  EvidenceItem,
  ExtractedEntity,
  EntityCategory,
  FhirResourceType,
  CarcCode,
} from '@shared/models';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Input FHIR resource with text content for entity extraction. */
export interface FhirResourceInput {
  fhir_resource_id: string;
  fhir_resource_type: FhirResourceType;
  date: string;
  authoring_provider: string;
  text_content: string;
}

/** Classified denial context for relevance scoring. */
export interface DenialContext {
  carc_codes: CarcCode[];
  raw_denial_reason_text: string;
}

/** Result of entity extraction and relevance scoring. */
export interface EntityExtractionResult {
  evidence_items: EvidenceItem[];
  manual_review_required: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Minimum relevance score threshold for inclusion in results. */
export const RELEVANCE_THRESHOLD = 0.2;

/** Boost applied when entity text matches denial reason keywords. */
export const KEYWORD_BOOST = 0.1;

/** Maximum relevance score. */
export const MAX_SCORE = 1.0;

/**
 * Mapping from Comprehend Medical entity categories to our model's EntityCategory.
 * MEDICAL_CONDITION → DIAGNOSIS
 * TEST_TREATMENT_PROCEDURE → PROCEDURE
 * MEDICATION → MEDICATION
 * ANATOMY → ANATOMY
 */
export const COMPREHEND_CATEGORY_MAP: Record<string, EntityCategory> = {
  MEDICAL_CONDITION: 'DIAGNOSIS',
  TEST_TREATMENT_PROCEDURE: 'PROCEDURE',
  MEDICATION: 'MEDICATION',
  ANATOMY: 'ANATOMY',
};

// ─── Client Management ──────────────────────────────────────────────────────

let comprehendClient: ComprehendMedicalClient | null = null;

/** Set a custom Comprehend Medical client (for testing). */
export function setComprehendClient(client: ComprehendMedicalClient): void {
  comprehendClient = client;
}

/** Reset the Comprehend Medical client to default (for testing). */
export function resetComprehendClient(): void {
  comprehendClient = null;
}

function getComprehendClient(): ComprehendMedicalClient {
  if (!comprehendClient) {
    comprehendClient = new ComprehendMedicalClient({});
  }
  return comprehendClient;
}

// ─── Entity Extraction ──────────────────────────────────────────────────────

/**
 * Extracts medical entities from text using Comprehend Medical DetectEntitiesV2.
 * Returns mapped entities or null on failure.
 */
export async function extractEntities(
  text: string
): Promise<ExtractedEntity[] | null> {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const client = getComprehendClient();

  try {
    const command = new DetectEntitiesV2Command({ Text: text });
    const response = await client.send(command);

    if (!response.Entities || response.Entities.length === 0) {
      return [];
    }

    return mapComprehendEntities(response.Entities);
  } catch (error) {
    // On Comprehend Medical failure, return null to signal error
    return null;
  }
}

/**
 * Maps Comprehend Medical entities to our ExtractedEntity model.
 * Only includes entities whose category maps to a known EntityCategory.
 */
export function mapComprehendEntities(
  entities: ComprehendEntity[]
): ExtractedEntity[] {
  const mapped: ExtractedEntity[] = [];

  for (const entity of entities) {
    const category = entity.Category
      ? COMPREHEND_CATEGORY_MAP[entity.Category]
      : undefined;

    if (!category) {
      continue; // Skip entities that don't map to our categories
    }

    mapped.push({
      text: entity.Text || '',
      category,
      icd_code: extractIcdCode(entity) || null,
      confidence: entity.Score ?? 0,
    });
  }

  return mapped;
}

/**
 * Extracts ICD code from Comprehend Medical entity attributes.
 * Looks for DX_NAME sub-type attributes which contain diagnosis codes.
 */
function extractIcdCode(entity: ComprehendEntity): string | null {
  if (!entity.Attributes) {
    return null;
  }

  for (const attr of entity.Attributes) {
    if (attr.Type === 'DX_NAME' || attr.Type === 'TEST_NAME') {
      return attr.Text || null;
    }
  }

  return null;
}

// ─── Relevance Scoring ──────────────────────────────────────────────────────

/**
 * Calculates relevance score for an evidence item based on entity-to-denial-reason alignment.
 *
 * Algorithm:
 * 1. Collect all required evidence categories from the denial's CARC codes.
 * 2. For each evidence item, compare its extracted entity categories against required categories.
 * 3. Score = (matching categories / total required categories) * average entity confidence.
 * 4. Boost by 0.1 if entity text contains keywords from the denial reason text.
 * 5. Cap at 1.0.
 */
export function calculateRelevanceScore(
  extractedEntities: ExtractedEntity[],
  denialContext: DenialContext
): number {
  const requiredCategories = getRequiredCategories(denialContext.carc_codes);

  if (requiredCategories.length === 0 || extractedEntities.length === 0) {
    return 0.0;
  }

  // Find matching entity categories
  const entityCategories = new Set(
    extractedEntities.map((e) => e.category)
  );

  const matchingCount = requiredCategories.filter((cat) =>
    entityCategories.has(cat as EntityCategory)
  ).length;

  // Calculate average confidence of extracted entities
  const avgConfidence =
    extractedEntities.reduce((sum, e) => sum + e.confidence, 0) /
    extractedEntities.length;

  // Base score: matching ratio * average confidence
  let score = (matchingCount / requiredCategories.length) * avgConfidence;

  // Keyword boost: check if any entity text contains keywords from denial reason
  if (hasKeywordMatch(extractedEntities, denialContext.raw_denial_reason_text)) {
    score += KEYWORD_BOOST;
  }

  // Cap at 1.0
  return Math.min(score, MAX_SCORE);
}

/**
 * Collects all unique required evidence categories from CARC codes.
 */
export function getRequiredCategories(carcCodes: CarcCode[]): string[] {
  const categories = new Set<string>();

  for (const carc of carcCodes) {
    for (const cat of carc.required_evidence_categories) {
      categories.add(cat);
    }
  }

  return Array.from(categories);
}

/**
 * Checks if any extracted entity text contains keywords from the denial reason text.
 * Performs case-insensitive matching on words with 4+ characters.
 */
export function hasKeywordMatch(
  entities: ExtractedEntity[],
  denialReasonText: string
): boolean {
  if (!denialReasonText || denialReasonText.trim().length === 0) {
    return false;
  }

  // Extract meaningful keywords (4+ chars) from denial reason text
  const keywords = denialReasonText
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 4)
    .map((word) => word.replace(/[^a-z0-9]/g, ''));

  if (keywords.length === 0) {
    return false;
  }

  // Check if any entity text contains any keyword
  for (const entity of entities) {
    const entityTextLower = entity.text.toLowerCase();
    for (const keyword of keywords) {
      if (keyword && entityTextLower.includes(keyword)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Maps extracted entities to the CARC codes they are relevant to.
 * Returns an array of CARC code strings that the entities support.
 */
export function mapEntitiesToDenialReasons(
  entities: ExtractedEntity[],
  carcCodes: CarcCode[]
): string[] {
  const mappedReasons: string[] = [];
  const entityCategories = new Set(entities.map((e) => e.category));

  for (const carc of carcCodes) {
    const hasMatch = carc.required_evidence_categories.some((reqCat) =>
      entityCategories.has(reqCat as EntityCategory)
    );
    if (hasMatch) {
      mappedReasons.push(carc.code);
    }
  }

  return mappedReasons;
}

// ─── Main Extraction and Scoring Pipeline ───────────────────────────────────

/**
 * Processes FHIR resources through Comprehend Medical entity extraction,
 * calculates relevance scores, filters below threshold, and ranks by score.
 *
 * On Comprehend Medical failure for any resource: returns that resource with
 * score 0.0 and flags for manual review.
 */
export async function extractAndScoreEvidence(
  fhirResources: FhirResourceInput[],
  denialContext: DenialContext
): Promise<EntityExtractionResult> {
  let manualReviewRequired = false;
  const evidenceItems: EvidenceItem[] = [];

  for (const resource of fhirResources) {
    const entities = await extractEntities(resource.text_content);

    if (entities === null) {
      // Comprehend Medical failure: return unprocessed with score 0.0
      manualReviewRequired = true;
      evidenceItems.push({
        fhir_resource_id: resource.fhir_resource_id,
        fhir_resource_type: resource.fhir_resource_type,
        date: resource.date,
        authoring_provider: resource.authoring_provider,
        relevance_score: 0.0,
        extracted_entities: [],
        mapped_denial_reasons: [],
      });
      continue;
    }

    const relevanceScore = calculateRelevanceScore(entities, denialContext);
    const mappedReasons = mapEntitiesToDenialReasons(entities, denialContext.carc_codes);

    evidenceItems.push({
      fhir_resource_id: resource.fhir_resource_id,
      fhir_resource_type: resource.fhir_resource_type,
      date: resource.date,
      authoring_provider: resource.authoring_provider,
      relevance_score: relevanceScore,
      extracted_entities: entities,
      mapped_denial_reasons: mappedReasons,
    });
  }

  // Filter out evidence below relevance threshold
  const filtered = evidenceItems.filter(
    (item) => item.relevance_score >= RELEVANCE_THRESHOLD
  );

  // Sort by descending relevance score
  filtered.sort((a, b) => b.relevance_score - a.relevance_score);

  return {
    evidence_items: filtered,
    manual_review_required: manualReviewRequired,
  };
}
