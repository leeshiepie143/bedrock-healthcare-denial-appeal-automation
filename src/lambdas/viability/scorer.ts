/**
 * Viability Scoring Module
 *
 * Calculates appeal viability scores using a weighted scoring model.
 * The model coefficients are loaded from S3 (with a hardcoded fallback).
 *
 * Scoring algorithm:
 * 1. historical_overturn_rate — Direct value from outcome data (0.0-1.0)
 * 2. evidence_score — Average relevance score from EvidencePackage items (0.0-1.0)
 * 3. days_remaining_factor — Normalized: min(days_remaining / 60, 1.0). If <= 0, score is 0.0 immediately.
 * 4. claim_amount_factor — Normalized: min(claim_amount / 10000, 1.0)
 * 5. payer_overturn_rate — Payer-specific overturn rate from outcome data (0.0-1.0)
 * 6. Final score = sum(weight_i * factor_i), clamped to [0.0, 1.0]
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { EvidencePackage, Recommendation, RationaleFactor, RationaleImpact } from '@shared/models';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScoringModelWeights {
  historical_overturn_rate: number;
  evidence_score: number;
  days_remaining_factor: number;
  claim_amount_factor: number;
  payer_overturn_rate: number;
}

export interface ScoringModelThresholds {
  pursue: number;
  high_confidence: number;
}

export interface ScoringModel {
  weights: ScoringModelWeights;
  thresholds: ScoringModelThresholds;
  version: string;
  last_calibrated: string;
}

export interface ScoringInput {
  evidencePackage: EvidencePackage;
  denialReasonCode: string;
  payerId: string;
  claimAmount: number;
  appealDeadlineDate: string; // ISO 8601 date
  historicalOverturnRate: number; // 0.0-1.0
  payerOverturnRate: number; // 0.0-1.0
}

export interface ScoringResult {
  score: number; // 0.0-1.0
  recommendation: Recommendation;
  rationale: RationaleFactor[];
  topEvidenceItems: string[]; // FHIR resource IDs (up to 3 for "pursue")
  deadlineExpired: boolean;
  modelVersion: string;
}

// ─── Default Model (Fallback) ───────────────────────────────────────────────

export const DEFAULT_SCORING_MODEL: ScoringModel = {
  weights: {
    historical_overturn_rate: 0.30,
    evidence_score: 0.25,
    days_remaining_factor: 0.15,
    claim_amount_factor: 0.15,
    payer_overturn_rate: 0.15,
  },
  thresholds: {
    pursue: 0.3,
    high_confidence: 0.7,
  },
  version: '1.0.0',
  last_calibrated: '2024-01-01T00:00:00Z',
};

// ─── S3 Model Loading ───────────────────────────────────────────────────────

let cachedModel: ScoringModel | null = null;

/**
 * Loads the scoring model from S3. Falls back to the default model if loading fails.
 * Caches the model in memory for the Lambda execution lifetime.
 */
export async function loadScoringModel(s3Client?: S3Client): Promise<ScoringModel> {
  if (cachedModel) {
    return cachedModel;
  }

  const bucket = process.env.MODEL_BUCKET;
  const key = process.env.MODEL_KEY;

  if (!bucket || !key) {
    cachedModel = DEFAULT_SCORING_MODEL;
    return cachedModel;
  }

  try {
    const client = s3Client ?? new S3Client({});
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );

    const body = await response.Body?.transformToString();
    if (!body) {
      cachedModel = DEFAULT_SCORING_MODEL;
      return cachedModel;
    }

    const model = JSON.parse(body) as ScoringModel;

    // Validate model structure
    if (!model.weights || !model.thresholds || !model.version) {
      cachedModel = DEFAULT_SCORING_MODEL;
      return cachedModel;
    }

    cachedModel = model;
    return cachedModel;
  } catch {
    // S3 load failed — use default model
    cachedModel = DEFAULT_SCORING_MODEL;
    return cachedModel;
  }
}

/**
 * Clears the cached model. Useful for testing or forcing a reload.
 */
export function clearModelCache(): void {
  cachedModel = null;
}

// ─── Scoring Logic ──────────────────────────────────────────────────────────

/**
 * Calculates the number of calendar days remaining until the appeal deadline.
 * Returns a negative number if the deadline has passed.
 *
 * Both the deadline and current date are compared as UTC dates to avoid timezone issues.
 */
export function calculateDaysRemaining(appealDeadlineDate: string, currentDate?: Date): number {
  // Parse deadline as date components to avoid timezone interpretation issues
  const [year, month, day] = appealDeadlineDate.split('T')[0].split('-').map(Number);
  const deadlineUtc = Date.UTC(year, month - 1, day);

  const now = currentDate ?? new Date();
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const diffMs = deadlineUtc - nowUtc;
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Calculates the average evidence relevance score from an EvidencePackage.
 * Returns 0.0 if no evidence items exist.
 */
export function calculateEvidenceScore(evidencePackage: EvidencePackage): number {
  const items = evidencePackage.evidence_items;
  if (!items || items.length === 0) {
    return 0.0;
  }

  const sum = items.reduce((acc, item) => acc + item.relevance_score, 0);
  return sum / items.length;
}

/**
 * Pure scoring function that calculates the viability score and recommendation.
 *
 * @param input - All scoring inputs (evidence, rates, amounts, deadline)
 * @param model - The scoring model with weights and thresholds
 * @param currentDate - Optional current date for testing (defaults to now)
 * @returns ScoringResult with score, recommendation, rationale, and top evidence
 */
export function calculateViabilityScore(
  input: ScoringInput,
  model: ScoringModel,
  currentDate?: Date
): ScoringResult {
  const daysRemaining = calculateDaysRemaining(input.appealDeadlineDate, currentDate);

  // Handle expired deadlines immediately
  if (daysRemaining <= 0) {
    return {
      score: 0.0,
      recommendation: 'do_not_pursue',
      rationale: [
        {
          factor: 'Appeal deadline has expired',
          impact: 'negative' as RationaleImpact,
          weight: 1.0,
        },
        {
          factor: 'No days remaining for appeal submission',
          impact: 'negative' as RationaleImpact,
          weight: 1.0,
        },
      ],
      topEvidenceItems: [],
      deadlineExpired: true,
      modelVersion: model.version,
    };
  }

  // Calculate individual factors
  const historicalOverturnRate = clamp(input.historicalOverturnRate, 0.0, 1.0);
  const evidenceScore = clamp(calculateEvidenceScore(input.evidencePackage), 0.0, 1.0);
  const daysRemainingFactor = clamp(Math.min(daysRemaining / 60, 1.0), 0.0, 1.0);
  const claimAmountFactor = clamp(Math.min(input.claimAmount / 10000, 1.0), 0.0, 1.0);
  const payerOverturnRate = clamp(input.payerOverturnRate, 0.0, 1.0);

  // Calculate weighted score
  const rawScore =
    model.weights.historical_overturn_rate * historicalOverturnRate +
    model.weights.evidence_score * evidenceScore +
    model.weights.days_remaining_factor * daysRemainingFactor +
    model.weights.claim_amount_factor * claimAmountFactor +
    model.weights.payer_overturn_rate * payerOverturnRate;

  const score = clamp(rawScore, 0.0, 1.0);

  // Determine recommendation
  const recommendation: Recommendation = score >= model.thresholds.pursue ? 'pursue' : 'do_not_pursue';

  // Build rationale factors with their weighted contributions
  const factors: Array<{ factor: string; impact: RationaleImpact; weight: number; contribution: number }> = [
    {
      factor: 'Historical overturn rate for denial reason',
      impact: historicalOverturnRate >= 0.5 ? 'positive' : 'negative',
      weight: model.weights.historical_overturn_rate,
      contribution: model.weights.historical_overturn_rate * historicalOverturnRate,
    },
    {
      factor: 'Clinical evidence strength',
      impact: evidenceScore >= 0.5 ? 'positive' : 'negative',
      weight: model.weights.evidence_score,
      contribution: model.weights.evidence_score * evidenceScore,
    },
    {
      factor: 'Days remaining before deadline',
      impact: daysRemainingFactor >= 0.5 ? 'positive' : 'negative',
      weight: model.weights.days_remaining_factor,
      contribution: model.weights.days_remaining_factor * daysRemainingFactor,
    },
    {
      factor: 'Claim dollar amount',
      impact: claimAmountFactor >= 0.5 ? 'positive' : 'negative',
      weight: model.weights.claim_amount_factor,
      contribution: model.weights.claim_amount_factor * claimAmountFactor,
    },
    {
      factor: 'Payer-specific overturn rate',
      impact: payerOverturnRate >= 0.5 ? 'positive' : 'negative',
      weight: model.weights.payer_overturn_rate,
      contribution: model.weights.payer_overturn_rate * payerOverturnRate,
    },
  ];

  let rationale: RationaleFactor[];
  let topEvidenceItems: string[];

  if (recommendation === 'pursue') {
    // For "pursue": include all factors and identify top 3 evidence items
    rationale = factors.map(({ factor, impact, weight }) => ({ factor, impact, weight }));
    topEvidenceItems = getTopEvidenceItems(input.evidencePackage, 3);
  } else {
    // For "do not pursue": identify at least 2 factors with most negative impact
    // Sort by contribution ascending (lowest contribution = most negative impact)
    const sortedByContribution = [...factors].sort((a, b) => a.contribution - b.contribution);
    const negativeFactors = sortedByContribution
      .slice(0, Math.max(2, sortedByContribution.filter(f => f.impact === 'negative').length))
      .map(({ factor, impact, weight }) => ({ factor, impact: 'negative' as RationaleImpact, weight }));

    // Ensure at least 2 negative factors
    rationale = negativeFactors.length >= 2
      ? negativeFactors
      : sortedByContribution.slice(0, 2).map(({ factor, weight }) => ({
          factor,
          impact: 'negative' as RationaleImpact,
          weight,
        }));

    topEvidenceItems = [];
  }

  return {
    score,
    recommendation,
    rationale,
    topEvidenceItems,
    deadlineExpired: false,
    modelVersion: model.version,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Clamps a value between min and max (inclusive).
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Returns the FHIR resource IDs of the top N evidence items by relevance score.
 */
function getTopEvidenceItems(evidencePackage: EvidencePackage, count: number): string[] {
  const items = evidencePackage.evidence_items;
  if (!items || items.length === 0) {
    return [];
  }

  return [...items]
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, count)
    .map(item => item.fhir_resource_id);
}
